import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { runTurn, type Step } from './agent'
import { checkKey, getPrice, KEYS_URL, DEPOSIT_URL, MODEL, type Price, type Usage } from './router'
import { Markdown } from './Markdown'
import { loadKnowledge, publicUrl, readText } from './knowledge'
import { closePanel, parentOrigin } from './bridge'

const KEY_STORE = '0gassist:key'

function loadKey(): string | null {
  try {
    return localStorage.getItem(KEY_STORE)
  } catch {
    return null
  }
}
function saveKey(key: string | null) {
  try {
    if (key) localStorage.setItem(KEY_STORE, key)
    else localStorage.removeItem(KEY_STORE)
  } catch {
    // private window: the key lasts for this session only
  }
}

interface Turn {
  question: string
  answer: string
  steps: Step[]
  thinking: boolean
  usage?: Usage
  rounds?: number
  error?: string
  done: boolean
}

const SUGGESTIONS = [
  'How do I recover my drive if I lose my wallet?',
  'Is my drive backed up?',
  'How does “Encrypted to recipient” sharing work?',
  'How does 0G Storage make sure my file is really stored?',
]

function fmtCost(usage: Usage, price: Price | null): string {
  if (!price) return ''
  const og = usage.prompt_tokens * price.prompt + usage.completion_tokens * price.completion
  const usd =
    price.promptUsd !== undefined && price.completionUsd !== undefined
      ? usage.prompt_tokens * price.promptUsd + usage.completion_tokens * price.completionUsd
      : null
  return ` · ≈${og < 0.001 ? og.toFixed(5) : og.toFixed(4)} 0G${usd !== null ? ` ($${usd.toFixed(4)})` : ''}`
}

