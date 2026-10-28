// The assistant's only channel to the drive page that embeds it: postMessage,
// with a fixed message list. The drive answers with on/off facts about its
// state (never addresses, file names or keys) and can highlight a control.
// Its counterpart is web/src/Assistant.tsx.

export interface DriveStatus {
  screen: 'start' | 'drive'
  walletConnected: boolean
  network: string
  /** a drive key is loaded in this browser */
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

export const SHOW_TARGETS = [
  'connect',
  'lost-wallet',
  'security',
  'recovery',
  'password',
  'share-key',
  'key-file',
  'upload',
  'new-folder',
  'trash',
  'search',
  'on-device-ai',
  'share',
  'sync',
  'layout',
] as const
export type ShowTarget = (typeof SHOW_TARGETS)[number]

/** drive origins allowed to embed and talk to the assistant */
function allowedParents(): string[] {
  const env = import.meta.env.VITE_DRIVE_ORIGINS as string | undefined
  if (env) return env.split(',').map((s) => s.trim())
  return ['http://localhost:5173']
}

const requested = new URLSearchParams(location.search).get('parent')
/** the drive's origin, if we are embedded by an allowed one */
export const parentOrigin: string | null =
  window.parent !== window && requested && allowedParents().includes(requested) ? requested : null

let seq = 0
const pending = new Map<number, (v: unknown) => void>()

window.addEventListener('message', (e) => {
  if (!parentOrigin || e.source !== window.parent || e.origin !== parentOrigin) return
  const m = e.data as { type?: string; id?: number; result?: unknown }
  if (m?.type === '0ga:reply' && typeof m.id === 'number') {
    pending.get(m.id)?.(m.result)
    pending.delete(m.id)
  }
})

function ask<T>(type: string, payload: object = {}): Promise<T | null> {
  if (!parentOrigin) return Promise.resolve(null)
  const id = ++seq
  return new Promise((resolve) => {
    pending.set(id, resolve as (v: unknown) => void)
    window.parent.postMessage({ type, id, ...payload }, parentOrigin!)
    setTimeout(() => {
      if (pending.delete(id)) resolve(null)
    }, 3000)
  })
}

export const getDriveStatus = () => ask<DriveStatus>('0ga:status')
export const showInDrive = (target: ShowTarget) => ask<{ shown: boolean; reason?: string }>('0ga:show', { target })
export const closePanel = () => {
  if (parentOrigin) window.parent.postMessage({ type: '0ga:close' }, parentOrigin)
}
