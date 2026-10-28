// Phase 1 AI in the UI: drive-wide search, indexing older files, and
// organize suggestions. Everything is computed on this device; the only
// chain writes are the (batched) folder-manifest updates the user approves.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { DriveState, DriveStore, FileMeta, SearchEntry } from '@0gdrive/core'
import {
  embedSearchQuery,
  embedTexts,
  indexFile,
  needsContent,
  setSmartSearchEnabled,
  smartSearchEnabled,
  subscribeModelStatus,
  warmUpModels,
  describeModelStatus,
  type ModelStatus,
} from './ai/client'
import { rank, suggestMoves, type MoveSuggestion } from './ai/searchcore'

export interface FileHit {
  meta: FileMeta
  folder: string
  score: number
}

type BytesLoader = (meta: FileMeta) => Promise<Uint8Array>

interface Deps {
  drive: DriveState | null
  storeRef: React.MutableRefObject<DriveStore | null>
  currentPath: string
  loadBytes: BytesLoader
  reloadDrive: () => Promise<void>
  log: (msg: string) => void
  setBusy: (msg: string | null) => void
}

const lastSegment = (path: string) => path.split('/').pop() ?? path

function allFiles(drive: DriveState): { meta: FileMeta; folder: string }[] {
  const out: { meta: FileMeta; folder: string }[] = []
  for (const [path, folder] of drive.folders) {
    for (const meta of folder?.files ?? []) out.push({ meta, folder: path })
  }
  return out
}

