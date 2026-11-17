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
            </div>
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
