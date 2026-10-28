// Downloaded files, kept on this device so opening a preview again (or
// making a thumbnail, or indexing) doesn't download it from 0G Storage
// again.
//
// Stores the file's bytes exactly as stored on 0G Storage, i.e. still
// ENCRYPTED for encrypted files: they're decrypted after every read, with
// keys that only exist while the drive is open. Keyed by content root hash
// (ciphertext is content-addressed, so an entry never goes stale).
// LRU-capped by total size. Clearing the site's data removes it.

const DB_NAME = '0gdrive-files'
const STORE = 'files'
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024 // 1 GB
export const FILE_CACHE_MAX_BYTES = 100 * 1024 * 1024 // per file
const TOUCH_AFTER_MS = 60 * 60_000

interface Cached {
  key: string
  data: Blob
  size: number
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
      req.onerror = () => resolve(null) // private mode / blocked: no cache
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

const loading = new Map<string, Promise<Uint8Array>>()

/**
 * The cached bytes for `key`, else `download()` them and cache the result.
 * Concurrent calls for the same file share one download.
 */
export function cachedOrDownload(key: string, download: () => Promise<Uint8Array>): Promise<Uint8Array> {
  const running = loading.get(key)
  if (running) return running
  const p = (async () => {
    const hit = await getCachedFile(key)
    if (hit) return hit
    const raw = await download()
    void cacheFile(key, raw)
    return raw
  })().finally(() => loading.delete(key))
  loading.set(key, p)
  return p
}

export function fileCacheKey(rootHashes: string[]): string {
  return rootHashes.join(',').toLowerCase()
}

export async function getCachedFile(key: string): Promise<Uint8Array | null> {
  const d = await db()
  if (!d) return null
  try {
    const req = d.transaction(STORE, 'readonly').objectStore(STORE).get(key)
    await done(req)
    const rec = req.result as Cached | undefined
    if (!rec) return null
    if (Date.now() - rec.usedAt > TOUCH_AFTER_MS) {
      d.transaction(STORE, 'readwrite').objectStore(STORE).put({ ...rec, usedAt: Date.now() })
    }
    return new Uint8Array(await rec.data.arrayBuffer())
  } catch {
    return null
  }
}

export async function cacheFile(key: string, data: Uint8Array): Promise<void> {
  if (data.length > FILE_CACHE_MAX_BYTES) return
  // copy now, before the caller goes on to use (e.g. decrypt) the buffer
  const blob = new Blob([data as unknown as BlobPart])
  const d = await db()
  if (!d) return
  try {
    const tx = d.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put({
      key,
      data: blob,
      size: blob.size,
      usedAt: Date.now(),
    } satisfies Cached)
    await done(tx)
    await prune(d)
  } catch {
    // quota exceeded etc. — the next read just downloads again
  }
}

/** Drop least recently used files until the total is under budget. */
async function prune(d: IDBDatabase) {
  const tx = d.transaction(STORE, 'readwrite')
  const index = tx.objectStore(STORE).index('usedAt')
  // newest first: keep entries while they fit, delete the rest
  const req = index.openCursor(null, 'prev')
  let kept = 0
  req.onsuccess = () => {
    const cursor = req.result
    if (!cursor) return
    const rec = cursor.value as Cached
    kept += rec.size
    if (kept > MAX_TOTAL_BYTES) cursor.delete()
    cursor.continue()
  }
  await done(tx)
}
