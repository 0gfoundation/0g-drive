// Changes to the drive, shown at once and stored one at a time.
//
// DriveStore changes read a folder, change it and write it back, so two at
// once would lose one: they run here in order, one after another. Each is
// shown the moment it's made (`shows`, applied over the drive as last
// loaded); when nothing is left to store, the drive is loaded again and the
// changes shown are dropped, as the drive now has them. One that fails is
// dropped at once, so what it changed is shown as it was.
//
// `shows` must give the same result over a drive that already has the
// change (a reload can land before it's dropped): remove what's there, add
// what isn't.
import { useCallback, useMemo, useRef, useState } from 'react'
import { TRASH_PATH, type DriveState, type FileMeta, type FolderManifest } from '@0gdrive/core'

export interface Change {
  /** what's being stored, for the progress line ("Moving a.txt to trash…") */
  label: string
  /** the drive with this change, shown until the drive is loaded again */
  shows?: (d: DriveState) => DriveState
  /** stores it */
  run: () => Promise<void>
  /** after it failed (the change shown is already gone) */
  failed?: (err: Error) => void
}

export interface Queued {
  /** settles when it's stored (rejects with its error) */
  done: Promise<void>
  /** drop it if it hasn't started: true if dropped */
  cancel: () => boolean
}

interface Entry {
  change: Change
  state: 'waiting' | 'running' | 'stored' | 'dropped'
}

/**
 * The change queue over the drive as last loaded (`loaded`): `drive` is it
 * with the changes not loaded back yet; `working` names what's being stored
 * (null when nothing is).
 */
export function useChanges(loaded: DriveState | null, load: () => Promise<DriveState | null>, setLoaded: (d: DriveState) => void) {
  const entries = useRef<Entry[]>([])
  const [version, setVersion] = useState(0)
  const [working, setWorking] = useState<string | null>(null)
  const chain = useRef<Promise<void>>(Promise.resolve())
  /** something was stored (or tried) since the drive was last loaded */
  const reload = useRef(false)
  const bump = () => setVersion((v) => v + 1)
  const remove = (gone: (e: Entry) => boolean) => {
    entries.current = entries.current.filter((e) => !gone(e))
    bump()
  }

  const add = useCallback(
    (change: Change): Queued => {
      const entry: Entry = { change, state: 'waiting' }
      entries.current = [...entries.current, entry]
      bump()
      setWorking((w) => w ?? change.label)
      const done = chain.current.then(async () => {
        try {
          if (entry.state === 'dropped') return
          entry.state = 'running'
          setWorking(change.label)
          reload.current = true
          try {
            await change.run()
            entry.state = 'stored'
          } catch (err) {
            remove((e) => e === entry)
            change.failed?.(err as Error)
            throw err
          }
        } finally {
          if (entries.current.some((e) => e.state === 'waiting' || e.state === 'running')) {
            // the next one runs
          } else if (!reload.current) {
            setWorking(null) // only dropped ones since the last reload
          } else {
            reload.current = false
            // all stored: the drive as it is now, in place of the changes shown
            setWorking('Saving…')
            const stored = new Set(entries.current.filter((e) => e.state === 'stored'))
            const next = await load().catch((err) => (console.warn('[drive] reload after changes', err), null))
            if (next) {
              setLoaded(next)
              remove((e) => stored.has(e))
            }
            if (!entries.current.some((e) => e.state !== 'stored')) setWorking(null)
          }
        }
      })
      chain.current = done.catch(() => undefined)
      return {
        done,
        cancel: () => {
          if (entry.state !== 'waiting') return false
          entry.state = 'dropped'
          remove((e) => e === entry)
          return true
        },
      }
    },
    [load, setLoaded]
  )

  const drive = useMemo(
    () => (loaded === null ? null : entries.current.reduce((s, e) => e.change.shows?.(s) ?? s, loaded)),
    [loaded, version]
  )
  return { add, drive, working }
}

// ─── Changes as shown ─────────────────────────────────────────────────

const emptyFolder = (d: DriveState, path: string): FolderManifest => ({
  path: d.tree.idOf(path) ?? path,
  files: [],
  updatedAt: Date.now(),
  version: 0,
})

/** `d` with the folder at `path` ('' = root, TRASH_PATH = trash) changed by `edit`. */
function withFolder(d: DriveState, path: string, edit: (files: FileMeta[]) => FileMeta[]): DriveState {
  if (path === TRASH_PATH) {
    const trash = d.trash ?? { path: TRASH_PATH, files: [], updatedAt: Date.now(), version: 0 }
    return { ...d, trash: { ...trash, files: edit(trash.files) } }
  }
  // a folder not in the drive (gone, or new and not loaded yet): it shows after the reload
  if (path !== '' && !d.folders.has(path)) return d
  const folder = d.folders.get(path) ?? emptyFolder(d, path)
  const folders = new Map(d.folders)
  folders.set(path, { ...folder, files: edit(folder.files) })
  return { ...d, folders }
}

const without = (ids: Set<string>) => (files: FileMeta[]) => files.filter((f) => !ids.has(f.id))
const adding = (records: FileMeta[]) => (files: FileMeta[]) => {
  const have = new Set(files.map((f) => f.id))
  return [...files, ...records.filter((r) => !have.has(r.id))]
}

/** `metas` moved from `path` to trash. */
export function showTrashed(d: DriveState, path: string, metas: FileMeta[]): DriveState {
  const ids = new Set(metas.map((m) => m.id))
  const now = Date.now()
  const records = metas.map((m) => ({ ...m, originalPath: path, trashedAt: m.trashedAt ?? now }))
  return withFolder(withFolder(d, path, without(ids)), TRASH_PATH, adding(records))
}

/** `metas` restored from trash to the folders they came from. */
export function showRestored(d: DriveState, metas: FileMeta[]): DriveState {
  let s = withFolder(d, TRASH_PATH, without(new Set(metas.map((m) => m.id))))
  for (const m of metas) {
    const { originalPath, originalFolder: _f, trashedAt: _t, ...clean } = m
    s = withFolder(s, originalPath ?? '', adding([clean]))
  }
  return s
}

/** `ids` deleted forever from trash. */
export function showDeleted(d: DriveState, ids: string[]): DriveState {
  return withFolder(d, TRASH_PATH, without(new Set(ids)))
}

/** `metas` moved from folder `from` to folder `to`. */
export function showMoved(d: DriveState, from: string, metas: FileMeta[], to: string): DriveState {
  return withFolder(withFolder(d, from, without(new Set(metas.map((m) => m.id)))), to, adding(metas))
}

/** The file `id` in folder `path` named `name`. */
export function showRenamed(d: DriveState, path: string, id: string, name: string): DriveState {
  return withFolder(d, path, (files) => files.map((f) => (f.id === id ? { ...f, name } : f)))
}
