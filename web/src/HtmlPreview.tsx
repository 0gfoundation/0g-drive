import { useMemo, useState } from 'react'

// HTML preview: the page as it looks, safely, or its source.
//
// Never with the app's origin (a blob: URL would be: its scripts could read
// the open drive's key). The page goes into an iframe sandboxed with no
// permissions at all — no scripts, an opaque origin of its own (no access
// to the app, its storage or cookies), no forms, popups or navigating the
// app — and with a content policy that loads nothing from the network, so
// opening a file can't tell a tracker you did. Images and fonts inside the
// file (data:) and its own styles still show.

/** What the page may load: only what's inside it. */
export const HTML_PREVIEW_CSP =
  "default-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'; form-action 'none'"

/**
 * The page, made inert: the content policy first in its head; links kept
 * as their address on hover but not followable (a click would load the
 * address inside the frame); refreshes and base URLs removed. Parsing with
 * DOMParser runs nothing and loads nothing.
 */
export function inertHtml(source: string): string {
  const doc = new DOMParser().parseFromString(source, 'text/html')
  doc.querySelectorAll('meta[http-equiv], base, script, noscript').forEach((el) => {
    if (el.tagName === 'META' && !/^refresh$/i.test(el.getAttribute('http-equiv') ?? '')) return
    el.remove()
  })
  doc.querySelectorAll('a[href], area[href]').forEach((a) => {
    const href = a.getAttribute('href') ?? ''
    a.removeAttribute('href')
    if (!a.getAttribute('title')) a.setAttribute('title', href)
  })
  const csp = doc.createElement('meta')
  csp.setAttribute('http-equiv', 'Content-Security-Policy')
  csp.setAttribute('content', HTML_PREVIEW_CSP)
  doc.head.prepend(csp)
  return '<!doctype html>\n' + doc.documentElement.outerHTML
}

export function HtmlPreview({ source, name }: { source: string; name: string }) {
  const [mode, setMode] = useState<'page' | 'source'>('page')
  const page = useMemo(() => inertHtml(source), [source])
  return (
    <div className="html-preview">
      <div className="layout-toggle html-mode" role="group" aria-label="Show">
        <button className={mode === 'page' ? 'active' : ''} aria-pressed={mode === 'page'} onClick={() => setMode('page')}>
          Page
        </button>
        <button className={mode === 'source' ? 'active' : ''} aria-pressed={mode === 'source'} onClick={() => setMode('source')}>
          Source
        </button>
      </div>
      {mode === 'page' ? (
        <iframe
          className="preview-html"
          title={name}
          sandbox=""
          srcDoc={page}
          referrerPolicy="no-referrer"
          // Chrome also enforces this from outside the page
          {...{ csp: HTML_PREVIEW_CSP }}
        />
      ) : (
        <pre className="preview-text">{source}</pre>
      )}
      {mode === 'page' && <p className="html-note muted">Shown safely: scripts don’t run, links don’t open, nothing loads from the internet.</p>}
    </div>
  )
}
