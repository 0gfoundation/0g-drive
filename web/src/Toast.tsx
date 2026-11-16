// One message at a time at the bottom of the screen: what just happened,
// with Undo where it can be undone, or what went wrong in plain words (the
// details are in Activity). A new one takes the place of the last.
import { useCallback, useEffect, useRef, useState } from 'react'

export interface ToastMsg {
  text: string
  error?: boolean
  /** a button on it, e.g. Undo; the toast closes when it's pressed */
  action?: { label: string; run: () => void }
}

const SHOW_MS = 6000
const ERROR_MS = 10_000

export function useToast() {
  const [toast, setToast] = useState<(ToastMsg & { id: number }) | null>(null)
  const nextId = useRef(0)
  const show = useCallback((t: ToastMsg) => setToast({ ...t, id: ++nextId.current }), [])
  const close = useCallback(() => setToast(null), [])
  return { toast, show, close }
}

export function Toast({ toast, onClose, onDetails }: { toast: (ToastMsg & { id: number }) | null; onClose: () => void; onDetails: () => void }) {
  const [hover, setHover] = useState(false)
  useEffect(() => {
    if (!toast || hover) return
    const timer = setTimeout(onClose, toast.error ? ERROR_MS : SHOW_MS)
    return () => clearTimeout(timer)
  }, [toast, hover, onClose])
  return (
    <div className="toast-slot" role="status" aria-live="polite">
      {toast && (
        <div
          key={toast.id}
          className={`toast${toast.error ? ' error' : ''}`}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
        >
          {toast.error && (
            <svg className="toast-icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7.5v5.5M12 16.5v.01" />
            </svg>
          )}
          <span className="toast-text">{toast.text}</span>
          {toast.action && (
            <button
              className="toast-btn"
              onClick={() => {
                onClose()
                toast.action!.run()
              }}
            >
              {toast.action.label}
            </button>
          )}
          {toast.error && (
            <button
              className="toast-btn"
              onClick={() => {
                onClose()
                onDetails()
              }}
            >
              Details
            </button>
          )}
          <button className="toast-close" onClick={onClose} aria-label="Dismiss">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}
