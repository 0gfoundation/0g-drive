import type { FileMeta, SearchEntry } from './types.js'
import {
  ROOT_ID,
  TRASH_PATH,
  folderTag,
  indexTag,
  type DriveIndex,
  type FolderManifest,
} from './manifest.js'
import { FolderTree } from './tree.js'
import type { DriveBackend, ManifestWrite } from './backend.js'

export interface DriveState {
  /** Every folder's path (not the root), parents before children. */
  paths: string[]
  tree: FolderTree
  /** Folder manifests by path ('' = root); null = no files yet. */
  folders: Map<string, FolderManifest | null>
  trash: FolderManifest | null
}

/** A file given a new name on the way (see uniqueName). */
export interface Renamed {
  id: string
  from: string
  to: string
}

/** The index as loaded: its tree, and the version the next write bumps. */
interface LoadedIndex {
  tree: FolderTree
  version: number
}

/** The drive's own options. */
export interface DriveStoreOpts {
  /**
   * Search entries made on this device and not saved yet, by file id. Any
   * folder listing written gets them for its files that have none; other
   * folders holding some ride along in the same change (see
   * searchSaveItems), so saving them needs no change of its own.
   */
  pendingSearch?: () => ReadonlyMap<string, PendingSearchEntry>
}

/** A search entry made on this device, not saved in its folder's listing yet. */
export interface PendingSearchEntry {
  entry: SearchEntry
  /** the file's name when indexed: a file renamed since is indexed again instead */
  name: string
  /** the id of the folder it was in */
  folder: string
}

/** At most this many folders' listings ride along with one change to save search entries. */
const SEARCH_SAVE_FOLDERS = 20

/** Parallel folder-manifest downloads when a drive loads. */
const LOAD_CONCURRENCY = 6

function normalizePath(path: string): string {
  const p = path.replace(/^\/+|\/+$/g, '')
  if (p === TRASH_PATH) throw new Error(`"${TRASH_PATH}" is a reserved path`)
  if (
    p.length > 0 &&
    p.split('/').some((seg) => seg.length === 0 || seg === '.' || seg === '..')
  ) {
    throw new Error(`Invalid folder path: "${path}"`)
  }
  return p // '' = the drive root
}

export const MAX_FILE_NAME = 255

/** Why `name` (already trimmed) can't be a file name, or null if it can. */
export function fileNameProblem(name: string): string | null {
  if (name === '') return 'The name can’t be empty.'
  if (name.includes('/')) return 'The name can’t contain “/”.'
  if (name === '.' || name === '..') return 'That name is reserved.'
  if (name.length > MAX_FILE_NAME) return `The name can be at most ${MAX_FILE_NAME} characters.`
  return null
}

/** Why `name` (already trimmed) can't be a folder name, or null if it can. */
export function folderNameProblem(name: string): string | null {
  if (name === TRASH_PATH) return 'That name is reserved.'
  return fileNameProblem(name)
}

/**
 * `name`, or the first free "name (1).ext", "name (2).ext", … given the
 * names already `taken` (lower case). A name that already ends in " (n)"
 * is numbered from its stem, so "a (1).txt" next to itself becomes "a (2).txt".
 */
