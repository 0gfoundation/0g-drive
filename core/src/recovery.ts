import { ethers } from 'ethers'
import type { NetworkConfig } from './config.js'
import { uploadData, downloadFile } from './storage.js'
import { scanUploadsCached, type EventCache } from './events.js'
import { findManifestEvents, MANIFEST_DOMAIN } from './manifest.js'
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
 * and the wrapped blobs are stored on-chain as a tagged backup
 * manifest (tag purpose 0x04). Anyone can download the blob;
 * only the signature (or password) can unwrap it.
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

export interface DriveKeyBackup {
  v: 1
  address: string
  /** M wrapped under S — hex (always present). */
  wrappedUnderSignature: string
  /** M wrapped under P — hex (present only when a password is set). */
  wrappedUnderPassword?: string
  /** PBKDF2 salt — hex (present with wrappedUnderPassword). */
  passwordSalt?: string
  /**
   * Public half of the derived sharing key (see sharekey.ts) — this backup
   * manifest doubles as the owner's sharing profile (Mode B), so one
   * signature and one tx covers both setup actions.
   */
  shareKey?: string
  /**
   * Legacy: the wallet's own public key, published by older versions.
   * Shares wrapped to it can only be opened with the raw private key.
   */
  pubKey?: string
  updatedAt: number
}

/** Derive the recovery wrapping key S from a wallet signature. */
export function deriveRecoveryKey(signature: string): Uint8Array {
  return hkdf(sha256, ethers.getBytes(signature), undefined, RECOVERY_INFO, 32)
}

