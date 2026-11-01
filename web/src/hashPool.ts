// Upload hashing on several CPU cores: segment ranges (core uploadBatch's
// SegmentHasher jobs) go to a few web workers, so a big file or several
// files hash in parallel and the page stays responsive. Workers start on
// first use and stay for the session; without worker support the hashing
// runs on this thread, as in core.

import type { SegmentHasher } from '@0gdrive/core'
import { hashSegments, type StreamSource } from '@0gdrive/core/merkle'

const POOL_SIZE = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1))

interface Pending {
  resolve: (roots: Uint8Array) => void
  reject: (err: Error) => void
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
      w.onmessage = (e: MessageEvent<{ id: number; roots?: Uint8Array; error?: string }>) => {
        busy.delete(w)
        const p = pending.get(e.data.id)
        pending.delete(e.data.id)
        if (e.data.roots) p?.resolve(e.data.roots)
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
  hashSegments(job.src, job.from, job.to).then(p?.resolve, p?.reject)
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

export const hashInWorkers: SegmentHasher = (src, from, to) => {
  if (!start()?.length) return hashSegments(src, from, to)
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    queue.push({ id, src, from, to })
    pump()
  })
}
