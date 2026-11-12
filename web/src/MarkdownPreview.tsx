import { useEffect, useState } from 'react'
import { HTML_PREVIEW_CSP, inertHtml } from './HtmlPreview'

// Markdown preview: the text formatted, or its source.
//
// The formatted text is HTML, so it's shown the way HTML files are
// (HtmlPreview.tsx): in an iframe sandboxed with no permissions and a
// content policy that loads nothing from the network. Markdown may carry
// raw HTML: scripts and event handlers are removed (and couldn't run in the
// sandbox anyway), and an image from the internet shows as its alt text
// rather than a broken image. The parser loads on the first Markdown file.

/** The page's look: the app's dark palette, readable line length, wide blocks scroll on their own. */
const MD_CSS = `
:root { color-scheme: dark; }
body { margin: 0; padding: 16px 20px 24px; background: #0a0a0c; color: #dcdfe4;
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans SC', sans-serif; overflow-wrap: anywhere; }
main { max-width: 760px; margin: 0 auto; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.4em 0 0.5em; color: #fff; }
h1 { font-size: 1.7em; } h2 { font-size: 1.35em; } h3 { font-size: 1.15em; } h4, h5, h6 { font-size: 1em; }
h1, h2 { padding-bottom: 0.25em; border-bottom: 1px solid #26262e; }
main > :first-child { margin-top: 0; }
p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
ul, ol { padding-left: 1.6em; }
li > ul, li > ol { margin: 0.2em 0 0; }
li:has(> input[type=checkbox]) { list-style: none; margin-left: -1.4em; }
input[type=checkbox] { margin: 0 0.4em 0 0; vertical-align: -1px; }
a { color: #b75fff; text-decoration: underline; cursor: help; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 0.88em;
  background: #1b1b22; padding: 0.15em 0.35em; border-radius: 4px; }
pre { background: #141419; border: 1px solid #26262e; border-radius: 8px; padding: 12px 14px; overflow-x: auto; overflow-wrap: normal; }
pre code { background: none; padding: 0; font-size: 0.85em; line-height: 1.5; }
blockquote { margin-left: 0; padding: 0.1em 1em; border-left: 3px solid #4932c4; color: #b8b8c0; }
hr { border: 0; border-top: 1px solid #26262e; margin: 1.5em 0; }
.table-wrap { overflow-x: auto; margin: 0 0 1em; }
table { border-collapse: collapse; margin: 0; }
th, td { border: 1px solid #26262e; padding: 6px 10px; text-align: left; vertical-align: top; overflow-wrap: normal; }
th { background: #141419; }
img { max-width: 100%; height: auto; }
.img-alt { color: #7c7e89; font-style: italic; }
`

/** Markdown → a page for the sandbox: no scripts, no handlers, remote images as their alt text. */
export function markdownPage(bodyHtml: string, title: string): string {
  const doc = new DOMParser().parseFromString(`<main>${bodyHtml}</main>`, 'text/html')
  doc.querySelectorAll('script, iframe, frame, object, embed, form, link, meta, base, style').forEach((el) => el.remove())
  doc.querySelectorAll('*').forEach((el) => {
    for (const { name } of [...el.attributes]) if (/^on/i.test(name)) el.removeAttribute(name)
  })
  doc.querySelectorAll('img').forEach((img) => {
    if (/^data:image\//i.test(img.getAttribute('src') ?? '')) return
    const alt = doc.createElement('span')
    alt.className = 'img-alt'
    alt.textContent = `[image${img.getAttribute('alt') ? `: ${img.getAttribute('alt')}` : ''}]`
    img.replaceWith(alt)
  })
  doc.querySelectorAll('table').forEach((table) => {
    const wrap = doc.createElement('div')
    wrap.className = 'table-wrap'
    table.replaceWith(wrap)
    wrap.append(table)
  })
  doc.title = title
  const style = doc.createElement('style')
  style.textContent = MD_CSS
  doc.head.append(style)
  return inertHtml('<!doctype html>\n' + doc.documentElement.outerHTML)
}

export function MarkdownPreview({ source, name }: { source: string; name: string }) {
  const [mode, setMode] = useState<'rendered' | 'source'>('rendered')
  const [page, setPage] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    import('marked')
      .then(({ marked }) => {
        if (live) setPage(markdownPage(marked.parse(source, { gfm: true, async: false }), name))
      })
      .catch((err) => {
        console.warn('markdown preview failed', err)
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [source, name])
  const showSource = mode === 'source' || failed
  return (
    <div className="html-preview md-preview">
      {!failed && (
        <div className="layout-toggle html-mode" role="group" aria-label="Show">
          <button className={mode === 'rendered' ? 'active' : ''} aria-pressed={mode === 'rendered'} onClick={() => setMode('rendered')}>
            Rendered
          </button>
          <button className={mode === 'source' ? 'active' : ''} aria-pressed={mode === 'source'} onClick={() => setMode('source')}>
            Source
          </button>
        </div>
      )}
      {showSource ? (
        <pre className="preview-text">{source}</pre>
      ) : page === null ? (
        <div className="preview-loading">
          <span className="spinner" aria-hidden="true" />
        </div>
      ) : (
        <iframe
          className="preview-html preview-md"
          title={name}
          sandbox=""
          srcDoc={page}
          referrerPolicy="no-referrer"
          {...{ csp: HTML_PREVIEW_CSP }}
        />
      )}
      {!showSource && page !== null && <p className="html-note muted">Links don’t open and images from the internet don’t load.</p>}
    </div>
  )
}
