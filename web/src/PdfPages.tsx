import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { loadPdfjs } from './pdfjs'

// PDF preview on phones and tablets. There a PDF in a frame shows only its
// first page (every iPhone browser is Safari's engine; Android Chrome has no
// viewer in frames), so the pages are drawn here with pdf.js. Desktop
// browsers keep their own viewer (search, zoom, print).

/** Draw PDFs ourselves: a touch screen as the main pointer. */
export function drawsPdfPages(): boolean {
  try {
    return matchMedia('(pointer: coarse)').matches
  } catch {
    return false
  }
}

// iPhones cap the memory of all canvases on a page, so pages are drawn only
// near the view (one screen above and below) and released when far, each at
// most MAX_PIXELS.
const MAX_PIXELS = 4_000_000
const NEAR = '100% 0px'

export function PdfPages({ data, name }: { data: Uint8Array; name: string }) {
  const scroller = useRef<HTMLDivElement>(null)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [aspect, setAspect] = useState(1.294) // page 1's height / width, once known (A4 until then)
  const [error, setError] = useState<string | null>(null)
  const [width, setWidth] = useState(0)
  const [near, setNear] = useState<Set<number>>(new Set())
  const [current, setCurrent] = useState(1)

  useEffect(() => {
    let alive = true
    let destroy: (() => void) | undefined
    loadPdfjs()
      .then(async (pdfjs) => {
        // a copy: pdf.js hands its buffer to its worker, and Download still needs the bytes
        const task = pdfjs.getDocument({ data: data.slice() })
        destroy = () => void task.destroy()
        if (!alive) return destroy()
        const d = await task.promise
        const vp = (await d.getPage(1)).getViewport({ scale: 1 })
        if (!alive) return
        setAspect(vp.height / vp.width)
        setDoc(d)
      })
      .catch((err: Error) => {
        if (!alive) return
        setError(
          err?.name === 'PasswordException'
            ? 'This PDF is password-protected — download it to open it.'
            : 'Couldn’t show this PDF here — download it instead.'
        )
      })
    return () => {
      alive = false
      destroy?.()
    }
  }, [data])

  // the width pages are drawn at
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [doc])

  // which pages are near the view
  useEffect(() => {
    const el = scroller.current
    if (!el || !doc) return
    const io = new IntersectionObserver(
      (entries) =>
        setNear((prev) => {
          const next = new Set(prev)
          for (const e of entries) {
            const n = Number((e.target as HTMLElement).dataset.page)
            if (e.isIntersecting) next.add(n)
            else next.delete(n)
          }
          return next
        }),
      { root: el, rootMargin: NEAR }
    )
    el.querySelectorAll('.pdf-page').forEach((p) => io.observe(p))
    return () => io.disconnect()
  }, [doc])

  const onScroll = () => {
    const el = scroller.current
    if (!el || !doc) return
    // at the end the last page, though shorter than the view, is the one being read
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) return setCurrent(doc.numPages)
    const line = el.scrollTop + el.clientHeight / 3
    for (const p of el.querySelectorAll<HTMLElement>('.pdf-page')) {
      if (p.offsetTop + p.offsetHeight > line) return setCurrent(Number(p.dataset.page))
    }
  }

  if (error) return <p className="preview-note">{error}</p>
  if (!doc) {
    return (
      <div className="preview-loading">
        <span className="spinner" aria-hidden="true" />
        <span>Opening {name}…</span>
      </div>
    )
  }
  const pages = Array.from({ length: doc.numPages }, (_, i) => i + 1)
  return (
    <div className="pdf-viewer">
      <div className="pdf-pages" ref={scroller} onScroll={onScroll}>
        {pages.map((n) => (
          <PdfPage key={n} doc={doc} n={n} width={width} aspect={aspect} near={near.has(n)} />
        ))}
      </div>
      <div className="pdf-counter" aria-live="polite">
        Page {current} of {doc.numPages}
      </div>
    </div>
  )
}

function PdfPage({ doc, n, width, aspect, near }: { doc: PDFDocumentProxy; n: number; width: number; aspect: number; near: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(aspect) // this page's own, once drawn
  const [state, setState] = useState<'empty' | 'drawn' | 'failed'>('empty')

  useEffect(() => {
    const el = box.current
    if (!near || !width || !el) return
    let task: RenderTask | undefined
    let alive = true
    const canvas = document.createElement('canvas')
    doc
      .getPage(n)
      .then((page) => {
        if (!alive) return
        const vp1 = page.getViewport({ scale: 1 })
        let scale = (width / vp1.width) * Math.min(window.devicePixelRatio || 1, 3)
        scale = Math.min(scale, Math.sqrt(MAX_PIXELS / (vp1.width * vp1.height)))
        const viewport = page.getViewport({ scale })
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        setRatio(vp1.height / vp1.width)
        task = page.render({ canvas, viewport })
        return task.promise.then(() => {
          if (!alive) return
          el.replaceChildren(canvas)
          setState('drawn')
        })
      })
      .catch((err: Error) => {
        if (alive && err?.name !== 'RenderingCancelledException') setState('failed')
      })
    return () => {
      // far from the view again: stop drawing and give the canvas memory back
      alive = false
      task?.cancel()
      canvas.width = 0
      canvas.height = 0
      el.replaceChildren()
      setState('empty')
    }
  }, [doc, n, width, near])

  return (
    <div className="pdf-page" data-page={n} data-state={state} style={{ aspectRatio: `1 / ${ratio}` }} aria-label={`Page ${n}`}>
      <div ref={box} className="pdf-page-canvas" />
      {state === 'failed' && <span className="pdf-page-note">Page {n} couldn’t be drawn.</span>}
    </div>
  )
}
