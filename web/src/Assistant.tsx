// The help assistant, embedded from its own origin (assistant/ — port 3000
// in dev; in production a *.0g.ai host, the only origins the 0G Router's
// CORS allows). The browser's same-origin rule keeps it away from everything this
// page stores: drive key, share key, cached files, thumbnails. It holds its
// own API key, which this page never sees. The only channel is postMessage:
//   assistant → drive  0ga:status (on/off facts) · 0ga:show (highlight a control) · 0ga:close
//   drive → assistant  0ga:reply
import { useEffect, useRef, useState } from 'react'

export interface DriveStatus {
  screen: 'start' | 'drive'
  walletConnected: boolean
  network: string
  driveOpen: boolean
  readOnly: boolean
  recovery: 'on' | 'off' | 'checking' | 'unknown'
  password: 'set' | 'not-set' | 'unknown'
  shareKey: 'published' | 'outdated' | 'not-published' | 'checking' | 'unknown'
  onDeviceAi: 'off' | 'ready' | 'loading' | 'error'
  view: 'drive' | 'trash'
  uploading: boolean
  lowBalance: boolean
}
export type ShowResult = { shown: boolean; reason?: string }

export const ASSISTANT_URL =
  (import.meta.env.VITE_ASSISTANT_URL as string | undefined) ?? 'http://localhost:3000/'
const assistantOrigin = new URL(ASSISTANT_URL).origin

/** controls the assistant may point at, and how to find them on the page */
const TARGETS: Record<string, { selector: string; sidebar?: boolean }> = {
  connect: { selector: '[data-guide="connect"]' },
  'lost-wallet': { selector: '.lost-wallet' },
  security: { selector: '[data-guide="security"]', sidebar: true },
  recovery: { selector: '.sec-row[data-row="recovery"]', sidebar: true },
  password: { selector: '.sec-row[data-row="password"]', sidebar: true },
  'share-key': { selector: '.sec-row[data-row="share-key"]', sidebar: true },
  'key-file': { selector: '.sec-row[data-row="key-file"]', sidebar: true },
  upload: { selector: '.dropzone' },
  'new-folder': { selector: '[data-guide="new-folder"]' },
  trash: { selector: '[data-guide="trash"]', sidebar: true },
  search: { selector: '.searchbox' },
  'on-device-ai': { selector: '[data-guide="on-device-ai"]', sidebar: true },
  share: { selector: 'button[aria-label="Share"]' },
  sync: { selector: '[data-guide="sync"]' },
  layout: { selector: '.layout-toggle' },
}

const NARROW = '(max-width: 760px)'

/**
 * Scroll to a control and make it pulse. `prepare` opens whatever must be
 * open first (the phone sidebar, the lost-wallet form) and returns whether
 * this panel must get out of the way.
 */
export async function highlight(target: string, prepare: (sidebar: boolean) => void): Promise<ShowResult> {
  const t = TARGETS[target]
  if (!t) return { shown: false, reason: 'unknown control' }
  prepare(!!t.sidebar)
  await new Promise((r) => setTimeout(r, 120))
  const el = document.querySelector<HTMLElement>(t.selector)
  if (!el) return { shown: false, reason: 'that control is not on this screen right now' }
  // a grid row is display: contents — pulse its cells instead
  const parts = getComputedStyle(el).display === 'contents' ? (Array.from(el.children) as HTMLElement[]) : [el]
  parts[0]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  for (const p of parts) {
    p.classList.remove('guide-pulse')
    void p.offsetWidth
    p.classList.add('guide-pulse')
    setTimeout(() => p.classList.remove('guide-pulse'), 4200)
  }
  return { shown: true }
}

export function AssistantPanel({
  open,
  onClose,
  getStatus,
  show,
}: {
  open: boolean
  onClose: () => void
  getStatus: () => DriveStatus
  show: (target: string) => Promise<ShowResult>
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  // mounted on first open, then kept (closing keeps the conversation)
  const [mounted, setMounted] = useState(false)
  const latest = useRef({ onClose, getStatus, show })
  latest.current = { onClose, getStatus, show }

  useEffect(() => {
    if (open) setMounted(true)
  }, [open])

  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      const win = frame.current?.contentWindow
      if (!win || e.source !== win || e.origin !== assistantOrigin) return
      const m = e.data as { type?: unknown; id?: unknown; target?: unknown }
      const reply = (result: unknown) => win.postMessage({ type: '0ga:reply', id: m.id, result }, assistantOrigin)
      if (m?.type === '0ga:status' && typeof m.id === 'number') reply(latest.current.getStatus())
      else if (m?.type === '0ga:show' && typeof m.id === 'number') reply(await latest.current.show(String(m.target)))
      else if (m?.type === '0ga:close') latest.current.onClose()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && latest.current.onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!mounted) return null
  if (assistantOrigin === location.origin) {
    // same origin + allow-scripts + allow-same-origin would undo the isolation
    console.error('[assistant] VITE_ASSISTANT_URL must be a different origin from the drive')
    return null
  }
  return (
    <div className={`assist-panel${open ? ' open' : ''}`} aria-hidden={!open}>
      <iframe
        ref={frame}
        title="0GDrive assistant"
        src={`${ASSISTANT_URL}?parent=${encodeURIComponent(location.origin)}`}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        allow=""
        referrerPolicy="no-referrer"
      />
    </div>
  )
}

export const isNarrow = () => window.matchMedia(NARROW).matches
