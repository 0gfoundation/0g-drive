// Page-side API for on-device AI: indexing at upload, query embedding, and
// model-download status. Text extraction (plain text, PDF) happens here on
// the page; embedding happens in the worker.

import type { SearchEntry } from '@0gdrive/core'
import type { AiMessage, AiRequest } from './ai.worker'
import type { QueryVectors } from './engine'

export type { QueryVectors }

// ─── Setting ──────────────────────────────────────────────────────────

const SETTING_KEY = '0gdrive:smart-search'

/**
 * A phone: touch screen, small. The text model alone takes the tab to about
 * 1.1 GB of memory, past where many phones (iPhones especially) close it,
 * so smart search starts off there; it can still be turned on.
 */
export function isPhone(): boolean {
  try {
    return matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600
  } catch {
    return false
  }
}

export const PHONE_MEMORY_WARNING =
  'Smart search runs AI models on this phone. They need about 1 GB of memory, ' +
  'and some phones close the page when it runs short (it turns white). ' +
  'Search by file name works without it.\n\nTurn smart search on?'

export function smartSearchEnabled(): boolean {
  try {
    const v = localStorage.getItem(SETTING_KEY)
    return v === null ? !isPhone() : v !== 'off'
  } catch {
    return !isPhone()
  }
}

export function setSmartSearchEnabled(on: boolean) {
  try {
    localStorage.setItem(SETTING_KEY, on ? 'on' : 'off')
  } catch {
    // per-browser preference only
  }
}

// ─── Worker plumbing ──────────────────────────────────────────────────

export interface ModelStatus {
  /** true while model files download or initialize */
  loading: boolean
  /** 0–100 by bytes across this session's downloads; only goes up */
  percent?: number
  loadedBytes?: number
  totalBytes?: number
  bytesPerSec?: number
  /** a stalled download is being resumed */
  reconnecting?: boolean
  /** downloads currently go through the app's server */
  viaServer?: boolean
  /** the last load failed; search falls back to names */
  error?: string
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, Pending>()
const listeners = new Set<(s: ModelStatus) => void>()
const fileProgress = new Map<string, number>()
let net: { loaded: number; total: number; bytesPerSec: number; active: number; route: string; reconnecting: boolean } | null = null
let warmInFlight = false
let lastError: string | undefined
let status: ModelStatus = { loading: false }

function recompute() {
  const loading = warmInFlight || (net?.active ?? 0) > 0 || fileProgress.size > 0
  const s: ModelStatus = { loading, error: loading ? undefined : lastError }
  if (loading && net && net.total > 0 && net.loaded < net.total) {
    s.loadedBytes = net.loaded
    s.totalBytes = net.total
    s.percent = Math.min(99, Math.floor((net.loaded / net.total) * 100))
    s.bytesPerSec = net.bytesPerSec
    s.reconnecting = net.reconnecting
    s.viaServer = net.route === 'server'
  }
  status = s
  listeners.forEach((l) => l(s))
}

export function getModelStatus(): ModelStatus {
  return status
}

export function subscribeModelStatus(cb: (s: ModelStatus) => void): () => void {
  listeners.add(cb)
  cb(status)
  return () => listeners.delete(cb)
}

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<AiMessage>) => {
    const m = e.data
    if (m.type === 'net') {
      net = m
      recompute()
      return
    }
    if (m.type === 'progress') {
      // transformers.js lifecycle: covers loading outside a warm-up
      // (byte counts come from 'net'; per-chunk events would only re-render)
      const key = `${m.model}/${m.file ?? ''}`
      const before = fileProgress.size
      if (m.status === 'initiate' || m.status === 'download') fileProgress.set(key, 0)
      if (m.status === 'done') fileProgress.delete(key)
      if (m.status === 'ready') fileProgress.clear()
      if (fileProgress.size !== before) recompute()
      return
    }
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    if (m.type === 'result') p.resolve(m.result)
    else p.reject(new Error(m.error))
  }
  worker.onerror = (e) => {
    const err = new Error(e.message || 'AI worker failed')
    pending.forEach((p) => p.reject(err))
    pending.clear()
    worker?.terminate()
    worker = null // the next call starts a fresh worker
    fileProgress.clear()
    lastError = err.message
    recompute()
  }
  return worker
}

type Req = AiRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never

function call<T>(req: Req): Promise<T> {
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    getWorker().postMessage({ ...req, id })
  })
}

