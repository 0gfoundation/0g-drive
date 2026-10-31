import { ethers } from 'ethers'
import type { NetworkConfig } from './config.js'
import { uploadData, uploadBatch, downloadFile, storagePrice, wakeWallet, type BatchItem } from './storage.js'
import { timed } from './timing.js'
import type { FileMeta, SearchEntry } from './types.js'
import { scanUploadsCached, type EventCache, type UploadEvent } from './events.js'
import {
  ROOT_ID,
  TRASH_PATH,
  folderTag,
  indexTag,
  findManifestEvents,
  type DriveIndex,
  type FolderManifest,
} from './manifest.js'
import { FolderTree } from './tree.js'

export interface DriveState {
  /** Every folder's path (not the root), parents before children. */
  paths: string[]
  tree: FolderTree
  /** Folder manifests by path ('' = root); null = no files yet. */
  folders: Map<string, FolderManifest | null>
  trash: FolderManifest | null
}

/** The index as loaded: its tree, and the version the next write bumps. */
interface LoadedIndex {
  tree: FolderTree
  version: number
}

export interface DriveStoreOpts {
  onProgress?: (msg: string) => void
  /** Block finality on manifest uploads too (default true, mirrors file uploads). */
  finalityRequired?: boolean
  /**
   * Optional persistence hook for incremental event scanning. Without it,
   * every refresh rescans the wallet's full upload history from block 0
   * (minutes at current chain heights). With it, only new blocks are
   * scanned and events are merged with the cached list.
   */
  eventCache?: EventCache
}

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

const emptyFolder = (key: string): FolderManifest => ({ path: key, files: [], updatedAt: 0, version: 0 })

/**
 * Serverless drive metadata on 0G: encrypted manifest files, discovered via
 * on-chain Submit events. See docs/decisions.md D3.
 *
 * All mutations upload a new manifest version (immutable history, latest
 * block wins) — one per touched folder, plus the index when the folder
 * tree changes; one transaction in all where batchSubmit is on.
 *
 * The public API takes folder paths; the index's tree maps each path to
 * the folder's permanent id, which is what its manifest is tagged with.
 */
export class DriveStore {
  private events: UploadEvent[] = []
  private scannedToBlock = 0
  /**
   * Manifest JSON by the root hash of its stored (encrypted) bytes. A root
   * names one immutable upload, so an entry never goes stale; which root
   * is current still comes from the event scan. Saves re-downloading the
   * index and folders before every action's wallet prompt.
   */
  private manifests = new Map<string, string>()

  constructor(
    private network: NetworkConfig,
    private signer: ethers.Signer,
    /** Drive master key (32 bytes) — manifests are encrypted with it. */
    private masterKey: Uint8Array,
    private opts: DriveStoreOpts = {}
  ) {}

  private progress(msg: string): void {
    this.opts.onProgress?.(msg)
  }

  /** (Re)scan the wallet's upload events from the chain — incrementally
   *  when an eventCache is configured. */
  async refreshEvents(): Promise<UploadEvent[]> {
    // this action's fee: a fresh price, in the same request as the scan
    if (this.network.batchSubmit) storagePrice(this.network, 0).catch(() => undefined)
    wakeWallet(this.signer)
    const address = await this.signer.getAddress()
    const { events, scannedToBlock } = await timed(
      'chain',
      scanUploadsCached(address, this.network, this.opts.eventCache)
    )
    this.events = events
    this.scannedToBlock = scannedToBlock
    return events
  }

  // ─── Manifest I/O ───────────────────────────────────────────────────

  private async uploadManifest(
    bytes: Uint8Array,
    tag: string
  ): Promise<{ rootHash: string; txHash: string }> {
    const result = await uploadData(bytes, this.network, this.signer, {
      encryption: { type: 'aes256', key: this.masterKey },
      tags: tag,
      finalityRequired: this.opts.finalityRequired ?? true,
      onProgress: (msg) => this.progress(msg),
    })
    return { rootHash: result.rootHash, txHash: result.txHash }
  }

