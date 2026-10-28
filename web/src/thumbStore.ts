// Thumbnails generated in the browser (sharp grid previews, and small ones
// for files uploaded without a stored thumbnail), saved on this device in
// IndexedDB so a refresh doesn't download every photo again.
//
// These are UNENCRYPTED copies of image content, kept only in this browser
// profile (the user opted in). Keyed by the file's content root hashes, so a
// rename keeps its thumbnail and changed content gets a new one. Never
// uploaded. Clearing the site's data removes them, as does clearSavedThumbs().

const DB_NAME = '0gdrive-thumbs'
const STORE = 'thumbs'
const MAX_ENTRIES = 2000 // ~60 KB per sharp preview → ~120 MB at most
const TOUCH_AFTER_MS = 24 * 60 * 60_000 // refresh usedAt at most daily

export type ThumbKind = 'sharp' | 'small'

interface Saved {
  key: string
  /** sharp previews are JPEG blobs; small ones data URLs */
  value: Blob | string
  usedAt: number
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function db(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'key' })
        store.createIndex('usedAt', 'usedAt')
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null) // private mode / blocked: session-only thumbnails
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

function done(req: IDBRequest | IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    if (req instanceof IDBTransaction) {
      req.oncomplete = () => resolve()
      req.onerror = req.onabort = () => reject(req.error)
    } else {
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    }
  })
}

export function thumbKey(kind: ThumbKind, rootHashes: string[]): string {
  return `${kind}:${rootHashes.join(',').toLowerCase()}`
}

export async function getSavedThumb(key: string): Promise<Blob | string | null> {
  const d = await db()
  if (!d) return null
  try {
    const tx = d.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    await done(req)
    const rec = req.result as Saved | undefined
    if (!rec) return null
    if (Date.now() - rec.usedAt > TOUCH_AFTER_MS) {
      const w = d.transaction(STORE, 'readwrite')
      w.objectStore(STORE).put({ ...rec, usedAt: Date.now() })
    }
    return rec.value
  } catch {
    return null
  }
}

let writes = 0
let saving = true

/**
 * Turn saving off (e.g. a drive opened read-only with its recovery
 * password, maybe on someone else's computer): thumbnails are plaintext,
 * so they then stay in memory only.
 */
export function setThumbSaving(on: boolean): void {
  saving = on
}

export async function saveThumb(key: string, value: Blob | string): Promise<void> {
  if (!saving) return
  const d = await db()
  if (!d) return
  try {
    const tx = d.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put({ key, value, usedAt: Date.now() } satisfies Saved)
    await done(tx)
    if (++writes % 50 === 1) await prune(d)
  } catch {
    // quota exceeded etc. — the thumbnail just stays session-only
  }
}

/** Drop the least recently used entries beyond MAX_ENTRIES. */
async function prune(d: IDBDatabase) {
  const countReq = d.transaction(STORE, 'readonly').objectStore(STORE).count()
  await done(countReq)
  let excess = countReq.result - MAX_ENTRIES
  if (excess <= 0) return
  excess += Math.round(MAX_ENTRIES / 10) // make room for a while
  const tx = d.transaction(STORE, 'readwrite')
  const cursorReq = tx.objectStore(STORE).index('usedAt').openCursor()
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result
    if (!cursor || excess-- <= 0) return
    cursor.delete()
    cursor.continue()
  }
  await done(tx)
}

export async function clearSavedThumbs(): Promise<void> {
  const d = await db()
  if (!d) return
  const tx = d.transaction(STORE, 'readwrite')
  tx.objectStore(STORE).clear()
  await done(tx)
}