export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name
  const dot = name.lastIndexOf('.')
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  const stem = /^(.*) \(\d+\)$/.exec(base)?.[1] ?? base
  for (let n = 1; ; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

const emptyFolder = (key: string): FolderManifest => ({ path: key, files: [], updatedAt: 0, version: 0 })

/**
 * Serverless drive metadata: encrypted manifest files, stored and found by
 * a DriveBackend (V2: listings named by a root, docs/decisions.md D18).
 *
 * All mutations store a new manifest version — one per touched folder,
 * plus the index when the folder tree changes; one change in all.
 *
 * The public API takes folder paths; the index's tree maps each path to
 * the folder's permanent id, which is what its manifest is keyed by.
 */
const DAY_MS = 24 * 60 * 60 * 1000
/** Days a file stays in trash before it's deleted forever. */
export const TRASH_DAYS = 30

export class DriveStore {
  constructor(
    /** where the drive's data lives (V2Backend), encrypted with the drive key */
    readonly backend: DriveBackend,
    private opts: DriveStoreOpts = {}
  ) {}

  /** Bring the backend's view of the drive up to date. */
  refresh(): Promise<void> {
    return this.backend.refresh()
  }

  /**
   * Whether the drive changed since this device last looked (a change from
   * another device): one quick check, and the backend now knows the change.
   */
  async changedElsewhere(): Promise<boolean> {
    const before = this.backend.version()
    await this.backend.refresh()
    return this.backend.version() !== before
  }

  private async readManifest<T>(key: string): Promise<T | null> {
    const text = await this.backend.readManifest(key)
    return text === null ? null : (JSON.parse(text) as T)
  }

  private async loadIndex(): Promise<LoadedIndex> {
    const index = await this.readManifest<DriveIndex>(indexTag())
    if (!index) return { tree: new FolderTree(), version: 0 }
    return { tree: FolderTree.fromIndex(index), version: index.version }
  }

  /** The index write for `index` as it stands (v2), as a batch item. */
  private indexItem(index: LoadedIndex): ManifestWrite {
    const stored: DriveIndex = { v: 2, folders: index.tree.nodes, updatedAt: Date.now(), version: index.version + 1 }
    return this.manifestItem(stored, indexTag())
  }

  /** The folder id at `path`, or an error saying it's gone. */
  private folderId(index: LoadedIndex, path: string): string {
    const id = index.tree.idOf(path)
    if (id === null) throw new Error(`The folder "${path}" no longer exists. Reload and try again.`)
    return id
  }

  private async loadFolder(key: string): Promise<FolderManifest | null> {
    const folder = await this.readManifest<FolderManifest>(folderTag(key))
    if (folder) this.backend.fixRecords(folder.files)
    return folder
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /** Load the whole drive state from storage (fresh read). */
  async loadDrive(): Promise<DriveState> {
    await this.backend.refresh(true)
    const { tree } = await this.loadIndex()
    const paths = tree.paths()
    // folders are independent downloads: fetch them a few at a time
    const keys = [ROOT_ID, ...paths.map((p) => tree.idOf(p)!), TRASH_PATH]
    const loaded: (FolderManifest | null)[] = new Array(keys.length)
    let next = 0
    const worker = async () => {
      while (next < keys.length) {
        const i = next++
        loaded[i] = await this.loadFolder(keys[i])
      }
    }
    await Promise.all(Array.from({ length: Math.min(LOAD_CONCURRENCY, keys.length) }, worker))
    const folders = new Map<string, FolderManifest | null>()
    ;['', ...paths].forEach((p, i) => folders.set(p, loaded[i]))
    const trash = loaded[keys.length - 1]
    // show where trashed files came from as that folder is named now
    for (const rec of trash?.files ?? []) {
      const now = tree.has(originFolder(rec)) ? tree.pathOf(originFolder(rec)) : null
      if (now !== null) rec.originalPath = now
    }
    return { paths, tree, folders, trash }
  }

  private async writeIndex(index: LoadedIndex): Promise<void> {
    await this.writeManifests([], [this.indexItem(index)], '')
  }

  /** Add or update a file record in a folder (creates the folder if new). */
  async putFileRecord(folderPath: string, meta: FileMeta): Promise<void> {
    await this.putFileRecords(folderPath, [meta])
  }

  /**
   * Add or update multiple file records in one folder manifest upload —
   * ONE change for the whole batch. Files themselves are already uploaded by the caller.
   */
  async putFileRecords(folderPath: string, metas: FileMeta[], replace: string[] = []): Promise<void> {
    const items = await this.prepareFileRecords(folderPath, metas, replace)
    // a new folder's index entry (and the trash, when replacing) first: a
    // failure after it leaves an empty folder or a record listed twice,
    // never a listing no folder points to or a record listed nowhere
    await this.writeManifests(
      items.slice(0, -1),
      items.slice(-1),
      'the folder was created but the files are not listed in it yet. Upload them again to finish.'
    )
  }

  /**
   * The manifest write(s) for adding `metas` to a folder, as batch items
   * instead of uploads — so they can ride in the same change as the
   * files themselves (storage.uploadBatch → finalize). Same contents as
   * putFileRecords would write: the index first if the folder is new, the
   * trash if `replace` moves files there, then the folder.
   *
   * `replace`: ids of files in the folder the new ones take the place of;
   * they move to trash in the same write. Names stay unique in a folder
   * (ignoring case): a new file whose name is still taken — e.g. a file of
   * that name was added from another device meanwhile — gets "name (1).ext",
   * and `metas` are updated to the names stored.
   */
  async prepareFileRecords(folderPath: string, metas: FileMeta[], replace: string[] = []): Promise<ManifestWrite[]> {
    const path = normalizePath(folderPath)
    await this.refresh()
    const index = await this.loadIndex()
    const { id, created } = index.tree.ensure(path)
    const folder = (created ? null : await this.loadFolder(id)) ?? emptyFolder(id)
    const replaced = folder.files.filter((f) => replace.includes(f.id))
    folder.files = folder.files.filter((f) => !replace.includes(f.id))
    for (const meta of metas) {
      const idx = folder.files.findIndex((f) => f.id === meta.id)
      if (idx >= 0) {
        folder.files[idx] = meta
        continue
      }
      meta.name = uniqueName(meta.name, new Set(folder.files.map((f) => f.name.toLowerCase())))
      folder.files.push(meta)
    }
    folder.updatedAt = Date.now()
    folder.version += 1
    const out: ManifestWrite[] = created ? [this.indexItem(index)] : []
    if (replaced.length > 0) {
      const trash = await this.trashWith(replaced.map((rec) => ({ ...rec, originalPath: path, originalFolder: id })))
      out.push(this.manifestItem(trash, folderTag(TRASH_PATH)))
    }
    out.push(this.manifestItem(folder, folderTag(id)))
    return out
  }

  /** Remove a file record; by default it moves to trash. */
  async removeFileRecord(
    folderPath: string,
    id: string,
    toTrash = true
  ): Promise<void> {
    await this.removeFileRecords(folderPath, [id], toTrash)
  }

  /**
   * Remove file records from one folder: the folder's listing, plus the
   * trash's when they go to trash, in one change. Trash is stored first, so a failure part-way leaves a file in both
   * places, never in neither.
   */
  async removeFileRecords(
    folderPath: string,
    ids: string[],
    toTrash = true
  ): Promise<void> {
    if (ids.length === 0) return
    await this.refresh()
    let path: string
    let key: string
    if (folderPath === TRASH_PATH) {
      if (toTrash) throw new Error('Files in trash are already in trash')
      path = key = TRASH_PATH
    } else {
      path = normalizePath(folderPath)
      key = this.folderId(await this.loadIndex(), path)
    }

    const folder = await this.loadFolder(key)
    if (folder === null) return
    const removed = folder.files.filter((f) => ids.includes(f.id))
    if (removed.length === 0) return

    folder.files = folder.files.filter((f) => !ids.includes(f.id))
    folder.updatedAt = Date.now()
    folder.version += 1
    const first: ManifestWrite[] = []
    if (toTrash) {
      const trash = await this.trashWith(removed.map((rec) => ({ ...rec, originalPath: path, originalFolder: key })))
      first.push(this.manifestItem(trash, folderTag(TRASH_PATH)))
    }
    await this.writeManifests(
      first,
      [this.manifestItem(folder, folderTag(key))],
      'the files were added to trash but are still listed in their folder too. Move them to trash again to finish.'
    )
    if (!toTrash) await this.backend.discard(removed)
  }

  /**
   * Rename a file: one folder-manifest write (one change). The blob
   * doesn't change — names live only in the encrypted manifest. `search`
   * replaces the record's search entry (recomputed for the new name by
   * the caller); left out, the old entry is kept. Refuses an invalid name
   * or one already used in the folder (ignoring case).
   */
  async renameFile(
    folderPath: string,
    id: string,
    newName: string,
    search?: SearchEntry
  ): Promise<FileMeta> {
    const path = normalizePath(folderPath)
    const name = newName.trim()
    const problem = fileNameProblem(name)
    if (problem) throw new Error(problem)
    await this.refresh()

    const key = this.folderId(await this.loadIndex(), path)
    const folder = await this.loadFolder(key)
    const rec = folder?.files.find((f) => f.id === id)
    if (!folder || !rec) throw new Error('That file is no longer in this folder. Reload and try again.')
    if (rec.name === name) return rec
    if (folder.files.some((f) => f.id !== id && f.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`There is already a file named "${name}" in this folder.`)
    }
    rec.name = name
    if (search) rec.search = search
    folder.updatedAt = Date.now()
    folder.version += 1
    await this.writeManifests([], [this.manifestItem(folder, folderTag(key))], '')
    return rec
  }

  /** Create a folder and any missing parents (index only; the manifest
   *  materializes on the first file). */
  async createFolder(folderPath: string): Promise<void> {
    const path = normalizePath(folderPath)
    if (path === '') return // the root always exists
    for (const name of path.split('/')) {
      const problem = folderNameProblem(name)
      if (problem) throw new Error(problem)
    }
    await this.refresh()
    const index = await this.loadIndex()
    if (index.tree.ensure(path).created) await this.writeIndex(index)
  }

  /** Remove an empty folder (no files, no subfolders) from the index. */
  async removeFolder(folderPath: string): Promise<void> {
    const path = normalizePath(folderPath)
    if (path === '') throw new Error('The drive root cannot be removed')
    await this.refresh()
    const index = await this.loadIndex()
    const id = index.tree.idOf(path)
    if (id === null) return
    const folder = await this.loadFolder(id)
    if ((folder !== null && folder.files.length > 0) || index.tree.children(id).length > 0) {
      throw new Error(`Folder "${path}" is not empty — trash its files first`)
    }
    index.tree.remove([id])
    await this.writeIndex(index)
  }

  /**
   * Move a folder and everything inside it (including all descendant
   * folders) to trash, in one change:
   *   1. trash manifest update — all file records, each tagged with its
   *      original folder (restorable individually); stored first
   *   2. index update — the folder and its descendants leave the tree
   * Folder manifests are NOT rewritten: no tree node points to them any
   * more, and a folder made later under the same name gets a new id, so
   * they are never loaded again. Empty descendant folders are not
   * preserved.
   */
  async trashFolder(folderPath: string): Promise<void> {
    const path = normalizePath(folderPath)
    if (path === '') throw new Error('The drive root cannot be deleted')
    await this.refresh()

    const index = await this.loadIndex()
    const id = this.folderId(index, path)
    const affected = index.tree.subtree(id)

    const records: FileMeta[] = []
    for (const f of affected) {
      const manifest = await this.loadFolder(f)
      for (const rec of manifest?.files ?? []) {
        records.push({ ...rec, originalPath: index.tree.pathOf(f) ?? path, originalFolder: f })
      }
    }

    const first: ManifestWrite[] = []
    if (records.length > 0) {
      first.push(this.manifestItem(await this.trashWith(records), folderTag(TRASH_PATH)))
    }
    index.tree.remove(affected)
    await this.writeManifests(
      first,
      [this.indexItem(index)],
      'the files were added to trash but the folder still shows. Delete it again to finish.'
    )
  }

  /**
   * Rename a folder: one index write (one change), however many files
   * and subfolders it holds — manifests are tagged by folder id, not path.
   * Refuses an invalid name or one a sibling folder already has (ignoring
   * case). Returns the folder's new path.
   */
  async renameFolder(folderPath: string, newName: string): Promise<string> {
    const path = normalizePath(folderPath)
    if (path === '') throw new Error('The drive root cannot be renamed')
    const name = newName.trim()
    const problem = folderNameProblem(name)
    if (problem) throw new Error(problem)
    await this.refresh()

    const index = await this.loadIndex()
    const id = this.folderId(index, path)
    const node = index.tree.get(id)!
    if (node.name === name) return path
    const clash = index.tree.child(node.parent, name, true)
    if (clash && clash.id !== id) throw new Error(`There is already a folder named "${clash.name}" here.`)
    index.tree.rename(id, name)
    await this.writeIndex(index)
    return index.tree.pathOf(id)!
  }

  /**
   * Move a folder (with everything inside it) into another folder, '' for
   * the top level: one index write (one change) — manifests are
   * tagged by folder id, not path. A destination that doesn't exist yet is
   * created in the same write. Refuses a move into the folder itself or a
   * folder inside it, and a destination that already has a folder of that
   * name (ignoring case). Returns the folder's new path.
   */
  async moveFolder(folderPath: string, toParentPath: string): Promise<string> {
    const path = normalizePath(folderPath)
    const to = normalizePath(toParentPath)
    if (path === '') throw new Error('The drive root cannot be moved')
    await this.refresh()

    const index = await this.loadIndex()
    const id = this.folderId(index, path)
    const node = index.tree.get(id)!
    const existing = index.tree.idOf(to)
    if (existing !== null && index.tree.subtree(id).includes(existing)) {
      throw new Error('A folder can’t be moved into itself or a folder inside it.')
    }
    if (existing === node.parent) return path
    const dest = index.tree.ensure(to).id
    const clash = index.tree.child(dest, node.name, true)
    if (clash && clash.id !== id) {
      throw new Error(`There is already a folder named "${clash.name}" in ${to === '' ? 'My drive' : `"${to}"`}.`)
    }
    index.tree.move(id, dest)
    await this.writeIndex(index)
    return index.tree.pathOf(id)!
  }

  /** Restore a trashed file record to its original folder (or a given one). */
  async restoreFromTrash(id: string, targetPath?: string): Promise<Renamed[]> {
    return this.restoreRecords([id], targetPath)
  }

  /**
   * Restore multiple trashed records (records remember their original
   * folders): a manifest write per target folder, the index if a target is
   * new, and the trash — in one change.
   * Targets are stored first, so a failure part-way leaves a file in both
   * places, never in neither.
   */
  async restoreRecords(ids: string[], targetPath?: string): Promise<Renamed[]> {
    if (ids.length === 0) return []
    await this.refresh()

    const trash = await this.loadFolder(TRASH_PATH)
    if (trash === null) return []
    const restored = trash.files.filter((f) => ids.includes(f.id))
    if (restored.length === 0) return []

    // each record goes back to its folder by id (wherever it is now), else
    // to its old path, re-creating the folder if it's gone
    const index = await this.loadIndex()
    let treeChanged = false
    const byFolder = new Map<string, FileMeta[]>()
    for (const rec of restored) {
      let dest: string
      if (targetPath === undefined && index.tree.has(originFolder(rec))) {
        dest = originFolder(rec)
      } else {
        const ensured = index.tree.ensure(normalizePath(targetPath ?? rec.originalPath ?? ''))
        dest = ensured.id
        treeChanged ||= ensured.created
      }
      const { originalPath: _op, originalFolder: _of, trashedAt: _ta, ...clean } = rec
      byFolder.set(dest, [...(byFolder.get(dest) ?? []), clean])
    }

    // a re-created folder's index entry first: a failure after it leaves
    // the files in trash and an empty folder, never listed nowhere
    const first: ManifestWrite[] = treeChanged ? [this.indexItem(index)] : []
    const renamed: Renamed[] = []
    for (const [dest, records] of byFolder) {
      const folder = (await this.loadFolder(dest)) ?? emptyFolder(dest)
      const back = new Set(records.map((f) => f.id))
      folder.files = folder.files.filter((f) => !back.has(f.id))
      // a name taken there meanwhile: the restored file gets "name (1).ext"
      for (const rec of records) {
        const name = uniqueName(rec.name, new Set(folder.files.map((f) => f.name.toLowerCase())))
        if (name !== rec.name) {
          renamed.push({ id: rec.id, from: rec.name, to: name })
          rec.name = name
        }
        folder.files.push(rec)
      }
      folder.updatedAt = Date.now()
      folder.version += 1
      first.push(this.manifestItem(folder, folderTag(dest)))
    }

    trash.files = trash.files.filter((f) => !ids.includes(f.id))
    trash.updatedAt = Date.now()
    trash.version += 1
    await this.writeManifests(
      first,
      [this.manifestItem(trash, folderTag(TRASH_PATH))],
      'the files were restored but are still listed in trash too. Restore them again to finish.'
    )
    return renamed
  }

  /**
   * Move file records out of one folder, each to its own destination: a
   * manifest write per destination folder, one for the source, plus an
   * index write if a destination is new — in one change. Destinations are stored first, so a failure
   * part-way leaves a file in both folders, never in neither. Metadata
   * only — blobs don't move. With `refuseNameClash`, nothing moves if a
   * destination already has a file of the same name (ignoring case), or
   * two moved files would share one.
   */
  async moveRecords(
    fromPath: string,
    moves: { id: string; to: string }[],
    opts: { refuseNameClash?: boolean } = {}
  ): Promise<void> {
    const from = normalizePath(fromPath)
    const byDest = new Map<string, string[]>()
    for (const m of moves) {
      const to = normalizePath(m.to)
      if (to === from) continue
      byDest.set(to, [...(byDest.get(to) ?? []), m.id])
    }
    if (byDest.size === 0) return
    await this.refresh()

    const index = await this.loadIndex()
    const fromId = this.folderId(index, from)
    const source = await this.loadFolder(fromId)
    if (source === null) return
    let treeChanged = false
    const writes: ManifestWrite[] = []
    const moved = new Set<string>()
    for (const [to, ids] of byDest) {
      const records = source.files.filter((f) => ids.includes(f.id))
      if (records.length === 0) continue
      const { id: toId, created } = index.tree.ensure(to)
      treeChanged ||= created
      const dest = (created ? null : await this.loadFolder(toId)) ?? emptyFolder(toId)
      if (opts.refuseNameClash) {
        const taken = new Set(dest.files.map((f) => f.name.toLowerCase()))
        for (const f of records) {
          if (taken.has(f.name.toLowerCase())) {
            throw new Error(`There is already a file named "${f.name}" in ${to === '' ? 'My drive' : `"${to}"`}.`)
          }
          taken.add(f.name.toLowerCase())
        }
      }
      const present = new Set(dest.files.map((f) => f.id))
      dest.files.push(...records.filter((f) => !present.has(f.id)))
      dest.updatedAt = Date.now()
      dest.version += 1
      writes.push(this.manifestItem(dest, folderTag(toId)))
      records.forEach((f) => moved.add(f.id))
    }
    if (moved.size === 0) return
    // new destinations' index entry first (see restoreRecords)
    const first = treeChanged ? [this.indexItem(index), ...writes] : writes

    source.files = source.files.filter((f) => !moved.has(f.id))
    source.updatedAt = Date.now()
    source.version += 1
    await this.writeManifests(
      first,
      [this.manifestItem(source, folderTag(fromId))],
      'the files were copied to their new folders but are still listed in the old one too. Move them again to finish.'
    )
  }

  // ─── Multi-manifest writes ──────────────────────────────────────────

  private manifestItem(value: unknown, key: string): ManifestWrite {
    if (Array.isArray((value as FolderManifest).files)) this.fillSearch((value as FolderManifest).files)
    // a snapshot: callers go on changing their copy
    return { key, value: JSON.parse(JSON.stringify(value)) }
  }

  /** Give `files` that have no search entry this device's pending one; how many got one. */
  private fillSearch(files: FileMeta[]): number {
    const pending = this.opts.pendingSearch?.()
    if (!pending?.size) return 0
    let n = 0
    for (const f of files) {
      const p = f.search ? undefined : pending.get(f.id)
      if (p && p.name === f.name) {
        f.search = p.entry
        n++
      }
    }
    return n
  }

  /**
   * Listings that save this device's pending search entries, for folders
   * other than those `alongside` already writes (which get theirs anyway),
   * as listings to store in the same change. Up to
   * SEARCH_SAVE_FOLDERS folders; [] when nothing is pending. Reads the
   * backend's view as last refreshed (callers refresh it first).
   */
  async searchSaveItems(alongside: ManifestWrite[] = [], max = SEARCH_SAVE_FOLDERS): Promise<ManifestWrite[]> {
    const pending = this.opts.pendingSearch?.()
    if (!pending?.size) return []
    const written = new Set(alongside.map((i) => i.key))
    const index = await this.loadIndex()
    const ids = [...new Set([...pending.values()].map((p) => p.folder))]
      .filter((id) => (id === ROOT_ID || index.tree.has(id)) && !written.has(folderTag(id)))
      .slice(0, max)
    const out: ManifestWrite[] = []
    for (const id of ids) {
      const folder = await this.loadFolder(id)
      if (!folder) continue
      const copy = { ...folder, files: folder.files.map((f) => ({ ...f })) }
      if (this.fillSearch(copy.files) === 0) continue
      copy.updatedAt = Date.now()
      copy.version += 1
      out.push(this.manifestItem(copy, folderTag(id)))
    }
    return out
  }

  /** Save this device's pending search entries now: one change. */
  async saveSearchEntries(): Promise<number> {
    await this.refresh()
    const items = await this.searchSaveItems([], Number.POSITIVE_INFINITY)
    if (items.length > 0) await this.writeManifests([], items, '')
    return items.length
  }

  /** The trash with `records` added (a record already there is replaced). */
  private async trashWith(records: FileMeta[]): Promise<FolderManifest> {
    const trash = (await this.loadFolder(TRASH_PATH)) ?? emptyFolder(TRASH_PATH)
    const adding = new Set(records.map((r) => r.id))
    const now = Date.now()
    trash.files = [...trash.files.filter((f) => !adding.has(f.id)), ...records.map((r) => ({ ...r, trashedAt: now }))]
    trash.updatedAt = Date.now()
    trash.version += 1
    return trash
  }

  /**
   * Write several manifests as one change (see DriveBackend.writeManifests):
   * `first` is stored before `then`, and `then` only if all of `first`
   * stored. Callers put what must not be lost in `first`, so a failure
   * part-way duplicates a record rather than dropping it. `partial` is the
   * error when `first` stored but `then` didn't. This device's pending
   * search entries of other folders ride along.
   */
  private async writeManifests(first: ManifestWrite[], then: ManifestWrite[], partial: string): Promise<void> {
    if (first.length + then.length === 0) return
    const extras = await this.searchSaveItems([...first, ...then]).catch(() => [])
    await this.backend.writeManifests(first, then, extras, partial)
  }

  /**
   * Trash records older than `maxAgeMs` deleted forever (one change, then
   * their files). Records trashed before trash dates were kept get today's
   * date, saved in the same change. The records it deleted.
   */
  async expireTrash(maxAgeMs: number = TRASH_DAYS * DAY_MS): Promise<FileMeta[]> {
    await this.refresh()
    const trash = await this.loadFolder(TRASH_PATH)
    if (trash === null) return []
    const now = Date.now()
    const undated = trash.files.filter((f) => typeof f.trashedAt !== 'number')
    const expired = trash.files.filter((f) => typeof f.trashedAt === 'number' && now - f.trashedAt >= maxAgeMs)
    if (undated.length === 0 && expired.length === 0) return []
    const gone = new Set(expired.map((f) => f.id))
    trash.files = trash.files.filter((f) => !gone.has(f.id)).map((f) => (typeof f.trashedAt === 'number' ? f : { ...f, trashedAt: now }))
    trash.updatedAt = now
    trash.version += 1
    await this.writeManifests([], [this.manifestItem(trash, folderTag(TRASH_PATH))], '')
    await this.backend.discard(expired)
    return expired
  }

  /**
   * Stop paying for stored files nothing references any more (a deletion
   * that failed, an upload whose change never stored): see
   * DriveBackend.sweep. Every listing is read first; if one can't be,
   * nothing is deleted (throws). How many files it deleted.
   */
  async sweepLeftovers(minAgeMs: number = DAY_MS): Promise<number> {
    await this.refresh()
    const keep = new Set<string>()
    for (const key of this.backend.listingKeys()) {
      const text = await this.backend.readManifest(key)
      if (text === null) throw new Error(`The listing ${key} couldn't be read: nothing was deleted.`)
      const value = JSON.parse(text) as { files?: FileMeta[] }
      for (const f of value.files ?? []) for (const h of f.rootHashes ?? []) keep.add(h.replace(/^0x/i, '').toLowerCase())
    }
    return this.backend.sweep(keep, minAgeMs)
  }

  /** Permanently drop a record from trash, and its file where the backend can delete it. */
  async purgeFromTrash(id: string): Promise<void> {
    await this.refresh()
    const trash = await this.loadFolder(TRASH_PATH)
    const removed = trash?.files.filter((f) => f.id === id) ?? []
    if (trash === null || removed.length === 0) return
    trash.files = trash.files.filter((f) => f.id !== id)
    trash.updatedAt = Date.now()
    trash.version += 1
    await this.writeManifests([], [this.manifestItem(trash, folderTag(TRASH_PATH))], '')
    await this.backend.discard(removed)
  }
}

/** The id of the folder a trashed record came from. Records trashed before
 *  folder ids have only the path — which is the id of a pre-tree folder. */
function originFolder(rec: FileMeta): string {
  return rec.originalFolder ?? rec.originalPath ?? ROOT_ID
}