  /**
   * Download + decrypt the latest readable manifest among the candidate
   * events (highest block first), parsing it as JSON. Older versions are
   * the fallback when a newer manifest was pruned before sealing — and a
   * candidate that decrypts to non-JSON (e.g. written under a different
   * drive key; AES-CTR decryption never fails loudly) is skipped the same
   * way.
   */
  private async downloadManifest<T>(
    candidates: UploadEvent[]
  ): Promise<T | null> {
    const sorted = [...candidates].sort((a, b) => b.blockNumber - a.blockNumber)
    const skipped: string[] = []
    for (const event of sorted) {
      const cached = this.manifests.get(event.rootHash.toLowerCase())
      if (cached !== undefined) return JSON.parse(cached) as T
      try {
        const { data, decrypted } = await timed('listings', downloadFile(
          [event.rootHash],
          this.network,
          {
            decryption: { symmetricKey: this.masterKey },
            // by-txSeq fallback — manifests are single-segment, the exact
            // class of file whose root-hash index decays on the nodes
            txSeqs: [event.txSeq],
            onProgress: () => undefined, // quiet for metadata reads
          }
        ))
        if (!decrypted) {
          throw new Error(
            'Manifest decryption failed — wrong drive key for this account'
          )
        }
        const text = new TextDecoder().decode(data)
        const parsed = JSON.parse(text) as T
        this.manifests.set(event.rootHash.toLowerCase(), text)
        if (skipped.length) {
          console.warn(
            `[drive] newest manifest version(s) unreadable, using block ${event.blockNumber}: ${skipped.join('; ')}`
          )
        }
        return parsed
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.includes('decryption failed')
        ) {
          throw err // wrong key fails for every candidate — stop
        }
        skipped.push(`block ${event.blockNumber} txSeq ${event.txSeq}: ${(err as Error).message}`)
        // this version is unreadable (pruned / not yet stored / non-JSON) —
        // try older
      }
    }
    return null
  }

  private async loadIndex(): Promise<LoadedIndex> {
    const candidates = manifestCandidates(this.events, 'index')
    const index = candidates.length > 0 ? await this.downloadManifest<DriveIndex>(candidates) : null
    if (!index) return { tree: new FolderTree(), version: 0 }
    return { tree: FolderTree.fromIndex(index), version: index.version }
  }

  /** The index write for `index` as it stands (v2), as a batch item. */
  private indexItem(index: LoadedIndex): BatchItem {
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
    const candidates = manifestCandidates(this.events, 'folder', key)
    if (candidates.length === 0) return null
    const folder = await this.downloadManifest<FolderManifest>(candidates)
    if (folder) this.backfillTxInfo(folder.files)
    return folder
  }

  /**
   * Records written in the same batch transaction as their files can't
   * know their txSeqs yet (assigned on mining). Fill them in from the
   * wallet's Submit events, which carry root → txSeq for every upload.
   */
  private backfillTxInfo(files: FileMeta[]): void {
    let byRoot: Map<string, UploadEvent> | null = null
    for (const f of files) {
      if (f.txSeqs?.length === f.rootHashes.length && f.txHashes.length === f.rootHashes.length) continue
      byRoot ??= new Map(this.events.map((e) => [e.rootHash.toLowerCase(), e]))
      const evs = f.rootHashes.map((r) => byRoot!.get(r.toLowerCase()))
      if (evs.every((e) => e !== undefined)) {
        f.txSeqs = evs.map((e) => e!.txSeq)
        f.txHashes = evs.map((e) => e!.txHash)
      }
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /** Load the whole drive state from the chain (fresh scan). */
  async loadDrive(): Promise<DriveState> {
    await this.refreshEvents()
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
   * ONE transaction for the whole batch (fewer wallet prompts, one
   * sealing wait). Files themselves are already uploaded by the caller.
   */
  async putFileRecords(folderPath: string, metas: FileMeta[]): Promise<void> {
    const items = await this.prepareFileRecords(folderPath, metas)
    // a new folder's index entry first: a failure after it leaves an
    // empty folder, not a listing no folder points to
    await this.writeManifests(
      items.slice(0, -1),
      items.slice(-1),
      'the folder was created but the files are not listed in it yet. Upload them again to finish.'
    )
  }

  /**
   * The manifest write(s) for adding `metas` to a folder, as batch items
   * instead of uploads — so they can ride in the same transaction as the
   * files themselves (storage.uploadBatch → finalize). Same contents as
   * putFileRecords would write: the index first if the folder is new, then
   * the folder.
   */
  async prepareFileRecords(folderPath: string, metas: FileMeta[]): Promise<BatchItem[]> {
    const path = normalizePath(folderPath)
    await this.refreshEvents()
    const index = await this.loadIndex()
    const { id, created } = index.tree.ensure(path)
    const folder = (created ? null : await this.loadFolder(id)) ?? emptyFolder(id)
    for (const meta of metas) {
      const idx = folder.files.findIndex((f) => f.id === meta.id)
      if (idx >= 0) folder.files[idx] = meta
      else folder.files.push(meta)
    }
    folder.updatedAt = Date.now()
    folder.version += 1
    const out: BatchItem[] = created ? [this.indexItem(index)] : []
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
   * trash's when they go to trash, in one transaction where batchSubmit is
   * on. Trash is stored first, so a failure part-way leaves a file in both
   * places, never in neither.
   */
  async removeFileRecords(
    folderPath: string,
    ids: string[],
    toTrash = true
  ): Promise<void> {
    if (ids.length === 0) return
    await this.refreshEvents()
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
    const first: BatchItem[] = []
    if (toTrash) {
      const trash = await this.trashWith(removed.map((rec) => ({ ...rec, originalPath: path, originalFolder: key })))
      first.push(this.manifestItem(trash, folderTag(TRASH_PATH)))
    }
    await this.writeManifests(
      first,
      [this.manifestItem(folder, folderTag(key))],
      'the files were added to trash but are still listed in their folder too. Move them to trash again to finish.'
    )
  }

  /**
   * Rename a file: one folder-manifest write (one transaction). The blob
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
    await this.refreshEvents()

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
    await this.refreshEvents()
    const index = await this.loadIndex()
    if (index.tree.ensure(path).created) await this.writeIndex(index)
  }

  /** Remove an empty folder (no files, no subfolders) from the index. */
  async removeFolder(folderPath: string): Promise<void> {
    const path = normalizePath(folderPath)
    if (path === '') throw new Error('The drive root cannot be removed')
    await this.refreshEvents()
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
   * folders) to trash, in one transaction where batchSubmit is on:
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
    await this.refreshEvents()

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

    const first: BatchItem[] = []
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
   * Rename a folder: one index write (one transaction), however many files
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
    await this.refreshEvents()

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
   * the top level: one index write (one transaction) — manifests are
   * tagged by folder id, not path. A destination that doesn't exist yet is
   * created in the same write. Refuses a move into the folder itself or a
   * folder inside it, and a destination that already has a folder of that
   * name (ignoring case). Returns the folder's new path.
   */
  async moveFolder(folderPath: string, toParentPath: string): Promise<string> {
    const path = normalizePath(folderPath)
    const to = normalizePath(toParentPath)
    if (path === '') throw new Error('The drive root cannot be moved')
    await this.refreshEvents()

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
  async restoreFromTrash(id: string, targetPath?: string): Promise<void> {
    await this.restoreRecords([id], targetPath)
  }

  /**
   * Restore multiple trashed records (records remember their original
   * folders): a manifest write per target folder, the index if a target is
   * new, and the trash — in one transaction where batchSubmit is on.
   * Targets are stored first, so a failure part-way leaves a file in both
   * places, never in neither.
   */
  async restoreRecords(ids: string[], targetPath?: string): Promise<void> {
    if (ids.length === 0) return
    await this.refreshEvents()

    const trash = await this.loadFolder(TRASH_PATH)
    if (trash === null) return
    const restored = trash.files.filter((f) => ids.includes(f.id))
    if (restored.length === 0) return

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
      const { originalPath: _op, originalFolder: _of, ...clean } = rec
      byFolder.set(dest, [...(byFolder.get(dest) ?? []), clean])
    }

    // a re-created folder's index entry first: a failure after it leaves
    // the files in trash and an empty folder, never listed nowhere
    const first: BatchItem[] = treeChanged ? [this.indexItem(index)] : []
    for (const [dest, records] of byFolder) {
      const folder = (await this.loadFolder(dest)) ?? emptyFolder(dest)
      const back = new Set(records.map((f) => f.id))
      folder.files = [...folder.files.filter((f) => !back.has(f.id)), ...records]
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
  }

  /**
   * Move file records out of one folder, each to its own destination: a
   * manifest write per destination folder, one for the source, plus an
   * index write if a destination is new — in one transaction where
   * batchSubmit is on. Destinations are stored first, so a failure
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
    await this.refreshEvents()

    const index = await this.loadIndex()
    const fromId = this.folderId(index, from)
    const source = await this.loadFolder(fromId)
    if (source === null) return
    let treeChanged = false
    const writes: BatchItem[] = []
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

  private manifestItem(value: unknown, tag: string): BatchItem {
    return {
      data: new TextEncoder().encode(JSON.stringify(value)),
      encryption: { type: 'aes256', key: this.masterKey },
      tags: tag,
    }
  }

  /** The trash with `records` added (a record already there is replaced). */
  private async trashWith(records: FileMeta[]): Promise<FolderManifest> {
    const trash = (await this.loadFolder(TRASH_PATH)) ?? emptyFolder(TRASH_PATH)
    const adding = new Set(records.map((r) => r.id))
    trash.files = [...trash.files.filter((f) => !adding.has(f.id)), ...records]
    trash.updatedAt = Date.now()
    trash.version += 1
    return trash
  }

  /**
   * Write several manifests: in ONE transaction where batchSubmit is on,
   * else one transaction each. Either way `first` is stored before `then`,
   * and `then` only if all of `first` stored (and sealed, under strict
   * finality). Callers put what must not be lost in `first`, so a failure
   * part-way duplicates a record rather than dropping it. `partial` is the
   * error when `first` stored but `then` didn't.
   */
  private async writeManifests(first: BatchItem[], then: BatchItem[], partial: string): Promise<void> {
    const all = [...first, ...then]
    if (all.length === 0) return
    // what was stored is known: the next action reads it back from here
    const remember = (item: BatchItem, rootHash: string) =>
      this.manifests.set(rootHash.toLowerCase(), new TextDecoder().decode(item.data as Uint8Array))
    if (!this.network.batchSubmit) {
      for (let i = 0; i < all.length; i++) {
        try {
          const { rootHash } = await this.uploadManifest(all[i].data as Uint8Array, all[i].tags ?? '0x')
          remember(all[i], rootHash)
        } catch (err) {
          if (i < first.length || first.length === 0) throw err
          throw new Error(`${partial} (${(err as Error).message})`)
        }
      }
      return
    }
    // a single manifest goes this way too: unlike the SDK's own upload, it
    // asks no storage node anything before the wallet prompt
    const primary = first.length > 0 ? first : then
    const extras = first.length > 0 ? then : []
    const res = await uploadBatch(primary, this.network, this.signer, {
      finalize: extras.length > 0 ? async () => extras : undefined,
      finalityRequired: this.opts.finalityRequired ?? true,
      onProgress: (msg) => this.progress(msg),
    })
    res.items.forEach((r, i) => r.ok && remember(primary[i], r.result.rootHash))
    res.extras.forEach((r, i) => r.ok && remember(extras[i], r.result.rootHash))
    for (const r of res.items) {
      if (!r.ok) throw new Error(`nothing was changed: a listing could not be stored (${r.error})`)
    }
    for (const r of res.extras) {
      if (!r.ok) throw new Error(`${partial} (${r.error})`)
    }
  }

  /** Permanently drop a record from trash (metadata only; blobs persist). */
  async purgeFromTrash(id: string): Promise<void> {
    await this.refreshEvents()
    const trash = await this.loadFolder(TRASH_PATH)
    if (trash === null || !trash.files.some((f) => f.id === id)) return
    trash.files = trash.files.filter((f) => f.id !== id)
    trash.updatedAt = Date.now()
    trash.version += 1
    await this.writeManifests([], [this.manifestItem(trash, folderTag(TRASH_PATH))], '')
  }
}

function manifestCandidates(
  events: UploadEvent[],
  purpose: 'index' | 'folder',
  folderPath?: string
): UploadEvent[] {
  return findManifestEvents(events, purpose, folderPath)
}

/** The id of the folder a trashed record came from. Records trashed before
 *  folder ids have only the path — which is the id of a pre-tree folder. */
function originFolder(rec: FileMeta): string {
  return rec.originalFolder ?? rec.originalPath ?? ROOT_ID
}