export function useSmartDrive({ drive, storeRef, currentPath, loadBytes, reloadDrive, log, setBusy }: Deps) {
  const [enabled, setEnabled] = useState(smartSearchEnabled)
  const [model, setModel] = useState<ModelStatus>({ loading: false })
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<FileHit[] | null>(null)
  /** the query `results` belong to (the box may already show a newer one) */
  const [resultsQuery, setResultsQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [suggestions, setSuggestions] = useState<MoveSuggestion<FileMeta>[] | null>(null)
  const [suggesting, setSuggesting] = useState(false)
  const searchSeq = useRef(0)

  useEffect(() => subscribeModelStatus(setModel), [])

  // start the one-time model download as soon as a drive is open
  const driveOpen = drive !== null
  useEffect(() => {
    if (enabled && driveOpen) void warmUpModels()
  }, [enabled, driveOpen])

  const toggle = useCallback((on: boolean) => {
    setSmartSearchEnabled(on)
    setEnabled(on)
  }, [])

  // ─── Search ─────────────────────────────────────────────────────────

  const search = useCallback(
    async (text: string) => {
      const q = text.trim()
      const seq = ++searchSeq.current
      if (!q || !drive) {
        setResults(null)
        setSearching(false)
        return
      }
      const files = allFiles(drive)
      const hasPhotos = files.some((f) => f.meta.search?.c)
      setSearching(true)
      try {
        const vecs = enabled
          ? await embedSearchQuery(q, hasPhotos)
          : { vec: new Float32Array(0), clip: undefined }
        if (seq !== searchSeq.current) return // a newer query superseded this one
        const hits = rank({ text: q, vec: vecs.vec, clip: vecs.clip }, files, (f) => ({
          name: f.meta.name,
          search: enabled ? f.meta.search : f.meta.search && { v: 1, t: f.meta.search.t },
        }))
        setResults(hits.map((h) => ({ meta: h.item.meta, folder: h.item.folder, score: h.score })))
        setResultsQuery(q)
      } catch (err) {
        log(`Search failed: ${(err as Error).message}`)
      } finally {
        if (seq === searchSeq.current) setSearching(false)
      }
    },
    [drive, enabled, log]
  )

  // debounce typing; results read as "searching" until the new query lands
  useEffect(() => {
    if (query.trim()) setSearching(true)
    const t = setTimeout(() => void search(query), 350)
    return () => clearTimeout(t)
  }, [query, search])

  const clearSearch = useCallback(() => {
    setQuery('')
    setResults(null)
  }, [])

  // ─── Index older files in the current folder ────────────────────────

  const folderFiles = drive?.folders.get(currentPath)?.files ?? []
  const unindexed = enabled ? folderFiles.filter((f) => !f.search) : []

  const indexFolder = useCallback(async () => {
    const store = storeRef.current
    if (!store || unindexed.length === 0) return
    const n = unindexed.length
    setBusy(`Indexing ${n} file${n === 1 ? '' : 's'}…`)
    try {
      const updated: FileMeta[] = []
      for (let i = 0; i < unindexed.length; i++) {
        const meta = unindexed[i]
        log(`Indexing ${meta.name} (${i + 1}/${n})…`)
        let blob = new Blob([])
        if (needsContent(meta.name, meta.mime, meta.size)) {
          try {
            const bytes = await loadBytes(meta)
            blob = new Blob([bytes as unknown as BlobPart], { type: meta.mime })
          } catch (err) {
            log(`  could not read ${meta.name} (${(err as Error).message}) — indexing its name only`)
          }
        }
        const entry: SearchEntry | undefined = await indexFile(blob, meta.name, meta.mime, meta.thumb)
        if (entry) updated.push({ ...meta, search: entry })
      }
      if (updated.length === 0) {
        log('Nothing could be indexed.')
        return
      }
      log(`Saving the search index for ${updated.length} file${updated.length === 1 ? '' : 's'} — approve 1 transaction…`)
      await store.putFileRecords(currentPath, updated)
      await reloadDrive()
      log(`Indexed ${updated.length} file${updated.length === 1 ? '' : 's'} for search.`)
    } catch (err) {
      log(`Indexing failed: ${(err as Error).message}`)
    } finally {
      setBusy(null)
    }
  }, [storeRef, unindexed, currentPath, loadBytes, reloadDrive, log, setBusy])

  // ─── Organize suggestions ───────────────────────────────────────────

  const findSuggestions = useCallback(async () => {
    if (!drive) return
    setSuggesting(true)
    try {
      const paths = [...drive.folders.keys()]
      const named = paths.filter((p) => p !== '')
      const nameVecs = named.length ? await embedTexts(named.map(lastSegment)) : []
      const folders = paths.map((path) => ({
        path,
        files: drive.folders.get(path)?.files ?? [],
        nameVec: path === '' ? undefined : nameVecs[named.indexOf(path)],
      }))
      setSuggestions(suggestMoves(folders, currentPath, (m) => m))
    } catch (err) {
      log(`Suggestions failed: ${(err as Error).message}`)
    } finally {
      setSuggesting(false)
    }
  }, [drive, currentPath, log])

  // suggestions belong to one folder's state
  useEffect(() => setSuggestions(null), [currentPath, drive])

  const applySuggestions = useCallback(
    async (chosen: MoveSuggestion<FileMeta>[]) => {
      const store = storeRef.current
      if (!store || chosen.length === 0) return
      const dests = new Set(chosen.map((c) => c.to)).size
      setBusy('Moving files…')
      log(`Moving ${chosen.length} file${chosen.length === 1 ? '' : 's'} — approve ${dests + 1} transaction${dests + 1 === 1 ? '' : 's'}…`)
      try {
        await store.moveRecords(currentPath, chosen.map((c) => ({ id: c.item.id, to: c.to })))
        await reloadDrive()
        log(`Moved ${chosen.length} file${chosen.length === 1 ? '' : 's'}.`)
      } catch (err) {
        log(`Move failed: ${(err as Error).message}`)
      } finally {
        setBusy(null)
      }
    },
    [storeRef, currentPath, reloadDrive, log, setBusy]
  )

  return {
    enabled,
    toggle,
    model,
    query,
    setQuery,
    results,
    resultsQuery,
    searching,
    clearSearch,
    unindexed,
    indexFolder,
    suggestions,
    suggesting,
    findSuggestions,
    applySuggestions,
    dismissSuggestions: () => setSuggestions(null),
    retryModels: () => void warmUpModels(),
  }
}

// ─── Components ───────────────────────────────────────────────────────

export function SearchBox({
  value,
  onChange,
  onClear,
  searching,
  model,
  onRetry,
}: {
  value: string
  onChange: (v: string) => void
  onClear: () => void
  searching: boolean
  model: ModelStatus
  onRetry?: () => void
}) {
  return (
    <div className="searchbox">
      <svg className="searchbox-ico" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M11 4a7 7 0 105.2 11.7L20 19.5M16.2 15.7A7 7 0 0011 4" />
      </svg>
      <input
        type="search"
        placeholder="Search your drive — any language"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onClear()}
        aria-label="Search your drive"
      />
      {model.loading ? (
        <span
          className="searchbox-status"
          title={`One-time download of the on-device search models (~300 MB), cached by your browser afterwards.${
            model.viaServer ? ' Downloading through the app server — the model CDN was slow or unreachable.' : ''
          } Until it finishes, search matches file names.`}
        >
          <span className="spinner" aria-hidden="true" />
          <span className="sb-long">{describeModelStatus(model)}</span>
          <span className="sb-short">{describeModelStatus(model, true)}</span>
        </span>
      ) : searching ? (
        <span className="searchbox-status" title="Searching…">
          <span className="spinner" aria-hidden="true" />
        </span>
      ) : model.error && onRetry ? (
        <button
          className="searchbox-retry"
          onClick={onRetry}
          title={`Search models failed to load (${model.error}). Search matches file names until they do.`}
        >
          AI offline · retry
        </button>
      ) : null}
    </div>
  )
}

