// Files by category in the UI (D35): the Categories view (chips, then the
// chosen category's files from every folder), the dialog that puts files
// in a category, and the hook that groups the drive. The grouping is
// computed on this device (ai/categories.ts) from search entries the drive
// already holds; the only thing stored is what the user makes by hand: own
// categories and files put in or taken out (one listing, DriveCategories).

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DriveState, FileMeta } from '@0gdrive/core'
import { embedTexts } from './ai/client'
import { groupFiles, topicPhrases, TOPICS, type Category, type Grouping, type TopicVecs } from './ai/categories'
import { discover, groupable, nameFrom, type Found } from './ai/discover'
import { allFiles } from './SmartSearch'
import { closeOnBackdrop } from './backdrop'
import { Icon } from './icons'

export interface DriveGrouping {
  grouping: Grouping
  /** every file in the drive, by id, with the folder it's in */
  files: Map<string, { meta: FileMeta; folder: string }>
  /** topics need the text model: false while it loads, or with smart search off */
  topics: boolean
}

/**
 * The drive grouped: types always; topics and own categories by their
 * names once the text model is ready (smart search on); pins always.
 */
export function useCategories(drive: DriveState | null, smartOn: boolean, modelReady: boolean): DriveGrouping | null {
  const [topicVecs, setTopicVecs] = useState<TopicVecs | null>(null)
  // vectors are made while the model is ready; once made they stay in use
  // (the status reads "loading" again while the photo models load)
  const canEmbed = smartOn && modelReady
  const ready = smartOn
  useEffect(() => {
    if (!canEmbed || topicVecs) return
    let alive = true
    embedTexts(topicPhrases()).then((v) => alive && setTopicVecs(v), () => undefined)
    return () => {
      alive = false
    }
  }, [canEmbed, topicVecs])

  // own categories' names, embedded once each
  const nameVecs = useRef(new Map<string, Float32Array>())
  const [namesTick, setNamesTick] = useState(0)
  const ownNames = (drive?.categories?.own ?? []).map((c) => c.name)
  const missing = ownNames.filter((n) => !nameVecs.current.has(n))
  const missingKey = missing.join('\n')
  useEffect(() => {
    if (!canEmbed || !missingKey) return
    let alive = true
    const names = missingKey.split('\n')
    embedTexts(names).then(
      (vecs) => {
        names.forEach((n, i) => nameVecs.current.set(n, vecs[i]))
        if (alive) setNamesTick((t) => t + 1)
      },
      () => undefined
    )
    return () => {
      alive = false
    }
  }, [canEmbed, missingKey])

  return useMemo(() => {
    if (!drive) return null
    const files = new Map(allFiles(drive).map((f) => [f.meta.id, f]))
    // with smart search off, nothing the AI found: types and pins only
    const metas = [...files.values()].map(({ meta }) => (ready ? meta : { ...meta, search: undefined }))
    const own = new Map((drive.categories?.own ?? []).flatMap((c) => {
      const v = nameVecs.current.get(c.name)
      return v ? [[c.id, v] as const] : []
    }))
    const grouping = groupFiles(metas, drive.categories, ready ? topicVecs : null, ready ? own : null)
    return { grouping, files, topics: topicVecs !== null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drive, ready, topicVecs, namesTick])
}

// ─── Suggested categories (D37) ───────────────────────────────────────

export interface Suggestion {
  key: string
  name: string
  fileIds: string[]
}

/** Groups of files no category holds yet (types aren't about meaning: a group of PDFs is still new); not the dismissed. */
function findGroups(data: DriveGrouping, dismissed: Set<string>): Found[] {
  const { grouping, files } = data
  const inCategory = (id: string) => (grouping.of.get(id) ?? []).filter((c) => !c.startsWith('type:'))
  return discover([...files.values()].map(({ meta }) => meta), inCategory, (c) => grouping.files.get(c)?.length ?? 0).filter(
    (g) => !dismissed.has(g.key)
  )
}

/** After a change, the drive is looked at again this long after (a batch of uploads lands as one). */
const RECHECK_MS = 1500

/**
 * Categories found in the files themselves: groups of files close in
 * meaning (ai/discover.ts) that no category holds yet, each named by its
 * most distinctive words. Nothing is stored until one is kept. Looked for
 * on request, and again (quietly) when the files change (D38): groups new
 * or grown since the user last looked are counted in `fresh`, and an open
 * list is refreshed in place. The groups there when the drive opened count
 * as seen.
 */
export function useSuggestions(data: DriveGrouping | null) {
  const [list, setList] = useState<Suggestion[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fresh, setFresh] = useState(0)
  /** groups the user has seen (or that were there when the drive opened); null until the first look */
  const seen = useRef<Set<string> | null>(null)
  /** groups dismissed this visit */
  const dismissed = useRef(new Set<string>())
  const open = useRef(false)
  open.current = list !== null

  const run = async () => {
    if (!data) return
    setBusy(true)
    setError(null)
    try {
      const found = findGroups(data, dismissed.current)
      // every group's name candidates in one call to the model
      const all = found.flatMap((g) => g.candidates)
      const vecs = all.length ? await embedTexts(all) : []
      let at = 0
      setList(
        found.map((g) => {
          const mine = vecs.slice(at, (at += g.candidates.length))
          return { key: g.key, name: nameFrom(g, mine), fileIds: g.fileIds }
        })
      )
      seen.current = new Set([...(seen.current ?? []), ...found.map((g) => g.key)])
      setFresh(0)
    } catch (err) {
      setError(`Couldn’t look for categories: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  // the files that can be grouped, as they are now: a change here is worth another look
  const shape = useMemo(() => {
    if (!data?.topics) return null
    return [...data.files.values()]
      .filter(({ meta }) => groupable(meta))
      .map(({ meta }) => `${meta.id}:${meta.search!.e!.slice(0, 12)}`)
      .sort()
      .join(',')
  }, [data])
  const latest = useRef(data)
  latest.current = data
  const runRef = useRef(run)
  runRef.current = run
  useEffect(() => {
    if (shape === null) return
    const timer = setTimeout(() => {
      const d = latest.current
      if (!d) return
      const found = findGroups(d, dismissed.current)
      if (seen.current === null) {
        seen.current = new Set(found.map((g) => g.key)) // the drive as opened: nothing is new
        return
      }
      if (open.current) return void runRef.current()
      setFresh(found.filter((g) => !seen.current!.has(g.key)).length)
    }, RECHECK_MS)
    return () => clearTimeout(timer)
  }, [shape])

  return {
    list,
    busy,
    error,
    /** groups new or grown since the user last looked */
    fresh,
    run,
    drop: (key: string) => {
      dismissed.current.add(key)
      setList((l) => l?.filter((s) => s.key !== key) ?? null)
    },
    /** a group kept: it isn't new any more */
    kept: (key: string) => setList((l) => l?.filter((s) => s.key !== key) ?? null),
    close: () => {
      setList(null)
      setError(null)
    },
  }
}

/** The suggestions: each with its files and a name to edit before keeping it. */
function SuggestionsList({
  sug,
  files,
  nameProblem,
  onKeep,
}: {
  sug: ReturnType<typeof useSuggestions>
  files: DriveGrouping['files']
  nameProblem: (name: string) => string | null
  onKeep: (name: string, fileIds: string[]) => void
}) {
  const [names, setNames] = useState<Record<string, string>>({})
  const [open, setOpen] = useState<Record<string, boolean>>({})
  if (!sug.list && !sug.error) return null
  return (
    <div className="cat-suggest" role="region" aria-label="Suggested categories">
      <div className="cat-suggest-head">
        <h3 className="cat-group-title">Suggested categories</h3>
        <button className="btn small ghost" onClick={sug.close} aria-label="Close suggestions">
          <Icon name="close" />
        </button>
      </div>
      {sug.error ? (
        <p className="error-text">{sug.error}</p>
      ) : sug.list!.length === 0 ? (
        <p className="muted">No new groups found: your files fit the categories you have. Groups need 3 or more files with text read.</p>
      ) : (
        <>
          <p className="muted cat-suggest-note">Found in your files by the on-device AI. Names are a first guess: edit one, then keep it.</p>
          <ul className="cat-suggest-list">
            {sug.list!.map((s) => {
              const name = names[s.key] ?? s.name
              const problem = nameProblem(name)
              const metas = s.fileIds.flatMap((id) => files.get(id)?.meta ?? [])
              const shown = open[s.key] ? metas : metas.slice(0, 3)
              return (
                <li key={s.key} className="cat-suggest-card">
                  <input
                    className="key-input cat-suggest-name"
                    value={name}
                    maxLength={40}
                    onChange={(e) => setNames((n) => ({ ...n, [s.key]: e.target.value }))}
                    placeholder="Name this group"
                    aria-label="Category name"
                  />
                  <p className="cat-suggest-files muted">
                    {metas.length} files: {shown.map((m) => m.name).join(', ')}
                    {metas.length > shown.length && (
                      <>
                        {' '}
                        <button className="crumb" onClick={() => setOpen((o) => ({ ...o, [s.key]: true }))}>
                          +{metas.length - shown.length} more
                        </button>
                      </>
                    )}
                  </p>
                  {problem && name.trim() !== '' && <p className="cat-suggest-problem muted">{problem}</p>}
                  <div className="cat-suggest-actions">
                    <button className="btn small ghost" onClick={() => sug.drop(s.key)}>
                      Dismiss
                    </button>
                    <button
                      className="btn small primary"
                      disabled={problem !== null}
                      onClick={() => {
                        onKeep(name.trim(), s.fileIds)
                        sug.kept(s.key)
                      }}
                    >
                      Keep
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}

const KIND_TITLES: Record<Category['kind'], string> = { own: 'Your categories', topic: 'Topics', type: 'Types' }

/** One category's chip. */
function Chip({ c, selected, onSelect }: { c: Category & { count: number }; selected: boolean; onSelect: () => void }) {
  return (
    <button className={`chip${selected ? ' chip-on' : ''}${c.kind === 'own' ? ' chip-own' : ''}`} aria-pressed={selected} onClick={onSelect}>
      {c.kind === 'own' && <Icon name="tag" />}
      <span className="chip-name">{c.name}</span>
      <span className="chip-count">{c.count}</span>
    </button>
  )
}

export function CategoriesView({
  data,
  selected,
  onSelect,
  hint,
  canEdit,
  onNew,
  suggest,
  nameProblem,
  onKeep,
  onRename,
  onDelete,
  onTakeOut,
  renderThumb,
  onOpen,
  onGoToFolder,
  actions,
}: {
  data: DriveGrouping
  selected: string | null
  onSelect: (id: string | null) => void
  /** why there are no topics yet, if there aren't */
  hint: ReactNode
  canEdit: boolean
  onNew: () => void
  /** suggested categories; absent when they can't be found (smart search off, or its model not ready) */
  suggest?: ReturnType<typeof useSuggestions>
  nameProblem: (name: string) => string | null
  onKeep: (name: string, fileIds: string[]) => void
  onRename: (c: Category) => void
  onDelete: (c: Category) => void
  onTakeOut: (meta: FileMeta, c: Category) => void
  renderThumb: (meta: FileMeta) => ReactNode
  onOpen: (meta: FileMeta) => void
  onGoToFolder: (path: string) => void
  actions: (meta: FileMeta) => ReactNode
}) {
  const { grouping, files } = data
  const cat = grouping.categories.find((c) => c.id === selected) ?? null
  const shown = cat ? (grouping.files.get(cat.id) ?? []).flatMap((id) => files.get(id) ?? []) : []
  const kinds = (['own', 'topic', 'type'] as const).map((k) => ({ k, cats: grouping.categories.filter((c) => c.kind === k) }))

  return (
    <section className="files categories">
      <h2>Categories</h2>
      {hint && <p className="cat-hint muted">{hint}</p>}
      {kinds.map(({ k, cats }) =>
        cats.length === 0 && !(k === 'own' && canEdit) ? null : (
          <div key={k} className="cat-group">
            <h3 className="cat-group-title">{KIND_TITLES[k]}</h3>
            <div className="chips" role="group" aria-label={KIND_TITLES[k]}>
              {cats.map((c) => (
                <Chip key={c.id} c={c} selected={c.id === selected} onSelect={() => onSelect(c.id === selected ? null : c.id)} />
              ))}
              {k === 'own' && canEdit && (
                <button className="chip chip-new" onClick={onNew}>
                  <Icon name="plus" />
                  New category
                </button>
              )}
              {k === 'own' && canEdit && suggest && (
                <button className="chip chip-new" onClick={() => void suggest.run()} disabled={suggest.busy}>
                  <Icon name="sparkles" />
                  {suggest.busy ? 'Looking…' : 'Suggest categories'}
                  {!suggest.busy && suggest.fresh > 0 && <span className="chip-count chip-fresh">{suggest.fresh} new</span>}
                </button>
              )}
            </div>
            {k === 'own' && canEdit && suggest && <SuggestionsList sug={suggest} files={files} nameProblem={nameProblem} onKeep={onKeep} />}
          </div>
        )
      )}

      {cat && (
        <div className="cat-files">
          <div className="cat-files-head">
            <h3>
              {cat.name} <span className="count">{shown.length}</span>
            </h3>
            {cat.kind === 'own' && canEdit && (
              <div className="cat-own-actions">
                <button className="btn small ghost" onClick={() => onRename(cat)}>
                  <Icon name="rename" />
                  Rename
                </button>
                <button className="btn small ghost danger" onClick={() => onDelete(cat)}>
                  <Icon name="trash" />
                  Delete
                </button>
              </div>
            )}
          </div>
          {shown.length === 0 ? (
            <p className="empty">
              No files yet. Select files in a folder, then <strong>Add to category</strong>.
            </p>
          ) : (
            <ul className="results">
              {shown.map(({ meta, folder }) => (
                <li key={meta.id} className="result">
                  <button className="result-thumb" onClick={() => onOpen(meta)} tabIndex={-1} aria-hidden="true">
                    {renderThumb(meta)}
                  </button>
                  <div className="result-main">
                    <button className="fname-btn" onClick={() => onOpen(meta)}>
                      {meta.name}
                    </button>
                    <div className="result-meta muted">
                      in{' '}
                      <button className="crumb result-folder" onClick={() => onGoToFolder(folder)}>
                        {folder === '' ? 'My drive' : folder}
                      </button>
                    </div>
                  </div>
                  <div className="row-actions">
                    {actions(meta)}
                    {canEdit && cat.kind !== 'type' && (
                      <button
                        className="btn small"
                        onClick={() => onTakeOut(meta, cat)}
                        title={`Take out of ${cat.name}`}
                        aria-label={`Take out of ${cat.name}`}
                      >
                        <Icon name="minus" className="btn-ico" />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

/** Put files in a category: one of the user's own or a topic, or a new one named here. */
export function CategorizeDialog({
  count,
  own,
  onPick,
  onNew,
  onClose,
}: {
  count: number
  own: { id: string; name: string }[]
  onPick: (id: string, name: string) => void
  onNew: (name: string) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const taken = [...own, ...TOPICS].some((c) => c.name.toLowerCase() === name.trim().toLowerCase())
  return (
    <div className="modal-backdrop" {...closeOnBackdrop(onClose)}>
      <div className="modal categorize-modal" role="dialog" aria-label="Add to category" onClick={(e) => e.stopPropagation()}>
        <h3>
          Add {count === 1 ? '1 file' : `${count} files`} to a category
        </h3>
        <form
          className="cat-new-row"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim() && !taken) onNew(name.trim())
          }}
        >
          <input
            className="key-input"
            placeholder="New category, e.g. Blockchain"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            aria-label="New category name"
          />
          <button className="btn primary" type="submit" disabled={!name.trim() || taken}>
            Create &amp; add
          </button>
        </form>
        {taken && <p className="muted">There’s a category with that name: pick it below.</p>}
        {(['own', 'topic'] as const).map((k) => {
          const cats = k === 'own' ? own : TOPICS
          return cats.length === 0 ? null : (
            <div key={k} className="cat-group">
              <h4 className="cat-group-title">{KIND_TITLES[k]}</h4>
              <div className="chips">
                {cats.map((c) => (
                  <button key={c.id} className={`chip${k === 'own' ? ' chip-own' : ''}`} onClick={() => onPick(c.id, c.name)}>
                    {k === 'own' && <Icon name="tag" />}
                    <span className="chip-name">{c.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )
        })}
        <div className="modal-actions">
          <button className="btn ghost" type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
