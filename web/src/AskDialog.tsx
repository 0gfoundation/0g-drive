import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { closeOnBackdrop } from './backdrop'

/**
 * The drive's own confirm and prompt boxes, in place of window.confirm and
 * window.prompt (which the browser draws in its own style). One question at
 * a time; <AskDialog /> is mounted once, in main.tsx.
 */

interface Question {
  id: number
  title: string
  message?: string
  /** the action button's label, e.g. "Delete forever" */
  action: string
  /** red action button, for what can't be undone */
  danger?: boolean
  cancel?: string
  /** a text field: the answer is its trimmed value */
  input?: {
    label: string
    value?: string
    placeholder?: string
    inputMode?: 'decimal' | 'text'
    /** a problem with the typed value, shown under the field, or null when it's fine */
    check?: (value: string) => string | null
  }
  resolve: (answer: string | null) => void
}

let current: Question | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

let asked = 0
function ask(q: Omit<Question, 'resolve' | 'id'>): Promise<string | null> {
  current?.resolve(null)
  return new Promise((resolve) => {
    const mine: Question = {
      ...q,
      id: ++asked,
      resolve: (answer) => {
        if (current !== mine) return
        current = null
        emit()
        resolve(answer)
      },
    }
    current = mine
    emit()
  })
}

/** true when the user picks the action, false on Cancel, Escape or a backdrop click */
export async function askConfirm(q: Omit<Question, 'resolve' | 'id' | 'input'>): Promise<boolean> {
  return (await ask(q)) !== null
}

/** the typed text (trimmed, passing `check`), or null when cancelled */
export function askText(q: Omit<Question, 'resolve' | 'id'> & { input: NonNullable<Question['input']> }): Promise<string | null> {
  return ask(q)
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
const snapshot = () => current

export function AskDialog() {
  const q = useSyncExternalStore(subscribe, snapshot)
  // a fresh box per question: its field starts on the question's value
  return q ? <AskBox key={q.id} q={q} /> : null
}

function AskBox({ q }: { q: Question }) {
  const [value, setValue] = useState(q.input?.value ?? '')
  const [touched, setTouched] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const actionRef = useRef<HTMLButtonElement>(null)

  // a prompt starts on its field (autoFocus); a confirm on its action, or
  // on Cancel when the action can't be undone, so Enter there cancels
  useEffect(() => {
    if (!q.input) (q.danger ? cancelRef : actionRef).current?.focus()
  }, [q])

  const answer = value.trim()
  const problem = q.input ? (answer === '' ? 'Required.' : q.input.check?.(answer) ?? null) : null
  const cancel = () => q.resolve(null)
  return (
    <div className="modal-backdrop" {...closeOnBackdrop(cancel)}>
      <form
        className="modal ask-modal"
        role={q.input ? 'dialog' : 'alertdialog'}
        aria-label={q.title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && cancel()}
        onSubmit={(e) => {
          e.preventDefault()
          if (!q.input) return q.resolve('')
          setTouched(true)
          if (!problem) q.resolve(answer)
        }}
      >
        <h2>{q.title}</h2>
        {q.message && <p className="ask-message">{q.message}</p>}
        {q.input && (
          <>
            <input
              className="key-input wide"
              aria-label={q.input.label}
              value={value}
              placeholder={q.input.placeholder}
              inputMode={q.input.inputMode}
              onChange={(e) => setValue(e.target.value)}
              onFocus={(e) => e.target.select()}
              autoFocus
              spellCheck={false}
              autoComplete="off"
            />
            {problem && (touched || answer !== '') && <p className="error-text">⚠ {problem}</p>}
          </>
        )}
        <div className="modal-actions">
          <button className="btn" type="button" ref={cancelRef} onClick={cancel}>
            {q.cancel ?? 'Cancel'}
          </button>
          <button className={`btn ${q.danger ? 'danger-solid' : 'primary'}`} type="submit" ref={actionRef}>
            {q.action}
          </button>
        </div>
      </form>
    </div>
  )
}
