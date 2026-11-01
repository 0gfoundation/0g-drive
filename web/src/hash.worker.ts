// Hashes segment ranges of an upload off the main thread (see hashPool.ts).
import { hashSegments, warmUp, type StreamSource } from '@0gdrive/core/merkle'

interface Job {
  id: number
  src: StreamSource
  from: number
  to: number
}

// started with the drive (see hashPool prestart): get the hasher ready now
void warmUp()

self.onmessage = async (e: MessageEvent<Job>) => {
  const { id, src, from, to } = e.data
  try {
    const stats = { readMs: 0, hashMs: 0 }
    const roots = await hashSegments(src, from, to, stats)
    ;(self as unknown as Worker).postMessage({ id, roots, ...stats }, [roots.buffer])
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ id, error: (err as Error).message ?? String(err) })
  }
}