export function SearchResults({
  query,
  results,
  searching,
  renderThumb,
  onOpen,
  onGoToFolder,
  actions,
  onClear,
}: {
  query: string
  results: FileHit[]
  searching: boolean
  renderThumb: (meta: FileMeta) => ReactNode
  onOpen: (meta: FileMeta) => void
  onGoToFolder: (path: string) => void
  actions: (meta: FileMeta) => ReactNode
  onClear: () => void
}) {
  return (
    <section className="files">
      <h2>
        Results for “{query}” <span className="count">{results.length}</span>
        <button className="btn small" onClick={onClear}>clear</button>
      </h2>
      {results.length === 0 ? (
        <p className="empty">{searching ? 'Searching…' : 'No matching files.'}</p>
      ) : (
        <ul className="results">
          {results.map((h) => (
            <li key={h.meta.id} className="result">
              <button className="result-thumb" onClick={() => onOpen(h.meta)} tabIndex={-1} aria-hidden="true">
                {renderThumb(h.meta)}
              </button>
              <div className="result-main">
                <button className="fname-btn" onClick={() => onOpen(h.meta)}>
                  {h.meta.name}
                </button>
                <div className="result-meta muted">
                  in{' '}
                  <button className="crumb result-folder" onClick={() => onGoToFolder(h.folder)}>
                    {h.folder === '' ? 'My drive' : h.folder}
                  </button>
                  {h.meta.search?.g?.length ? <> · {h.meta.search.g.join(', ')}</> : null}
                </div>
                {h.meta.search?.t && <div className="result-excerpt">{h.meta.search.t}</div>}
              </div>
              <div className="row-actions">{actions(h.meta)}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function SuggestionsPanel({
  suggestions,
  busy,
  onApply,
  onDismiss,
}: {
  suggestions: MoveSuggestion<FileMeta>[]
  busy: boolean
  onApply: (chosen: MoveSuggestion<FileMeta>[]) => void
  onDismiss: () => void
}) {
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(suggestions.map((s) => s.item.id)))
  useEffect(() => setChosen(new Set(suggestions.map((s) => s.item.id))), [suggestions])
  const picked = suggestions.filter((s) => chosen.has(s.item.id))
  const txs = picked.length ? new Set(picked.map((p) => p.to)).size + 1 : 0

  return (
    <section className="suggest">
      <div className="suggest-head">
        <strong>✨ Organize suggestions</strong>
        <button className="btn small" onClick={onDismiss} aria-label="Dismiss suggestions">✕</button>
      </div>
      {suggestions.length === 0 ? (
        <p className="muted">Everything here looks like it’s in the right place.</p>
      ) : (
        <>
          <ul className="suggest-list">
            {suggestions.map((s) => (
              <li key={s.item.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={chosen.has(s.item.id)}
                    onChange={() =>
                      setChosen((c) => {
                        const n = new Set(c)
                        if (n.has(s.item.id)) n.delete(s.item.id)
                        else n.add(s.item.id)
                        return n
                      })
                    }
                  />
                  <span className="suggest-name">{s.item.name}</span>
                  <span className="muted">→</span>
                  <span className="suggest-dest">{s.to}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="suggest-actions">
            <span className="muted">
              {picked.length ? `${txs} wallet approval${txs === 1 ? '' : 's'}` : 'nothing selected'}
            </span>
            <button className="btn small primary" disabled={busy || picked.length === 0} onClick={() => onApply(picked)}>
              Move {picked.length || ''} file{picked.length === 1 ? '' : 's'}
            </button>
          </div>
        </>
      )}
    </section>
  )
}
