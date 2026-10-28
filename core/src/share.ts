import type { NetworkConfig } from './config.js'
import { downloadFile } from './storage.js'
import type { ProgressFn } from './types.js'

/**
 * Secret-link sharing: a share URL carries the file's per-file key in the
 * URL fragment (#s=…), which never leaves the client. Anyone with the link
 * can download and decrypt the file — no wallet, no drive key required on
 * the recipient side. The file key is scoped to one file, so the link
 * grants access to that file only.
 */

export interface SharePayload {
  v: 1
  /** file name */
  n: string
  /** mime type */
  m: string
  /** original size in bytes */
  z: number
  /** file root hashes (fragment order) */
  r: string[]
  /** storage txSeqs, parallel to r (by-txSeq fallback) */
  q: number[]
  /** per-file AES-256 key, hex */
  k: string
}

const B64URL_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function bytesToB64Url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    out += B64URL_CHARS[b0 >> 2]
    out += B64URL_CHARS[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)]
    if (b1 === undefined) break
    out += B64URL_CHARS[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)]
    if (b2 === undefined) break
    out += B64URL_CHARS[b2 & 63]
  }
  return out
}

function b64UrlToBytes(s: string): Uint8Array {
  const bytes: number[] = []
  for (let i = 0; i < s.length; i += 4) {
    const c = (j: number) => B64URL_CHARS.indexOf(s[i + j])
    const b0 = (c(0) << 2) | (c(1) >> 4)
    bytes.push(b0)
    if (i + 2 < s.length && s[i + 2] !== '=') {
      bytes.push(((c(1) & 15) << 4) | (c(2) >> 2))
    }
    if (i + 3 < s.length && s[i + 3] !== '=') {
      bytes.push(((c(2) & 3) << 6) | c(3))
    }
  }
  return new Uint8Array(bytes)
}

/** Build the share fragment for a file (append to any app URL). */
export function buildShareLink(p: SharePayload): string {
  return '#s=' + bytesToB64Url(new TextEncoder().encode(JSON.stringify(p)))
}

/**
 * Mode B — wallet-gated share: the file key is ECIES-wrapped to the
 * recipient's published public key (see keywrap.ts). The link is useless
 * to anyone else. Normally that is their derived sharing key (`d: 1`,
 * sharekey.ts), unlocked with a wallet signature; legacy links are wrapped
 * to the wallet's own key and need the raw private key.
 */
export interface EncryptedSharePayload {
  v: 1
  n: string
  m: string
  z: number
  r: string[]
  q: number[]
  /** ECIES-wrapped file key, hex (see wrapFileKeyToPubKey). */
  w: string
  /** Recipient address, for identification in the UI. */
  to: string
  /** 1: wrapped to the recipient's derived sharing key; absent: legacy. */
  d?: 1
  /** The public key it was wrapped to (to tell a wrong key from a bad link). */
  p?: string
}

/** Build the encrypted-share fragment for a file. */
export function buildEncryptedShareLink(p: EncryptedSharePayload): string {
  return '#e=' + bytesToB64Url(new TextEncoder().encode(JSON.stringify(p)))
}

/** Parse a share fragment — either mode — or null. */
export function parseShareLink(
  hash: string
): { mode: 'link'; payload: SharePayload } | { mode: 'encrypted'; payload: EncryptedSharePayload } | null {
  if (hash.startsWith('#s=')) {
    try {
      const p = JSON.parse(new TextDecoder().decode(b64UrlToBytes(hash.slice(3))))
      if (p?.v !== 1 || !Array.isArray(p.r) || typeof p.k !== 'string') {
        return null
      }
      return { mode: 'link', payload: p }
    } catch {
      return null
    }
  }
  if (hash.startsWith('#e=')) {
    try {
      const p = JSON.parse(new TextDecoder().decode(b64UrlToBytes(hash.slice(3))))
      if (p?.v !== 1 || !Array.isArray(p.r) || typeof p.w !== 'string') {
        return null
      }
      return { mode: 'encrypted', payload: p }
    } catch {
      return null
    }
  }
  return null
}

/** Download + decrypt an encrypted share, unwrapping with the raw private key. */
export async function downloadEncryptedShare(
  p: EncryptedSharePayload,
  network: NetworkConfig,
  privateKey: Uint8Array | string,
  onProgress?: ProgressFn
): Promise<{ data: Uint8Array; decrypted: boolean }> {
  const { unwrapFileKeyWithPrivateKey } = await import('./keywrap.js')
  const fileKey = await unwrapFileKeyWithPrivateKey(privateKey, p.w)
  return downloadFile(p.r, network, {
    decryption: { symmetricKey: fileKey },
    txSeqs: p.q,
    onProgress,
  })
}

/**
 * Download + decrypt a shared file with only the share payload (no drive
 * key, no wallet).
 */
export async function downloadSharedFile(
  p: SharePayload,
  network: NetworkConfig,
  onProgress?: ProgressFn
): Promise<{ data: Uint8Array; decrypted: boolean }> {
  return downloadFile(p.r, network, {
    decryption: { symmetricKey: p.k },
    txSeqs: p.q,
    onProgress,
  })
}
