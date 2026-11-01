// Hashes segment ranges of an upload off the main thread (see hashPool.ts).
import { hashSegments, type StreamSource } from '@0gdrive/core/merkle'

interface Job {
  id: number
  src: StreamSource
  from: number
  to: number
}

self.onmessage = async (e: MessageEvent<Job>) => {
  const { id, src, from, to } = e.data
  try {
    const roots = await hashSegments(src, from, to)
    ;(self as unknown as Worker).postMessage({ id, roots }, [roots.buffer])
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ id, error: (err as Error).message ?? String(err) })
  }
}
