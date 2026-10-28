import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { FileMeta } from '@0gdrive/core'
import { getSavedThumb, saveThumb, thumbKey } from './thumbStore'

// ─── Thumbnails ───────────────────────────────────────────────────────
//
// Thumbnails live inside the (encrypted) folder manifest, so they must stay
// small: every manifest version re-uploads all of them. ~96px WebP/JPEG at
// moderate quality is typically 2–6 KB.

const THUMB_MAX_DIM = 96
const THUMB_MAX_LEN = 9000 // characters of data URL
const THUMB_MAX_IMAGE_BYTES = 40 * 1024 * 1024

function canvasToDataUrl(canvas: HTMLCanvasElement): string | undefined {
  for (const q of [0.62, 0.45, 0.3]) {
    let url = canvas.toDataURL('image/webp', q)
    // Safari can't encode WebP and silently returns PNG — use JPEG there
    if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/jpeg', q)
    if (url.length <= THUMB_MAX_LEN) return url
  }
  return undefined
}

function drawScaled(
  source: CanvasImageSource,
  w: number,
  h: number
): string | undefined {
  if (!w || !h) return undefined
  const scale = Math.min(1, THUMB_MAX_DIM / Math.max(w, h))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return undefined
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvasToDataUrl(canvas)
}

async function imageThumb(blob: Blob): Promise<string | undefined> {
  if (blob.size > THUMB_MAX_IMAGE_BYTES) return undefined
  const bmp = await createImageBitmap(blob)
  try {
    return drawScaled(bmp, bmp.width, bmp.height)
  } finally {
    bmp.close()
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ])
}

async function videoThumb(blob: Blob): Promise<string | undefined> {
  const url = URL.createObjectURL(blob)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'metadata'
  try {
    video.src = url
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve()
        video.onerror = () => reject(new Error('video decode failed'))
      }),
      8000
    )
    const t = Number.isFinite(video.duration) ? Math.min(1, video.duration / 10) : 0
    if (t > 0) {
      video.currentTime = t
      await withTimeout(
        new Promise<void>((resolve) => {
          video.onseeked = () => resolve()
        }),
        8000
      )
    }
    return drawScaled(video, video.videoWidth, video.videoHeight)
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

function isRasterImage(mime: string): boolean {
  return mime.startsWith('image/') && mime !== 'image/svg+xml'
}

/** Best-effort thumbnail for an upload; undefined when not applicable. */
export async function makeThumbnail(file: Blob, mime: string): Promise<string | undefined> {
  try {
    if (isRasterImage(mime)) return await imageThumb(file)
    if (mime.startsWith('video/')) return await videoThumb(file)
  } catch {
    // unsupported codec/format — the file just keeps its type icon
  }
  return undefined
}

/** Only ever render our own raster data URLs. */
function isSafeThumb(t: string | undefined): t is string {
  return !!t && /^data:image\/(webp|jpeg|png);base64,/.test(t)
}

// Legacy files (uploaded before thumbnails existed): images up to 25 MB get a
// thumbnail generated lazily, one at a time, and saved on this device.
const LEGACY_MAX_BYTES = 25 * 1024 * 1024
const legacyCache = new Map<string, string | null>()
let legacyChain: Promise<unknown> = Promise.resolve()

export type BytesLoader = (
  meta: FileMeta,
  onProgress?: (msg: string, pct?: number) => void
) => Promise<Uint8Array>

// Grid tiles are far larger than the 96px manifest thumbnail, so visible
// image tiles also get a sharper local preview decoded from the file itself.
// Made one at a time, saved on this device (thumbStore.ts), never uploaded.
const HIRES_DIM = 480
const HIRES_MAX_BYTES = 25 * 1024 * 1024
const HIRES_CACHE_MAX = 300
const hiresCache = new Map<string, string | null>()
let hiresChain: Promise<unknown> = Promise.resolve()

async function hiresThumb(blob: Blob): Promise<Blob | null> {
  const probe = await createImageBitmap(blob)
  const scale = Math.min(1, HIRES_DIM / Math.min(probe.width, probe.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(probe.width * scale))
  canvas.height = Math.max(1, Math.round(probe.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    probe.close()
    return null
  }
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(probe, 0, 0, canvas.width, canvas.height)
  probe.close()
  return new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85))
}

