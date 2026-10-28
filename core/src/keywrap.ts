import { bytesToHex, hexToBytes } from './keystore.js'

/**
 * Per-file content keys, wrapped under the drive master key.
 *
 * Files are encrypted with a random per-file AES-256 key (not the master
 * key directly) so a single file's key can be shared without exposing the
 * whole drive. The file key is wrapped with AES-GCM under the master key —
 * authenticated, so a wrong master key fails loudly (unlike the SDK's CTR
 * file encryption, which "decrypts" garbage on mismatch).
 *
 * Works in browser and Node 18+ (WebCrypto in both).
 */

const IV_LEN = 12

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as unknown as BufferSource, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ])
}

/** Generate a fresh 32-byte per-file key. */
export function generateFileKey(): Uint8Array {
  const k = new Uint8Array(32)
  crypto.getRandomValues(k)
  return k
}

/** Wrap a file key under the master key → hex string for FileMeta. */
export async function wrapFileKey(
  masterKey: Uint8Array,
  fileKey: Uint8Array
): Promise<string> {
  const iv = new Uint8Array(IV_LEN)
  crypto.getRandomValues(iv)
  const key = await importAesKey(masterKey)
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      fileKey as unknown as BufferSource
    )
  )
  const out = new Uint8Array(IV_LEN + ct.length)
  out.set(iv)
  out.set(ct, IV_LEN)
  return bytesToHex(out)
}

/** Unwrap a file key; throws on wrong master key (GCM tag check). */
export async function unwrapFileKey(
  masterKey: Uint8Array,
  wrappedHex: string
): Promise<Uint8Array> {
  const all = hexToBytes(wrappedHex)
  const iv = all.slice(0, IV_LEN)
  const ct = all.slice(IV_LEN)
  const key = await importAesKey(masterKey)
  try {
    const pt = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as unknown as BufferSource },
        key,
        ct as unknown as BufferSource
      )
    )
    if (pt.length !== 32) throw new Error('unexpected key length')
    return pt
  } catch {
    throw new Error('File key unwrap failed — wrong drive master key')
  }
}

// ─── Mode B: wallet-gated sharing (ECIES to recipient pubkey) ─────────
//
// Wraps a per-file key to a recipient's secp256k1 public key: ephemeral
// keypair → ECDH shared secret → HKDF-SHA256 → AES-GCM wrap. Decryption
// requires the recipient's RAW private key — available on the desktop/Node
// path or via an imported key; injected wallets (MetaMask) cannot decrypt.

import { secp256k1 } from '@noble/curves/secp256k1'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'

const SHAREWRAP_INFO = new TextEncoder().encode('0gdrive/sharewrap/v1')

function deriveWrapKey(sharedSecret: Uint8Array): Promise<CryptoKey> {
  const aesKey = hkdf(sha256, sharedSecret, undefined, SHAREWRAP_INFO, 32)
  return importAesKey(aesKey)
}

/**
 * Wrap a file key to a recipient's compressed public key.
 * Output hex: [ephemeralPub:33][iv:12][ciphertext+tag:48].
 */
export async function wrapFileKeyToPubKey(
  recipientPubKey: Uint8Array | string,
  fileKey: Uint8Array
): Promise<string> {
  const pub =
    typeof recipientPubKey === 'string'
      ? hexToBytes(recipientPubKey)
      : recipientPubKey
  const ephPriv = secp256k1.utils.randomPrivateKey()
  const ephPub = secp256k1.getPublicKey(ephPriv, true)
  const shared = secp256k1.getSharedSecret(ephPriv, pub)
  const aesKey = await deriveWrapKey(shared)

  const iv = new Uint8Array(IV_LEN)
  crypto.getRandomValues(iv)
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      aesKey,
      fileKey as unknown as BufferSource
    )
  )
  const out = new Uint8Array(33 + IV_LEN + ct.length)
  out.set(ephPub)
  out.set(iv, 33)
  out.set(ct, 33 + IV_LEN)
  return bytesToHex(out)
}

/**
 * Unwrap an ECIES-wrapped file key with the recipient's raw private key.
 * Throws on wrong key (GCM tag check).
 */
export async function unwrapFileKeyWithPrivateKey(
  privateKey: Uint8Array | string,
  wrappedHex: string
): Promise<Uint8Array> {
  const priv =
    typeof privateKey === 'string' ? hexToBytes(privateKey) : privateKey
  const all = hexToBytes(wrappedHex)
  const ephPub = all.slice(0, 33)
  const iv = all.slice(33, 33 + IV_LEN)
  const ct = all.slice(33 + IV_LEN)
  const shared = secp256k1.getSharedSecret(priv, ephPub)
  const aesKey = await deriveWrapKey(shared)
  try {
    const pt = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as unknown as BufferSource },
        aesKey,
        ct as unknown as BufferSource
      )
    )
    if (pt.length !== 32) throw new Error('unexpected key length')
    return pt
  } catch {
    throw new Error('Share key unwrap failed — wrong private key')
  }
}
