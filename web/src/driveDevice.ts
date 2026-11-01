// This device's memory of the drive's writes (core DriveDevice): a change's
// encrypted listings, saved just before the wallet is asked and dropped once
// stored, so a page closed between the transaction and the upload is
// finished on the next visit; and listings known never to have been
// uploaded, so loads skip them.
//
// The listings are kept exactly as stored on 0G: encrypted with the drive
// key. IndexedDB when available; without it (private mode) nothing is
// saved and an interrupted change is simply undone, as before.

import type { DriveDevice, PendingWrite } from '@0gdrive/core'

const DB_NAME = '0gdrive-pending'
const STORE = 'writes'
const MAX_ABANDONED = 500

interface Saved extends PendingWrite {
  key: string
  account: string
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function db(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: 'key' }).createIndex('account', 'account')
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = tx.onabort = () => reject(tx.error)
  })
}

async function savedFor(account: string): Promise<Saved[]> {
  const d = await db()
  if (!d) return []
  return new Promise((resolve, reject) => {
    const req = d.transaction(STORE).objectStore(STORE).index('account').getAll(account)
    req.onsuccess = () => resolve(req.result as Saved[])
    req.onerror = () => reject(req.error)
  })
}

export function driveDeviceFor(address: string): DriveDevice {
  const account = address.toLowerCase()
  const abandonedKey = `0gdrive:abandoned:${account}`
  const readAbandoned = (): string[] => {
    try {
      return JSON.parse(localStorage.getItem(abandonedKey) ?? '[]') as string[]
    } catch {
      return []
    }
  }
  let abandoned = new Set(readAbandoned())
  return {
    async savePending(writes) {
      const d = await db()
      if (!d) return
      const tx = d.transaction(STORE, 'readwrite')
      for (const w of writes) tx.objectStore(STORE).put({ ...w, key: `${account}:${w.change}:${w.order}`, account } satisfies Saved)
      await done(tx)
    },
    async pending() {
      return (await savedFor(account)).map(({ key: _key, account: _account, ...w }) => w)
    },
    async removePending(change) {
      const d = await db()
      if (!d) return
      const keys = (await savedFor(account)).filter((w) => w.change === change).map((w) => w.key)
      if (keys.length === 0) return
      const tx = d.transaction(STORE, 'readwrite')
      for (const k of keys) tx.objectStore(STORE).delete(k)
      await done(tx)
    },
    isAbandoned(rootHash) {
      return abandoned.has(rootHash.toLowerCase())
    },
    markAbandoned(rootHash) {
      abandoned = new Set([...readAbandoned(), rootHash.toLowerCase()].slice(-MAX_ABANDONED))
      try {
        localStorage.setItem(abandonedKey, JSON.stringify([...abandoned]))
      } catch {
        // storage unavailable: skipped for this visit only
      }
    },
  }
}
