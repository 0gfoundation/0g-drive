// Phase 1 AI in the UI: drive-wide search, background indexing of files
// that have no search entry, and organize suggestions. Everything is
// computed on this device; the only chain writes are the (batched)
// folder-manifest updates the user approves.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { DriveState, DriveStore, FileMeta, SearchEntry } from '@0gdrive/core'
import {
  embedSearchQuery,
  embedTexts,
  indexFile,
  isPhone,
  needsContent,
  PHONE_MEMORY_WARNING,
  setSmartSearchEnabled,
  smartSearchEnabled,
  subscribeModelStatus,
  prefetchPhotoModels,
  describeModelStatus,
  modelErrorReason,
  type ModelStatus,
} from './ai/client'
import { rank, suggestMoves, type MoveSuggestion } from './ai/searchcore'
import { addPendingSearch, pendingSearch, prunePendingSearch, subscribePendingSearch } from './searchPending'

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
  /** a drive opened with its recovery password: nothing can be saved */
  readOnly: boolean
  /** something else is using the network or the wallet (an upload, a preview, a change) */
  paused: boolean
}

const lastSegment = (path: string) => path.split('/').pop() ?? path

/** A file's search entry: its saved one, else one made on this device and not saved yet. */
function searchOf(meta: FileMeta): SearchEntry | undefined {
  if (meta.search) return meta.search
  const p = pendingSearch().get(meta.id)
  return p && p.name === meta.name ? p.entry : undefined
}

/** Every file in the drive (not the trash), with this device's unsaved search entries filled in. */
function allFiles(drive: DriveState): { meta: FileMeta; folder: string }[] {
  const out: { meta: FileMeta; folder: string }[] = []
  for (const [path, folder] of drive.folders) {
    for (const meta of folder?.files ?? []) {
      const search = searchOf(meta)
      out.push({ meta: search === meta.search ? meta : { ...meta, search }, folder: path })
    }
  }
  return out
}

/** Indexed by name only, though its content is what search is for (couldn't be read or had no text). */
const nameOnly = (meta: FileMeta, e: SearchEntry) => !e.t && !e.c && needsContent(meta.name, meta.mime, meta.size)

/** Between background-indexed files, so the page stays responsive. */
const INDEX_GAP_MS = 400

