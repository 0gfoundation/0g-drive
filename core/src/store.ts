import type { FileMeta } from './types.js'

/**
 * M1 local file index: per-address list in localStorage.
 * This is a placeholder for the M2 0G-KV metadata stream — the record
 * shape (FileMeta) is what the KV layer will persist instead.
 */

const PREFIX = '0gdrive:files:'

function lsKey(address: string): string {
  return PREFIX + address.toLowerCase()
}

export function listFiles(address: string): FileMeta[] {
  try {
    const raw = globalThis.localStorage?.getItem(lsKey(address))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as FileMeta[]) : []
  } catch {
    return []
  }
}

export function addFile(address: string, meta: FileMeta): FileMeta[] {
  const files = listFiles(address)
  files.unshift(meta)
  persist(address, files)
  return files
}

export function removeFile(address: string, id: string): FileMeta[] {
  const files = listFiles(address).filter((f) => f.id !== id)
  persist(address, files)
  return files
}

function persist(address: string, files: FileMeta[]): void {
  globalThis.localStorage?.setItem(lsKey(address), JSON.stringify(files))
}

export function newFileId(): string {
  return (
    'f_' +
    Date.now().toString(36) +
    '_' +
    Math.random().toString(36).slice(2, 10)
  )
}