/** citation target: path plus optional #L12 or #L12-L30 */
function parseCite(href: string): { path: string; from?: number; to?: number } | null {
  const m = /^((?:0gdrive|docs|github):[^#]+)(?:#L(\d+)(?:-L?(\d+))?)?$/.exec(href)
  if (!m) return null
  return { path: m[1], from: m[2] ? Number(m[2]) : undefined, to: m[3] ? Number(m[3]) : undefined }
}

function SourceViewer({ cite, onClose }: { cite: { path: string; from?: number; to?: number }; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const focus = useRef<HTMLDivElement>(null)
  useEffect(() => {
    readText(cite.path).then((r) => setText(r.text), (e: Error) => setError(e.message))
  }, [cite.path])
  useEffect(() => {
    focus.current?.scrollIntoView({ block: 'center' })
  }, [text])
  const base = publicUrl(cite.path)
  // GitHub opens at the cited lines
  const url = base?.startsWith('https://github.com/') && cite.from ? `${base}#L${cite.from}${cite.to ? `-L${cite.to}` : ''}` : base
  const from = cite.from ?? 0
  const to = cite.to ?? cite.from ?? 0
  return (
    <div className="viewer" role="dialog" aria-label={`Source: ${cite.path}`}>
      <div className="viewer-head">
        <span className="viewer-path">{cite.path.replace(/^\w+:/, '')}</span>
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer">
            Open original ↗
          </a>
        )}
        <button className="icon-btn" onClick={onClose} aria-label="Close source">
          ×
        </button>
      </div>
      <div className="viewer-body">
        {error && <p className="error">{error}</p>}
        {text === null && !error && <p className="muted">Loading…</p>}
        {text?.split('\n').map((l, i) => {
          const n = i + 1
          const hit = n >= from && n <= to
          return (
            <div key={i} className={`vline${hit ? ' hit' : ''}`} ref={n === from ? focus : undefined}>
              <span className="vn">{n}</span>
              <span className="vt">{l || ' '}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function KeySetup({ onSaved, initialError }: { onSaved: (key: string) => void; initialError?: string }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(initialError ?? null)
  const submit = async () => {
    const key = value.trim()
    if (!/^sk-\S{8,}$/.test(key)) {
      setError('That doesn’t look like an API key — it starts with “sk-”.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await checkKey(key)
      onSaved(key)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="setup">
      <h1>Ask about 0GDrive and 0G</h1>
      <p>
        The assistant answers from 0GDrive’s guide and source and the 0G docs and code. It runs on{' '}
        <strong>0G Private Computer</strong> with your own API key: the model ({MODEL.toUpperCase()}) runs in a
        secure enclave, and you pay 0G directly per question: usually 0.05–0.25 0G (a few US cents), more for deep
        questions about source code. Each answer shows what it cost.
      </p>
      <ol className="setup-steps">
        <li>
          <a className="btn" href={KEYS_URL} target="_blank" rel="noopener noreferrer">
            Get a key at pc.0g.ai ↗
          </a>
          <span className="muted">
            Sign in (wallet or Google/X), deposit some 0G, then <em>Dashboard → API Keys → Create</em>. Make a separate
            key for this and keep a small balance: keys have no spending limit.
          </span>
        </li>
        <li>
          <form
            className="key-form"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <input
              type="password"
              placeholder="paste your key: sk-…"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-label="0G Private Computer API key"
            />
            <button className="btn primary" type="submit" disabled={busy || !value.trim()}>
              {busy ? 'Checking…' : 'Save key'}
            </button>
          </form>
        </li>
      </ol>
      {error && (
        <p className="error">
          {error}
          {/balance/i.test(error) && (
            <>
              {' '}
              <a href={DEPOSIT_URL} target="_blank" rel="noopener noreferrer">
                Deposit ↗
              </a>
            </>
          )}
        </p>
      )}
      <p className="privacy">
        🔒 The key is saved only in the assistant’s own corner of this browser — the drive page can’t read it — and
        is sent only to router-api.0g.ai. The assistant can’t see your files, keys or wallet address either.
      </p>
    </div>
  )
}

export default function App() {
  const [key, setKey] = useState<string | null>(loadKey)
  const [keyError, setKeyError] = useState<string | undefined>()
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [price, setPrice] = useState<Price | null>(null)
  const [viewing, setViewing] = useState<{ path: string; from?: number; to?: number } | null>(null)
  const [menu, setMenu] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    void getPrice().then(setPrice)
    void loadKnowledge().catch(() => {})
  }, [])

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [turns])

  // Escape: close the source viewer or menu, else the panel (focus is in
  // this frame, so the drive page never sees the key)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (viewing) setViewing(null)
      else if (menu) setMenu(false)
      else closePanel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewing, menu])

  const update = (i: number, patch: Partial<Turn>) =>
    setTurns((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)))

  const ask = useCallback(
    async (question: string) => {
      if (!key || busy || !question.trim()) return
      const history = turns.filter((t) => t.done && !t.error).map((t) => ({ question: t.question, answer: t.answer }))
      const i = turns.length
      setTurns((ts) => [...ts, { question, answer: '', steps: [], thinking: true, done: false }])
      setInput('')
      setBusy(true)
      const ctrl = new AbortController()
      abort.current = ctrl
      try {
        const r = await runTurn(
          key,
          history,
          question,
          {
            onStep: (steps) => update(i, { steps }),
            onText: (answer) => update(i, { answer, thinking: false }),
            onThinking: () => update(i, { thinking: true }),
          },
          ctrl.signal
        )
        update(i, { answer: r.answer || '(no answer)', usage: r.usage, rounds: r.rounds, thinking: false, done: true })
      } catch (e) {
        const err = e as Error & { status?: number }
        const stopped = err.name === 'AbortError'
        update(i, { error: stopped ? 'Stopped.' : err.message, thinking: false, done: true })
        if (err.status === 401 || err.status === 403) {
          // the key was revoked or mistyped: back to setup
          saveKey(null)
          setKey(null)
          setKeyError(err.message)
        }
      } finally {
        setBusy(false)
        abort.current = null
        inputRef.current?.focus()
      }
    },
    [key, busy, turns]
  )

  const link = (href: string, children: ReactNode, k: number) => {
    const cite = parseCite(href)
    if (cite) {
      return (
        <button key={k} className="cite" onClick={() => setViewing(cite)} title={href}>
          {children}
        </button>
      )
    }
    if (/^https:\/\//.test(href)) {
      return (
        <a key={k} href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      )
    }
    return <span key={k}>{children}</span>
  }

  return (
    <div className="shell">
      <header className="top">
        <span className="title">Assistant</span>
        <span className="badge" title="GLM-5.3 on 0G Private Computer, TEE providers only">
          GLM-5.3 · private
        </span>
        <span className="spacer" />
        {key && turns.length > 0 && (
          <button className="btn small" onClick={() => setTurns([])} disabled={busy}>
            New chat
          </button>
        )}
        {key && (
          <div className="menu-wrap">
            <button className="icon-btn" onClick={() => setMenu((m) => !m)} aria-label="Assistant settings" aria-expanded={menu}>
              ⋯
            </button>
            {menu && (
              <div className="menu" role="menu">
                <a href="https://pc.0g.ai/dashboard/overview" target="_blank" rel="noopener noreferrer" role="menuitem">
                  Balance &amp; usage ↗
                </a>
                <button
                  role="menuitem"
                  onClick={() => {
                    saveKey(null)
                    setKey(null)
                    setMenu(false)
                    setKeyError(undefined)
                  }}
                >
                  Forget API key
                </button>
              </div>
            )}
          </div>
        )}
        {parentOrigin && (
          <button className="icon-btn" onClick={closePanel} aria-label="Close assistant">
            ×
          </button>
        )}
      </header>

      {!key ? (
        <KeySetup
          initialError={keyError}
          onSaved={(k) => {
            saveKey(k)
            setKey(k)
            setKeyError(undefined)
          }}
        />
      ) : (
        <>
          <main className="chat">
            {turns.length === 0 && (
              <div className="empty">
                <p>Ask anything about using 0GDrive, how it works, or 0G Storage, Chain and Compute.</p>
                <div className="suggestions">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} className="suggestion" onClick={() => void ask(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {turns.map((t, i) => (
              <div key={i} className="turn">
                <div className="q">{t.question}</div>
                {t.steps.length > 0 && (
                  <ul className="steps">
                    {t.steps.map((s, j) => (
                      <li key={j} className={s.done ? 'done' : 'running'}>
                        <span className="step-ico" aria-hidden="true">{s.done ? '✓' : '…'}</span>
                        {s.label}
                      </li>
                    ))}
                  </ul>
                )}
                {t.answer && (
                  <div className="a">
                    <Markdown text={t.answer} link={link} />
                  </div>
                )}
                {!t.done && !t.answer && <div className="thinking">{t.thinking ? 'Thinking…' : 'Working…'}</div>}
                {t.error && <p className="error">{t.error}</p>}
                {t.done && t.usage && (
                  <div className="meta">
                    {t.rounds} step{t.rounds === 1 ? '' : 's'} · {(t.usage.prompt_tokens + t.usage.completion_tokens).toLocaleString()} tokens
                    {fmtCost(t.usage, price)}
                  </div>
                )}
              </div>
            ))}
            <div ref={bottom} />
          </main>
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault()
              void ask(input)
            }}
          >
            <textarea
              ref={inputRef}
              value={input}
              placeholder="Ask about 0GDrive or 0G…"
              rows={2}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void ask(input)
                }
              }}
              aria-label="Your question"
            />
            {busy ? (
              <button className="btn" type="button" onClick={() => abort.current?.abort()}>
                Stop
              </button>
            ) : (
              <button className="btn primary" type="submit" disabled={!input.trim()}>
                Ask
              </button>
            )}
          </form>
          <p className="foot">Answers can be wrong — check the linked sources. Never paste keys or passwords here.</p>
        </>
      )}
      {viewing && <SourceViewer cite={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}
