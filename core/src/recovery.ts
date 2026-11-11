import { ethers } from 'ethers'
import { hexToBytes, bytesToHex } from './keystore.js'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { deriveShareKey, getCachedShareKey, cacheShareKey, type ShareKeyPair } from './sharekey.js'

/**
 * Drive-key recovery (Option C).
 *
 * The drive master key M is wrapped under:
 *   S — derived from a fixed wallet signature (HKDF-SHA256)   [primary]
 *   P — derived from a user-chosen password (PBKDF2)          [optional]
 * and the wrapped blobs are kept in the drive's public account card
 * (v2account.ts). Anyone can read them; only the signature (or password)
 * can unwrap them.
 *
 * Recovery paths for M, in order: browser localStorage →
 * signature → password → exported key file.
 */

// The signature message is load-bearing: it must stay byte-identical
// forever (v1 marker), because S is derived from its signature.
export const RECOVERY_SIGN_MESSAGE =
  '0GDrive: drive key recovery v1.\nThis signature derives the key that unlocks your drive backup. It grants no permissions and sends nothing on-chain.'

const RECOVERY_INFO = new TextEncoder().encode('0gdrive/recovery/v1')
const PASSWORD_INFO = new TextEncoder().encode('0gdrive/password/v1')

const PBKDF2_ITERATIONS = 600_000

/** Derive the recovery wrapping key S from a wallet signature. */
export function deriveRecoveryKey(signature: string): Uint8Array {
  return hkdf(sha256, ethers.getBytes(signature), undefined, RECOVERY_INFO, 32)
}

/**
 * The wallet can't back signature-based recovery: its signature isn't a
 * plain signature by the account's key (smart-contract or passkey
 * accounts), or signing twice gave different results (some MPC or
 * embedded wallets). Either way S would not be reproducible.
 */
export class UnstableSignatureError extends Error {
  constructor(reason: 'not-ecdsa' | 'changed', setup: boolean) {
    super(
      (reason === 'changed'
        ? 'Your wallet gave a different signature when asked to sign the same message twice'
        : 'Your wallet’s signature isn’t a standard signature by your address') +
        (setup
          ? ', so it couldn’t restore your drive on another device. Your drive was not created. ' +
            'Create it with a different wallet (a browser extension such as MetaMask or Rabby, or a hardware wallet).'
          : ', so it can’t unlock your drive backup or sharing key. Use the wallet you set the drive up with.')
    )
    this.name = 'UnstableSignatureError'
  }
}

/**
 * Sign the recovery message once and derive both keys from it: the
 * recovery wrapping key S and the sharing keypair. The sharing key is
 * cached on this device so opening a share later needs no signature.
 *
 * Every signature must recover to `address`. When `checkStable` is set
 * (first setup, before anything is published) the message is signed a
 * second time and must match — one extra prompt, once per drive.
 */
export async function signForKeys(
  signer: { signMessage(message: string): Promise<string> },
  address: string,
  checkStable = false
): Promise<{ recoveryKey: Uint8Array; shareKey: ShareKeyPair }> {
  const sig = await signer.signMessage(RECOVERY_SIGN_MESSAGE)
  let signedBy: string | null = null
  try {
    signedBy = ethers.verifyMessage(RECOVERY_SIGN_MESSAGE, sig)
  } catch {
    // not a 65-byte ECDSA signature
  }
  if (signedBy?.toLowerCase() !== address.toLowerCase()) throw new UnstableSignatureError('not-ecdsa', checkStable)
  if (checkStable && (await signer.signMessage(RECOVERY_SIGN_MESSAGE)).toLowerCase() !== sig.toLowerCase()) {
    throw new UnstableSignatureError('changed', true)
  }
  const shareKey = deriveShareKey(sig)
  cacheShareKey(address, shareKey)
  return { recoveryKey: deriveRecoveryKey(sig), shareKey }
}

/**
 * The account's sharing keypair, for opening a share sent to it: from this
 * device's cache, else by signing the recovery message (one prompt).
 */
export async function unlockShareKey(
  signer: { signMessage(message: string): Promise<string> },
  address: string
): Promise<ShareKeyPair> {
  return getCachedShareKey(address) ?? (await signForKeys(signer, address)).shareKey
}

/** Derive the password wrapping key P. */
export async function derivePasswordKey(
  password: string,
  salt: Uint8Array
): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password) as unknown as BufferSource,
    'PBKDF2',
    false,
    ['deriveBits']
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    material,
    256
  )
  return new Uint8Array(bits)
}

/** Wrap `plain` (the master key) under `wrapKey` (S or P) — AES-GCM. */
export async function gcmWrap(
  wrapKey: Uint8Array,
  plain: Uint8Array
): Promise<string> {
  const iv = new Uint8Array(12)
  crypto.getRandomValues(iv)
  const ck = await crypto.subtle.importKey(
    'raw',
    wrapKey as unknown as BufferSource,
    'AES-GCM',
    false,
    ['encrypt']
  )
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      ck,
      plain as unknown as BufferSource
    )
  )
  const out = new Uint8Array(12 + ct.length)
  out.set(iv)
  out.set(ct, 12)
  return bytesToHex(out)
}

/** Unwrap a blob produced by gcmWrap with the matching wrap key. */
export async function gcmUnwrap(
  wrappedHex: string,
  wrapKey: Uint8Array
): Promise<Uint8Array> {
  const all = hexToBytes(wrappedHex)
  const iv = all.slice(0, 12)
  const ct = all.slice(12)
  const ck = await crypto.subtle.importKey(
    'raw',
    wrapKey as unknown as BufferSource,
    'AES-GCM',
    false,
    ['decrypt']
  )
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as unknown as BufferSource },
        ck,
        ct as unknown as BufferSource
      )
    )
  } catch {
    throw new Error('drive key unwrap failed — wrong recovery key')
  }
}
