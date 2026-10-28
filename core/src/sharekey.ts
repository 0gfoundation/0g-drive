import { ethers } from 'ethers'
import { secp256k1 } from '@noble/curves/secp256k1'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from './keystore.js'

/**
 * Derived sharing key (Mode B).
 *
 * Injected wallets never reveal their private key, so files can't be
 * key-wrapped to the wallet's own key and opened in a browser. Instead
 * each account has a dedicated secp256k1 keypair derived from the drive
 * recovery signature (see recovery.ts) with HKDF under its own label —
 * independent of the recovery key S derived from the same signature.
 * Its public key is published in the backup manifest (`shareKey`); a
 * recipient re-derives the private key by signing the same message again.
 *
 * Wallets sign deterministically (RFC 6979), so the same message always
 * gives the same signature and therefore the same keypair.
 */

const SHAREKEY_INFO = '0gdrive/sharekey/v1'

export interface ShareKeyPair {
  privateKey: Uint8Array
  /** Compressed public key (0x + 66 hex chars). */
  pubKey: string
}

/** Derive the sharing keypair from the recovery signature. */
export function deriveShareKey(signature: string): ShareKeyPair {
  const ikm = ethers.getBytes(signature)
  // a 32-byte HKDF output is a valid scalar with overwhelming probability;
  // the counter only covers the ~2^-128 case
  for (let i = 0; ; i++) {
    const info = new TextEncoder().encode(i === 0 ? SHAREKEY_INFO : `${SHAREKEY_INFO}/${i}`)
    const sk = hkdf(sha256, ikm, undefined, info, 32)
    if (secp256k1.utils.isValidPrivateKey(sk)) {
      return { privateKey: sk, pubKey: bytesToHex(secp256k1.getPublicKey(sk, true)) }
    }
  }
}

const CACHE_PREFIX = '0gdrive:sharekey:'

/**
 * The sharing private key cached on this device (next to the drive master
 * key, which it is no more sensitive than), or null.
 */
export function getCachedShareKey(address: string): ShareKeyPair | null {
  try {
    const hex = globalThis.localStorage?.getItem(CACHE_PREFIX + address.toLowerCase())
    if (!hex || !/^0x[0-9a-fA-F]{64}$/.test(hex)) return null
    const privateKey = hexToBytes(hex)
    return { privateKey, pubKey: bytesToHex(secp256k1.getPublicKey(privateKey, true)) }
  } catch {
    return null
  }
}

export function cacheShareKey(address: string, key: ShareKeyPair): void {
  try {
    globalThis.localStorage?.setItem(CACHE_PREFIX + address.toLowerCase(), bytesToHex(key.privateKey))
  } catch {
    // best-effort: the next open just asks for the signature again
  }
}