function rememberHires(id: string, url: string | null) {
  hiresCache.set(id, url)
  if (hiresCache.size > HIRES_CACHE_MAX) {
    const [oldId, oldUrl] = hiresCache.entries().next().value as [string, string | null]
    hiresCache.delete(oldId)
    if (oldUrl) URL.revokeObjectURL(oldUrl)
  }
}

export function FileThumb({
  meta,
  load,
  fallback,
  className = 'fthumb',
  hiRes = false,
}: {
  meta: FileMeta
  load: BytesLoader
  fallback: ReactNode
  className?: string
  /** also render a sharp preview from the file itself (grid tiles) */
  hiRes?: boolean
}) {
  const [lazy, setLazy] = useState<string | null | undefined>(
    legacyCache.get(meta.id)
  )
  const [sharp, setSharp] = useState<string | null | undefined>(hiresCache.get(meta.id))
  const imgRef = useRef<HTMLElement | null>(null)

  const wantSharp =
    hiRes && isRasterImage(meta.mime) && meta.size <= HIRES_MAX_BYTES && sharp === undefined
  useEffect(() => {
    const el = imgRef.current
    if (!wantSharp || !el) return
    let alive = true
    let queued = false
    const io = new IntersectionObserver(
      async (entries) => {
        if (queued || !entries.some((e) => e.isIntersecting)) return
        queued = true
        io.disconnect()
        const key = thumbKey('sharp', meta.rootHashes)
        // saved on this device: no download, and no waiting behind one
        const saved = await getSavedThumb(key)
        if (saved instanceof Blob) {
          if (!hiresCache.has(meta.id)) rememberHires(meta.id, URL.createObjectURL(saved))
          if (alive) setSharp(hiresCache.get(meta.id) ?? null)
          return
        }
        hiresChain = hiresChain.then(async () => {
          if (!alive) return
          if (!hiresCache.has(meta.id)) {
            let url: string | null = null
            try {
              const bytes = await load(meta)
              const out = await hiresThumb(new Blob([bytes as unknown as BlobPart], { type: meta.mime }))
              if (out) {
                url = URL.createObjectURL(out)
                void saveThumb(key, out)
              }
            } catch (err) {
              console.warn(`[thumbs] sharp preview failed for ${meta.name} (${meta.mime}, ${meta.size} B):`, err)
              url = null
            }
            rememberHires(meta.id, url)
          }
          if (alive) setSharp(hiresCache.get(meta.id) ?? null)
        })
      },
      { rootMargin: '200px' }
    )
    io.observe(el)
    return () => {
      alive = false
      io.disconnect()
    }
  }, [wantSharp, meta, load, lazy])

  useEffect(() => {
    if (isSafeThumb(meta.thumb) || legacyCache.has(meta.id)) return
    if (!isRasterImage(meta.mime) || meta.size > LEGACY_MAX_BYTES) return
    if (hiRes && meta.size <= HIRES_MAX_BYTES) return // the sharp preview covers it
    let alive = true
    const key = thumbKey('small', meta.rootHashes)
    void getSavedThumb(key).then((saved) => {
      if (typeof saved === 'string' && isSafeThumb(saved)) {
        legacyCache.set(meta.id, saved)
        if (alive) setLazy(saved)
        return
      }
      legacyChain = legacyChain.then(async () => {
        if (!alive || legacyCache.has(meta.id)) return
        let t: string | null = null
        try {
          const bytes = await load(meta)
          t = (await imageThumb(new Blob([bytes as unknown as BlobPart], { type: meta.mime }))) ?? null
          if (t) void saveThumb(key, t)
        } catch (err) {
          console.warn(`[thumbs] thumbnail failed for ${meta.name} (${meta.mime}, ${meta.size} B):`, err)
          t = null
        }
        legacyCache.set(meta.id, t)
        if (alive) setLazy(t)
      })
    })
    return () => {
      alive = false
    }
  }, [meta, load, hiRes])

  if (sharp) return <img className={className} src={sharp} alt="" />
  const src = isSafeThumb(meta.thumb) ? meta.thumb : lazy ?? undefined
  if (!isSafeThumb(src)) {
    return wantSharp ? <span ref={imgRef} className="thumb-pending">{fallback}</span> : <>{fallback}</>
  }
  return <img ref={(el) => { imgRef.current = el }} className={className} src={src} alt="" loading="lazy" />
}

