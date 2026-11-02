// Search entries made on this device by the background indexer and not
// saved in the drive yet (core DriveStoreOpts.pendingSearch). Search uses
// them right away; they're saved with the next change the user approves
// anyway, or all at once from the sidebar ("Save").
//
// An entry holds a file's opening text and its embeddings, so it's kept
// ENCRYPTED: AES-GCM under a key derived from the drive key, which exists
// only while the drive is open. One record per account in IndexedDB;
// without IndexedDB (private mode) they live for the page only.

import type { DriveState, PendingSearchEntry } from '@0gdrive/core'

const DB_NAME = '0gdrive-search'
const STORE = 'pending'
const SAVE_AFTER_MS = 1000

let entries = new Map<string, PendingSearchEntry>()
let account: string | null = null
let key: CryptoKey | null = null
let saveTimer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()

let dbPromise: Promise<IDBDatabase | null> | null = null
function db(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

async function deriveKey(masterKey: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', masterKey as BufferSource, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('0gdrive pending search entries v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

const notify = () => listeners.forEach((l) => l())

/** The pending entries, by file id. */
export function pendingSearch(): ReadonlyMap<string, PendingSearchEntry> {
  return entries
}

export function subscribePendingSearch(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Load this account's pending entries (a drive opened). */
export async function openPendingSearch(address: string, masterKey: Uint8Array): Promise<void> {
  account = address.toLowerCase()
  entries = new Map()
  key = await deriveKey(masterKey)
  try {
    const d = await db()
    const rec = d ? await request<{ iv: Uint8Array; data: ArrayBuffer } | undefined>(d.transaction(STORE).objectStore(STORE).get(account)) : undefined
    if (rec && account === address.toLowerCase()) {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv as BufferSource }, key, rec.data)
      entries = new Map(JSON.parse(new TextDecoder().decode(plain)) as [string, PendingSearchEntry][])
    }
  } catch {
    entries = new Map() // unreadable (another key, damaged): indexed again
  }
  notify()
}

function scheduleSave(): void {
  clearTimeout(saveTimer)
  const forAccount = account
  const k = key
  saveTimer = setTimeout(async () => {
    if (!forAccount || !k || forAccount !== account) return
    try {
      const d = await db()
      if (!d) return
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(JSON.stringify([...entries])))
      const tx = d.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ iv, data }, forAccount)
    } catch {
      // best effort: the entries stay in memory for this visit
    }
  }, SAVE_AFTER_MS)
}

export function addPendingSearch(id: string, p: PendingSearchEntry): void {
  entries.set(id, p)
  scheduleSave()
  notify()
}

/**
 * Bring the entries in line with the drive as loaded: drop those saved
 * (the file has an entry now), those whose file is gone or renamed, and
 * follow files that moved to another folder.
 */
export function prunePendingSearch(drive: DriveState): void {
  if (entries.size === 0) return
  const where = new Map<string, { name: string; hasEntry: boolean; folder: string }>()
  for (const [path, folder] of drive.folders) {
    const id = path === '' ? '' : drive.tree.idOf(path)
    if (id === null) continue
    for (const f of folder?.files ?? []) where.set(f.id, { name: f.name, hasEntry: !!f.search, folder: id })
  }
  let changed = false
  for (const [id, p] of entries) {
    const now = where.get(id)
    if (!now || now.hasEntry || now.name !== p.name) {
      entries.delete(id)
      changed = true
    } else if (now.folder !== p.folder) {
      entries.set(id, { ...p, folder: now.folder })
      changed = true
    }
  }
  if (changed) {
    scheduleSave()
    notify()
  }
}