// ─── Text extraction ──────────────────────────────────────────────────

const TEXT_EXTS = new Set([
  'txt', 'md', 'csv', 'json', 'log', 'yml', 'yaml', 'toml', 'xml', 'ini',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'py', 'rs', 'go', 'c', 'h', 'cpp', 'java',
  'sh', 'css', 'html', 'sql', 'sol', 'tex', 'rtf',
])
/** Bytes of a text file read for indexing — the model reads ≤128 tokens. */
const TEXT_READ_BYTES = 16 * 1024
const PDF_MAX_BYTES = 50 * 1024 * 1024
const PDF_PAGES = 2
export const PHOTO_MAX_BYTES = 40 * 1024 * 1024

const ext = (name: string) => name.split('.').pop()?.toLowerCase() ?? ''

export function isTextLike(name: string, mime: string): boolean {
  return mime.startsWith('text/') || mime.includes('json') || TEXT_EXTS.has(ext(name))
}

export function isPdf(name: string, mime: string): boolean {
  return mime === 'application/pdf' || ext(name) === 'pdf'
}

export function isPhoto(mime: string): boolean {
  return mime.startsWith('image/') && mime !== 'image/svg+xml'
}

async function pdfText(blob: Blob): Promise<string | undefined> {
  const pdfjs = await import('pdfjs-dist')
  const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) })
  const doc = await task.promise
  try {
    const parts: string[] = []
    for (let p = 1; p <= Math.min(PDF_PAGES, doc.numPages); p++) {
      const page = await doc.getPage(p)
      const content = await page.getTextContent()
      parts.push(content.items.map((i) => ('str' in i ? i.str : '')).join(' '))
    }
    const text = parts.join('\n').replace(/\s+/g, ' ').trim()
    return text || undefined
  } finally {
    void task.destroy()
  }
}

async function extractText(blob: Blob, name: string, mime: string): Promise<string | undefined> {
  if (isTextLike(name, mime)) {
    const head = await blob.slice(0, TEXT_READ_BYTES).text()
    return head.trim() || undefined
  }
  if (isPdf(name, mime) && blob.size <= PDF_MAX_BYTES) {
    const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer())
    if (String.fromCharCode(...head) !== '%PDF-') return undefined
    return pdfText(blob)
  }
  return undefined
}