// ─── Preview ──────────────────────────────────────────────────────────

const PREVIEW_MAX_BYTES = 100 * 1024 * 1024
const TEXT_MAX_BYTES = 2 * 1024 * 1024
const TEXT_EXTS = [
  'txt', 'md', 'csv', 'json', 'log', 'yml', 'yaml', 'toml', 'xml', 'ini',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'py', 'rs', 'go', 'c', 'h', 'cpp', 'java',
  'sh', 'css', 'html', 'sql', 'sol',
]

type Kind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'none'

function previewKind(meta: FileMeta, data?: Uint8Array): Kind {
  const ext = meta.name.split('.').pop()?.toLowerCase() ?? ''
  const m = meta.mime
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  if (m === 'application/pdf' || ext === 'pdf') {
    // only hand bytes to the PDF viewer if they really are a PDF
    if (!data) return 'pdf'
    const head = new TextDecoder().decode(data.subarray(0, 5))
    return head === '%PDF-' ? 'pdf' : 'none'
  }
  if ((m.startsWith('text/') || m.includes('json') || TEXT_EXTS.includes(ext)) && meta.size <= TEXT_MAX_BYTES) {
    return 'text'
  }
  return 'none'
}

/** Can this file be previewed at all (before downloading it)? */
export function canPreview(meta: FileMeta): boolean {
  return meta.size <= PREVIEW_MAX_BYTES && previewKind(meta) !== 'none'
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function PreviewModal({
  meta,
  load,
  onDownload,
  onClose,
}: {
  meta: FileMeta
  load: BytesLoader
  onDownload: (data: Uint8Array) => void
  onClose: () => void
}) {
  const [data, setData] = useState<Uint8Array | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<string>('Fetching from 0G…')
  const [url, setUrl] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const tooBig = meta.size > PREVIEW_MAX_BYTES

  useEffect(() => {
    if (tooBig) return
    let alive = true
    load(meta, (msg, pct) => {
      if (alive) setProgress(pct !== undefined ? `Downloading & decrypting… ${pct}%` : msg)
    })
      .then((bytes) => {
        if (alive) setData(bytes)
      })
      .catch((err) => {
        if (alive) setError((err as Error).message)
      })
    return () => {
      alive = false
    }
  }, [meta, load, tooBig])

  const kind = data ? previewKind(meta, data) : previewKind(meta)

  useEffect(() => {
    if (!data) return
    if (kind === 'text') {
      setText(new TextDecoder('utf-8', { fatal: false }).decode(data))
      return
    }
    if (kind === 'none') return
    // HTML is never rendered (a blob: URL would run with the app's origin);
    // only media types and verified PDFs get an object URL.
    const type = kind === 'pdf' ? 'application/pdf' : meta.mime
    const u = URL.createObjectURL(new Blob([data as unknown as BlobPart], { type }))
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [data, kind, meta.mime])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  let body: ReactNode
  if (tooBig) {
    body = <p className="preview-note">Too large to preview ({fmtSize(meta.size)}) — download it instead.</p>
  } else if (error) {
    body = <p className="error-text">⚠ {error}</p>
  } else if (!data) {
    body = (
      <div className="preview-loading">
        <span className="spinner" aria-hidden="true" />
        <span>{progress}</span>
      </div>
    )
  } else if (kind === 'text' && text !== null) {
    body = <pre className="preview-text">{text}</pre>
  } else if (kind === 'none' || !url) {
    body = <p className="preview-note">No preview for this file type.</p>
  } else if (kind === 'image') {
    body = <img className="preview-media" src={url} alt={meta.name} />
  } else if (kind === 'video') {
    body = <video className="preview-media" src={url} controls autoPlay={false} />
  } else if (kind === 'audio') {
    body = <audio className="preview-audio" src={url} controls />
  } else {
    body = <iframe className="preview-pdf" src={url} title={meta.name} />
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="preview-head">
          <div className="preview-title">
            <span className="preview-name">{meta.name}</span>
            <span className="muted">{fmtSize(meta.size)}</span>
          </div>
          <div className="preview-actions">
            <button className="btn small" disabled={!data} onClick={() => data && onDownload(data)}>
              Download
            </button>
            <button className="btn small" onClick={onClose} aria-label="Close preview">
              ✕
            </button>
          </div>
        </div>
        <div className="preview-body">{body}</div>
      </div>
    </div>
  )
}