/** Sign the recovery message and derive S. Works with injected wallets. */
export async function signForRecovery(signer: {
  signMessage(message: string): Promise<string>
}): Promise<Uint8Array> {
  const sig = await signer.signMessage(RECOVERY_SIGN_MESSAGE)
  return deriveRecoveryKey(sig)
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
          ? ', so it couldn’t unlock a drive backup later. Recovery was not turned on. ' +
            'Export the key file to keep your drive safe, or set up recovery with a different wallet ' +
            '(a browser extension such as MetaMask or Rabby, or a hardware wallet).'
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
async function signForKeys(
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
 * One-transaction drive setup: the recovery signature does
 * double duty — HKDF derives the recovery wrapping key S and the sharing
 * keypair (Mode B). The published backup manifest carries S's wrap of the
 * master key and the sharing public key, so enabling recovery and
 * publishing the share key cost a single tx. The message is signed twice
 * to check the wallet signs deterministically (see signForKeys).
 */
export async function setupDriveSecurity(
  network: NetworkConfig,
  signer: ethers.Signer,
  address: string,
  masterKey: Uint8Array
): Promise<{ rootHash: string; txHash: string; shareKey: string }> {
  const { recoveryKey, shareKey } = await signForKeys(signer, address, true)
  const result = await publishDriveKeyBackup(network, signer, address, masterKey, recoveryKey, {
    shareKey: shareKey.pubKey,
  })
  return { ...result, shareKey: shareKey.pubKey }
}

/**
 * Add the sharing key to an existing backup (accounts set up before
 * derived sharing keys existed). Keeps the password wrap, if any.
 * Two signatures (the stability check), one tx.
 */
export async function enableShareKey(
  network: NetworkConfig,
  signer: ethers.Signer,
  address: string,
  masterKey: Uint8Array,
  cache?: EventCache
): Promise<{ rootHash: string; txHash: string; shareKey: string }> {
  const previous = await downloadBackup(address, network, cache)
  const { recoveryKey, shareKey } = await signForKeys(signer, address, true)
  const result = await publishDriveKeyBackup(network, signer, address, masterKey, recoveryKey, {
    shareKey: shareKey.pubKey,
    previous,
  })
  return { ...result, shareKey: shareKey.pubKey }
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

export function backupTag(): string {
  // MANIFEST_DOMAIN + purpose 0x04 + 32 zero bytes
  return MANIFEST_DOMAIN + '04' + '00'.repeat(32)
}

/** Wrap `plain` (the master key) under `wrapKey` (S or P) — AES-GCM. */
async function gcmWrap(
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
async function gcmUnwrap(
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

/**
 * Publish (or re-publish) the on-chain backup manifest: M wrapped under S,
 * optionally under a new password, and the sharing public key. One small tx.
 */
export async function publishDriveKeyBackup(
  network: NetworkConfig,
  signer: ethers.Signer,
  address: string,
  masterKey: Uint8Array,
  recoveryKey: Uint8Array,
  opts: {
    password?: string
    shareKey?: string
    /** the backup being replaced: its password wrap is carried over */
    previous?: DriveKeyBackup | null
  } = {}
): Promise<{ rootHash: string; txHash: string }> {
  const { password, shareKey, previous } = opts
  const backup: DriveKeyBackup = {
    v: 1,
    address: address.toLowerCase(),
    wrappedUnderSignature: await gcmWrap(recoveryKey, masterKey),
    updatedAt: Date.now(),
  }
  if (shareKey) backup.shareKey = shareKey
  if (!password && previous?.wrappedUnderPassword && previous.passwordSalt) {
    backup.wrappedUnderPassword = previous.wrappedUnderPassword
    backup.passwordSalt = previous.passwordSalt
  }
  if (password) {
    const salt = new Uint8Array(16)
    crypto.getRandomValues(salt)
    backup.wrappedUnderPassword = await gcmWrap(
      await derivePasswordKey(password, salt),
      masterKey
    )
    backup.passwordSalt = bytesToHex(salt)
  }
  const result = await uploadData(
    new TextEncoder().encode(JSON.stringify(backup)),
    network,
    signer,
    { tags: backupTag(), finalityRequired: false }
  )
  return { rootHash: result.rootHash, txHash: result.txHash }
}

/** Latest backup event for an address, or null. */
export async function findDriveKeyBackup(
  address: string,
  network: NetworkConfig,
  cache?: EventCache
): Promise<{ event: ReturnType<typeof findManifestEvents>[number] } | null> {
  const { events } = await scanUploadsCached(address, network, cache)
  const expected = backupTag().slice(2).toLowerCase()
  const candidates = events.filter(
    (e) => e.tags.toLowerCase().slice(2) === expected
  )
  if (candidates.length === 0) return null
  const latest = candidates.reduce((a, b) =>
    b.blockNumber >= a.blockNumber ? b : a
  )
  return { event: latest }
}

async function downloadBackup(
  address: string,
  network: NetworkConfig,
  cache?: EventCache
): Promise<DriveKeyBackup | null> {
  const found = await findDriveKeyBackup(address, network, cache)
  if (!found) return null
  try {
    const { data } = await downloadFile([found.event.rootHash], network, {
      txSeqs: [found.event.txSeq],
    })
    const backup = JSON.parse(new TextDecoder().decode(data)) as DriveKeyBackup
    if (backup.v !== 1 || typeof backup.wrappedUnderSignature !== 'string') {
      return null
    }
    return backup
  } catch {
    return null
  }
}

/** The account's latest on-chain backup (public, encrypted parts), or null. */
export function getDriveKeyBackup(
  address: string,
  network: NetworkConfig,
  cache?: EventCache
): Promise<DriveKeyBackup | null> {
  return downloadBackup(address, network, cache)
}

/** Does this account have an on-chain drive backup? (read-only) */
export async function hasDriveKeyBackup(
  address: string,
  network: NetworkConfig,
  cache?: EventCache
): Promise<boolean> {
  return (await findDriveKeyBackup(address, network, cache)) !== null
}

/** Restore M via a wallet signature (the primary recovery path). */
export async function restoreDriveKeyBySignature(
  address: string,
  network: NetworkConfig,
  signer: { signMessage(message: string): Promise<string> },
  cache?: EventCache
): Promise<{ masterKey: Uint8Array; backup: DriveKeyBackup } | null> {
  const backup = await downloadBackup(address, network, cache)
  if (!backup) return null
  // also caches the sharing key, so opening shares needs no extra prompt
  const { recoveryKey } = await signForKeys(signer, address)
  const masterKey = await gcmUnwrap(backup.wrappedUnderSignature, recoveryKey)
  return { masterKey, backup }
}

/** Restore M via password (the wallet-loss fallback). */
export async function restoreDriveKeyByPassword(
  address: string,
  network: NetworkConfig,
  password: string,
  cache?: EventCache
): Promise<{ masterKey: Uint8Array; backup: DriveKeyBackup } | null> {
  const backup = await downloadBackup(address, network, cache)
  if (!backup?.wrappedUnderPassword || !backup.passwordSalt) return null
  const passwordKey = await derivePasswordKey(
    password,
    hexToBytes(backup.passwordSalt)
  )
  const masterKey = await gcmUnwrap(backup.wrappedUnderPassword, passwordKey)
  return { masterKey, backup }
}

/** Unwrap M from an already-downloaded backup with its password. Throws on a wrong password. */
export async function unlockBackupWithPassword(
  backup: DriveKeyBackup,
  password: string
): Promise<Uint8Array> {
  if (!backup.wrappedUnderPassword || !backup.passwordSalt) {
    throw new Error('this backup has no recovery password')
  }
  const passwordKey = await derivePasswordKey(password, hexToBytes(backup.passwordSalt))
  return gcmUnwrap(backup.wrappedUnderPassword, passwordKey)
}

/** Set or change the recovery password (re-publishes the backup). */
export async function setRecoveryPassword(
  network: NetworkConfig,
  signer: ethers.Signer,
  address: string,
  masterKey: Uint8Array,
  password: string
): Promise<{ rootHash: string; txHash: string }> {
  // the re-published backup must keep publishing the sharing key
  const { recoveryKey, shareKey } = await signForKeys(signer, address)
  return publishDriveKeyBackup(network, signer, address, masterKey, recoveryKey, {
    password,
    shareKey: shareKey.pubKey,
  })
}
