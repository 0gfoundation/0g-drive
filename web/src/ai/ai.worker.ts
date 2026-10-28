/// <reference lib="webworker" />
// AI Web Worker: all model work runs here, off the UI thread. Plaintext
// arrives from the page (already decrypted locally) and never leaves the
// device — the only network traffic is the one-time model download.

import { RawImage, env } from '@huggingface/transformers'
import { embedPassage, embedQuery, indexPhoto, indexText, onModelProgress, warmUp } from './engine'
import { modelFetch, onNetStats, planDownloads, type NetStats } from './netfetch'

env.allowLocalModels = false // weights come from the HF CDN, then the browser cache
env.useBrowserCache = true
env.fetch = modelFetch // progress in bytes, stall recovery via the app's server

export type AiRequest =
  | { id: number; op: 'indexPhoto'; name: string; image: Blob }
  | { id: number; op: 'indexText'; name: string; text?: string }
  | { id: number; op: 'query'; text: string; photos: boolean }
  | { id: number; op: 'embed'; texts: string[] }
  | { id: number; op: 'warm' }

export type AiMessage =
  | { type: 'result'; id: number; result: unknown }
  | { type: 'error'; id: number; error: string }
  | { type: 'progress'; model: string; file?: string; progress?: number; status: string }
  | ({ type: 'net' } & NetStats)

const post = (m: AiMessage) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m)

onModelProgress((p) => post({ type: 'progress', ...p }))
onNetStats((s) => post({ type: 'net', ...s }))

// CLIP center-crops to 224 px; decoding a 12 MP photo at full size would
// only waste memory, so scale it down first.
const MAX_IMAGE_EDGE = 448

async function toRawImage(blob: Blob): Promise<RawImage> {
  const probe = await createImageBitmap(blob)
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(probe.width, probe.height))
  const w = Math.max(1, Math.round(probe.width * scale))
  const h = Math.max(1, Math.round(probe.height * scale))
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  ctx.drawImage(probe, 0, 0, w, h)
  probe.close()
  const { data } = ctx.getImageData(0, 0, w, h)
  return new RawImage(data, w, h, 4)
}

// One request at a time: models are single-threaded anyway, and a queue
// keeps memory flat when a batch of uploads arrives at once.
let chain: Promise<unknown> = Promise.resolve()

self.onmessage = (e: MessageEvent<AiRequest>) => {
  const req = e.data
  chain = chain.then(async () => {
    try {
      let result: unknown
      switch (req.op) {
        case 'indexPhoto':
          result = await indexPhoto(req.name, await toRawImage(req.image))
          break
        case 'indexText':
          result = await indexText(req.name, req.text)
          break
        case 'query':
          result = await embedQuery(req.text, req.photos)
          break
        case 'warm':
          await planDownloads(env.cacheKey)
          result = await warmUp()
          break
        case 'embed':
          result = await Promise.all(req.texts.map((t) => embedPassage(t)))
          break
      }
      post({ type: 'result', id: req.id, result })
    } catch (err) {
      post({ type: 'error', id: req.id, error: (err as Error).message ?? String(err) })
    }
  })
}