export function useSmartDrive({ drive, storeRef, currentPath, loadBytes, reloadDrive, log, setBusy, readOnly, paused }: Deps) {
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
  /** bumped when this device's unsaved search entries change */
  const [pendingTick, setPendingTick] = useState(0)
  useEffect(() => subscribePendingSearch(() => setPendingTick((t) => t + 1)), [])

  useEffect(() => subscribeModelStatus(setModel), [])
  // a load failure, in Activity too: readable on phones, which show no tooltips
  useEffect(() => {
    if (model.error && enabled) log(`Smart search models failed to load (${modelErrorReason(model.error)}).`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.error])

  // start the one-time model download as soon as a drive is open
  const driveOpen = drive !== null
  // (the text model, then the photo models' files: downloaded, not loaded)
  useEffect(() => {
    if (enabled && driveOpen) prefetchPhotoModels()
  }, [enabled, driveOpen])

  const toggle = useCallback((on: boolean) => {
    if (on && isPhone() && !window.confirm(PHONE_MEMORY_WARNING)) return
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drive, enabled, log, pendingTick]
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

  // ─── Background indexing ────────────────────────────────────────────
  //
  // Files with no search entry anywhere in the drive (uploaded with smart
  // search off, before the models were ready, or from another device) are
  // indexed here one at a time while nothing else runs. The entries are
  // kept on this device (searchPending.ts) and search uses them at once;
  // they're saved with the next change the user approves, or with Save.

  // what the drive as loaded already has drops out
  useEffect(() => {
    if (drive) prunePendingSearch(drive)
  }, [drive])

  /** files that couldn't be indexed this visit (not retried until a reload) */
  const failed = useRef(new Set<string>())
  const [indexing, setIndexing] = useState<string | null>(null)
  const [indexTick, setIndexTick] = useState(0)
  const modelsOk = !model.loading && !model.error
  const runIndexer = enabled && !readOnly && !paused && modelsOk && drive !== null

  useEffect(() => {
    if (!runIndexer || !drive) return
    const pending = pendingSearch()
    const next = allFiles(drive).find((f) => !f.meta.search && !pending.has(f.meta.id) && !failed.current.has(f.meta.id))
    if (!next) return
    let alive = true
    const timer = setTimeout(async () => {
      const { meta, folder } = next
      setIndexing(meta.name)
      try {
        let blob = new Blob([])
        if (needsContent(meta.name, meta.mime, meta.size)) {
          try {
            blob = new Blob([(await loadBytes(meta)) as unknown as BlobPart], { type: meta.mime })
          } catch {
            // unreadable now: its name only, like an upload that couldn't be read
          }
        }
        const entry = await indexFile(blob, meta.name, meta.mime, meta.thumb)
        const id = folder === '' ? '' : drive.tree.idOf(folder)
        if (entry && id !== null) addPendingSearch(meta.id, { entry, name: meta.name, folder: id })
        else failed.current.add(meta.id)
      } catch {
        failed.current.add(meta.id)
      } finally {
        setIndexing(null)
        if (alive) setIndexTick((t) => t + 1)
      }
    }, INDEX_GAP_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runIndexer, drive, indexTick])

  const index = { unsaved: 0, remaining: 0, nameOnly: 0, working: indexing }
  for (const folder of drive?.folders.values() ?? []) {
    for (const f of folder?.files ?? []) {
      const e = searchOf(f)
      if (e && !f.search) index.unsaved++ // indexed on this device, not saved in the drive yet
      if (!e && enabled && !failed.current.has(f.id)) index.remaining++ // the indexer works through these
      if (e && nameOnly(f, e)) index.nameOnly++
    }
  }
  void pendingTick // the counts read the pending entries

  const [saving, setSaving] = useState(false)
  const saveIndex = useCallback(async () => {
    const store = storeRef.current
    if (!store) return
    const n = pendingSearch().size
    setSaving(true)
    setBusy('Saving the search index…')
    log(`Saving the search index for ${n} file${n === 1 ? '' : 's'}…`)
    try {
      await store.saveSearchEntries()
      await reloadDrive()
      log('Search index saved.')
    } catch (err) {
      log(`Saving the search index failed: ${(err as Error).message}`)
    } finally {
      setSaving(false)
      setBusy(null)
    }
  }, [storeRef, reloadDrive, log, setBusy])

  // ─── Organize suggestions ───────────────────────────────────────────

  const findSuggestions = useCallback(async () => {
    if (!drive) return
    setSuggesting(true)
    try {
      const paths = [...drive.folders.keys()]
      const named = paths.filter((p) => p !== '')
      const nameVecs = named.length ? await embedTexts(named.map(lastSegment)) : []
      const withEntries = allFiles(drive)
      const folders = paths.map((path) => ({
        path,
        files: withEntries.filter((f) => f.folder === path).map((f) => f.meta),
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
      setBusy('Moving files…')
      log(`Moving ${chosen.length} file${chosen.length === 1 ? '' : 's'}…`)
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
    index,
    saving,
    saveIndex,
    suggestions,
    suggesting,
    findSuggestions,
    applySuggestions,
    dismissSuggestions: () => setSuggestions(null),
    retryModels: () => prefetchPhotoModels(),
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
        placeholder="Search your drive — English or 中文"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onClear()}
        aria-label="Search your drive"
      />
      {model.loading ? (
        <span
          className="searchbox-status"
          title={`One-time download of the on-device search models (~250 MB), cached by your browser afterwards.${
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
          title={`Search models failed to load (${modelErrorReason(model.error)}). Search matches file names until they do.`}
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
              {picked.length ? 'no wallet prompt' : 'nothing selected'}
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
