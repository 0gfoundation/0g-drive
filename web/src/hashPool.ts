// Upload hashing on several CPU cores: segment ranges (core uploadBatch's
// SegmentHasher jobs) go to a few web workers, so a big file or several
// files hash in parallel and the page stays responsive. Workers start when
// the drive opens (prestartHashWorkers) — starting them on the first upload
// cost a user 1.8–5.1 s before the wallet prompt — and stay for the
// session; without worker support the hashing runs on this thread, as in
// core. (Small files never come here: core hashes them itself.)

import type { HashedRange, SegmentHasher } from '@0gdrive/core'
import { hashSegments, type StreamSource } from '@0gdrive/core/merkle'

const POOL_SIZE = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1))

interface Pending {
  resolve: (r: HashedRange) => void
  reject: (err: Error) => void
  /** when it was handed to the pool: what's not reading or hashing is waiting */
  at: number
}

interface Job {
  id: number
  src: StreamSource
  from: number
  to: number
}

let workers: Worker[] | null = null
const idle: Worker[] = []
const busy = new Map<Worker, Job>()
const queue: Job[] = []
const pending = new Map<number, Pending>()
let nextId = 0

function start(): Worker[] | null {
  if (workers) return workers
  try {
    workers = Array.from({ length: POOL_SIZE }, () => {
      const w = new Worker(new URL('./hash.worker.ts', import.meta.url), { type: 'module' })
      w.onmessage = (e: MessageEvent<{ id: number; roots?: Uint8Array; readMs?: number; hashMs?: number; error?: string }>) => {
        busy.delete(w)
        const p = pending.get(e.data.id)
        pending.delete(e.data.id)
        if (e.data.roots && p) {
          const readMs = e.data.readMs ?? 0
          const hashMs = e.data.hashMs ?? 0
          p.resolve({ roots: e.data.roots, readMs, hashMs, waitMs: Math.max(0, performance.now() - p.at - readMs - hashMs) })
        }
        else p?.reject(new Error(e.data.error ?? 'hashing failed'))
        idle.push(w)
        pump()
      }
      // a worker that can't run (failed to load, crashed): drop it, and
      // hash its job here instead
      w.onerror = () => {
        const job = busy.get(w)
        busy.delete(w)
        workers = workers!.filter((x) => x !== w)
        w.terminate()
        if (job) runHere(job)
        if (workers.length === 0) queue.splice(0).forEach(runHere)
      }
      return w
    })
    idle.push(...workers)
  } catch {
    workers = null
  }
  return workers
}

function runHere(job: Job): void {
  const p = pending.get(job.id)
  pending.delete(job.id)
  hashHere(job.src, job.from, job.to).then(p?.resolve, p?.reject)
}

const hashHere: SegmentHasher = async (src, from, to) => {
  const stats = { readMs: 0, hashMs: 0 }
  return { roots: await hashSegments(src, from, to, stats), ...stats }
}

function pump(): void {
  while (idle.length && queue.length) {
    const w = idle.shift()!
    if (!workers?.includes(w)) continue
    const job = queue.shift()!
    busy.set(w, job)
    w.postMessage(job)
  }
}

/** Start the workers now, while the user looks at their drive. */
export function prestartHashWorkers(): void {
  start()
}

export const hashInWorkers: SegmentHasher = (src, from, to) => {
  if (!start()?.length) return hashHere(src, from, to)
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject, at: performance.now() })
    queue.push({ id, src, from, to })
    pump()
  })
}