function dataUrlToBlob(url: string): Blob {
  const [head, b64] = url.split(',', 2)
  const mime = /data:([^;]+)/.exec(head)?.[1] ?? 'image/jpeg'
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Build the search entry for a file (best-effort: undefined on failure, so
 * an indexing problem never blocks an upload). `thumb` stands in for the
 * picture of a video.
 */
export async function indexFile(
  blob: Blob,
  name: string,
  mime: string,
  thumb?: string
): Promise<SearchEntry | undefined> {
  try {
    try {
      if (isPhoto(mime) && blob.size <= PHOTO_MAX_BYTES) {
        return await call<SearchEntry>({ op: 'indexPhoto', name, image: blob })
      }
      if (mime.startsWith('video/') && thumb) {
        return await call<SearchEntry>({ op: 'indexPhoto', name, image: dataUrlToBlob(thumb) })
      }
    } catch (err) {
      // a picture this browser can't decode (e.g. HEIC in Chrome): index
      // its name instead, so it doesn't stay "unindexed" forever
      console.warn('photo indexing failed for', name, '— indexing its name only', err)
      return await call<SearchEntry>({ op: 'indexText', name, text: undefined })
    }
    const text = await extractText(blob, name, mime).catch(() => undefined)
    return await call<SearchEntry>({ op: 'indexText', name, text })
  } catch (err) {
    console.warn('indexing failed for', name, err)
    return undefined
  }
}

/**
 * A file's search entry after a rename. Only redone when on-device AI is
 * on and its models are already loaded (a rename never starts a model
 * download); otherwise, or on failure, the old entry is kept — name search
 * uses the record's name anyway.
 */
export async function entryForRename(entry: SearchEntry | undefined, name: string): Promise<SearchEntry | undefined> {
  if (!entry || !smartSearchEnabled() || !warmed || status.error) return entry
  try {
    return await call<SearchEntry>({ op: 'renameEntry', name, entry })
  } catch (err) {
    console.warn('search entry not updated for', name, err)
    return entry
  }
}

/** Whether indexing this file needs its content (vs. name only). */
export function needsContent(name: string, mime: string, size: number): boolean {
  return (
    (isPhoto(mime) && size <= PHOTO_MAX_BYTES) ||
    (isTextLike(name, mime) && size <= 20 * 1024 * 1024) ||
    (isPdf(name, mime) && size <= PDF_MAX_BYTES)
  )
}

let warming: Promise<unknown> | null = null
let warmed = false
/**
 * Start downloading/initializing the models in the background (once per
 * page). Called when a drive opens with smart search on, so models are
 * usually ready before the first upload needs them.
 */
export function warmUpModels(): Promise<unknown> {
  if (!warming) {
    warmInFlight = true
    lastError = undefined
    recompute()
    warming = call<true>({ op: 'warm' })
      .then(() => {
        warmed = true
        keepModelCache()
      })
      .catch((err) => {
        warming = null // allow a retry later
        lastError = (err as Error).message ?? String(err)
        console.warn('model warm-up failed', err)
      })
      .finally(() => {
        warmInFlight = false
        fileProgress.clear()
        recompute()
      })
  }
  return warming
}

let photoWarming: Promise<unknown> | null = null
/**
 * On desktop, once the text model is ready, also load CLIP's text half
 * (~64 MB, ~250 MB of memory) when the drive has indexed photos, so the
 * first search doesn't wait for it. Not on phones (memory, see isPhone):
 * there the first search loads it.
 */
export function warmUpPhotoSearch(): void {
  if (photoWarming || isPhone()) return
  photoWarming = warmUpModels()
    .then(() => (warmed ? call<true>({ op: 'warmPhotoSearch' }) : (photoWarming = null)))
    .catch((err) => {
      photoWarming = null // a later drive load tries again
      console.warn('photo search warm-up failed', err)
    })
}

/**
 * Ask the browser not to evict the model cache (up to ~320 MB) under storage
 * pressure. Chrome decides silently (it favours sites in use); Firefox may
 * prompt once. A refusal just means a re-download if the cache is evicted.
 */
function keepModelCache() {
  const storage = navigator.storage
  if (!storage?.persist) return
  storage
    .persisted()
    .then((already) => (already ? true : storage.persist()))
    .then((granted) => {
      if (!granted) console.info('[models] persistent storage not granted; the cache may be evicted when disk is low')
    })
    .catch(() => {})
}

/**
 * True while the warm-up is still running — including its first moments,
 * before the worker has reported any download progress.
 */
export function modelsLoading(): boolean {
  return warmInFlight || status.loading
}

/** Resolves once a warm-up is complete (immediately if none is running). */
export function modelsReady(): Promise<unknown> {
  return warming ?? Promise.resolve()
}

export function embedSearchQuery(text: string, photos: boolean): Promise<QueryVectors> {
  return call<QueryVectors>({ op: 'query', text, photos })
}

/** Text embeddings for short strings (folder names, for suggestions). */
export function embedTexts(texts: string[]): Promise<Float32Array[]> {
  return call<Float32Array[]>({ op: 'embed', texts })
}

// ─── Status text ──────────────────────────────────────────────────────

const mb = (b: number) => (b / 1048576 >= 100 ? (b / 1048576).toFixed(0) : (b / 1048576).toFixed(1))

/** Seconds until the model download finishes, if it can be estimated. */
export function modelEta(s: ModelStatus): number | undefined {
  if (!s.totalBytes || s.loadedBytes === undefined || !s.bytesPerSec) return undefined
  return (s.totalBytes - s.loadedBytes) / s.bytesPerSec
}

/** "AI models 42% · 133 / 318 MB · 2.1 MB/s" (short: "AI 42%"). */
export function describeModelStatus(s: ModelStatus, short = false): string {
  if (!s.loading) return s.error ? 'AI offline' : ''
  if (s.percent === undefined) return short ? 'AI…' : 'Preparing AI models…'
  if (short) return `AI ${s.percent}%`
  let t = `AI models ${s.percent}% · ${mb(s.loadedBytes ?? 0)} / ${mb(s.totalBytes ?? 0)} MB`
  if (s.reconnecting) t += ' · reconnecting…'
  else if (s.bytesPerSec) t += ` · ${s.bytesPerSec >= 1048576 ? `${mb(s.bytesPerSec)} MB/s` : `${Math.round(s.bytesPerSec / 1024)} KB/s`}`
  return t
}
