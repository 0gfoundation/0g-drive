/**
 * Drive master key custody (browser).
 *
 * MetaMask-style injected wallets never expose the raw private key, so
 * ECIES-to-self decryption (which needs the raw key) is impossible in the
 * web shell. 0GDrive therefore generates a random AES-256 master key per
 * account, stores it in localStorage for convenience, and requires the
 * user to back it up — losing it means losing access to encrypted files
 * (the ciphertext stays on the network, permanently unreadable).
 *
 * Desktop/mobile shells and Node scripts with a raw key can use the ECIES
 * path instead (see wallet.ts / storage.ts).
 */

const KEY_PREFIX = '0gdrive:masterkey:'

function lsKey(address: string): string {
  return KEY_PREFIX + address.toLowerCase()
}

function safeGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function safeSet(key: string, value: string): boolean {
  try {
    globalThis.localStorage?.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export function hasMasterKey(address: string): boolean {
  const hex = safeGet(lsKey(address))
  return hex !== null && /^0x[0-9a-fA-F]{64}$/.test(hex)
}

/** Returns the stored master key, or null if none / invalid. */
export function getMasterKey(address: string): Uint8Array | null {
  const hex = safeGet(lsKey(address))
  if (hex === null || !/^0x[0-9a-fA-F]{64}$/.test(hex)) return null
  return hexToBytes(hex)
}

export function getMasterKeyHex(address: string): string | null {
  const hex = safeGet(lsKey(address))
  return hex !== null && /^0x[0-9a-fA-F]{64}$/.test(hex) ? hex : null
}

/** Generate a fresh master key and store it. Returns the key bytes. */
export function createMasterKey(address: string): Uint8Array {
  const key = new Uint8Array(32)
  crypto.getRandomValues(key)
  const hex = bytesToHex(key)
  if (!safeSet(lsKey(address), hex)) {
    throw new Error('Failed to persist master key to localStorage')
  }
  return key
}

/** Import a backed-up master key (0x-prefixed 64 hex chars). */
export function importMasterKey(address: string, hex: string): Uint8Array {
  const normalized = hex.trim().toLowerCase()
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error('Invalid master key: expected 0x + 64 hex characters')
  }
  if (!safeSet(lsKey(address), normalized)) {
    throw new Error('Failed to persist master key to localStorage')
  }
  return hexToBytes(normalized)
}

export function hexToBytes(hex: string): Uint8Array {
  const s = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) {
    throw new Error(`Invalid hex string: "${hex}"`)
  }
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.substr(i * 2, 2), 16)
  }
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  return (
    '0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
  )
}
