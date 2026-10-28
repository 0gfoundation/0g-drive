import { ethers } from 'ethers'
import type { NetworkConfig } from './config.js'
import { uploadData, downloadFile, type BatchItem } from './storage.js'
import type { FileMeta } from './types.js'
import { scanUploadsCached, type EventCache, type UploadEvent } from './events.js'
import {
  TRASH_PATH,
  folderTag,
  indexTag,
  findManifestEvents,
  type DriveIndex,
  type FolderManifest,
} from './manifest.js'

export interface DriveState {
  index: DriveIndex
  folders: Map<string, FolderManifest | null>
  trash: FolderManifest | null
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

/** A fresh empty index each time — a shared constant's `folders` array
 *  would be mutated by the first createFolder (and leak across drives). */
const emptyIndex = (): DriveIndex => ({ folders: [], updatedAt: 0, version: 0 })

/**
 * Serverless drive metadata on 0G: encrypted manifest files, discovered via
 * on-chain Submit events. See docs/decisions.md D3.
 *
 * All mutations upload a new manifest version (immutable history, latest
 * block wins) — one small transaction per touched folder, plus the index
 * manifest when the folder set changes.
 */
export class DriveStore {
  private events: UploadEvent[] = []
  private scannedToBlock = 0

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
    const address = await this.signer.getAddress()
    const { events, scannedToBlock } = await scanUploadsCached(
      address,
      this.network,
      this.opts.eventCache
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
      try {
        const { data, decrypted } = await downloadFile(
          [event.rootHash],
          this.network,
          {
            decryption: { symmetricKey: this.masterKey },
            // by-txSeq fallback — manifests are single-segment, the exact
            // class of file whose root-hash index decays on the nodes
            txSeqs: [event.txSeq],
            onProgress: () => undefined, // quiet for metadata reads
          }
        )
        if (!decrypted) {
          throw new Error(
            'Manifest decryption failed — wrong drive key for this account'
          )
        }
        const parsed = JSON.parse(new TextDecoder().decode(data)) as T
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

  private async loadIndex(): Promise<DriveIndex> {
    const candidates = manifestCandidates(this.events, 'index')
    if (candidates.length === 0) return emptyIndex()
    const index = await this.downloadManifest<DriveIndex>(candidates)
    return index ?? emptyIndex()
  }

  private async loadFolder(path: string): Promise<FolderManifest | null> {
    const candidates = manifestCandidates(this.events, 'folder', path)
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
    const index = await this.loadIndex()
    // folders are independent downloads: fetch them a few at a time
    const paths = ['', ...index.folders, TRASH_PATH] // '' = drive root
    const loaded: (FolderManifest | null)[] = new Array(paths.length)
    let next = 0
    const worker = async () => {
      while (next < paths.length) {
        const i = next++
        loaded[i] = await this.loadFolder(paths[i])
      }
    }
    await Promise.all(Array.from({ length: Math.min(LOAD_CONCURRENCY, paths.length) }, worker))
    const folders = new Map<string, FolderManifest | null>()
    paths.slice(0, -1).forEach((p, i) => folders.set(p, loaded[i]))
    return { index, folders, trash: loaded[paths.length - 1] }
  }

  private async writeIndex(index: DriveIndex): Promise<void> {
    index.updatedAt = Date.now()
    index.version += 1
    await this.uploadManifest(
      new TextEncoder().encode(JSON.stringify(index)),
      indexTag()
    )
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
    const path = normalizePath(folderPath)
    await this.refreshEvents()

    const folder = (await this.loadFolder(path)) ?? {
      path,
      files: [],
      updatedAt: 0,
      version: 0,
    }
    for (const meta of metas) {
      const idx = folder.files.findIndex((f) => f.id === meta.id)
      if (idx >= 0) folder.files[idx] = meta
      else folder.files.push(meta)
    }
    folder.updatedAt = Date.now()
    folder.version += 1
    await this.uploadManifest(
      new TextEncoder().encode(JSON.stringify(folder)),
      folderTag(path)
    )

    const index = await this.loadIndex()
    if (path !== '' && !index.folders.includes(path)) {
      index.folders.push(path)
      await this.writeIndex(index)
    }
  }

  /**
   * The manifest write(s) for adding `metas` to a folder, as batch items
   * instead of uploads — so they can ride in the same transaction as the
   * files themselves (storage.uploadBatch → finalize). Same contents as
   * putFileRecords would write.
   */
  async prepareFileRecords(folderPath: string, metas: FileMeta[]): Promise<BatchItem[]> {
    const path = normalizePath(folderPath)
    await this.refreshEvents()
    const folder = (await this.loadFolder(path)) ?? { path, files: [], updatedAt: 0, version: 0 }
    for (const meta of metas) {
      const idx = folder.files.findIndex((f) => f.id === meta.id)
      if (idx >= 0) folder.files[idx] = meta
      else folder.files.push(meta)
    }
    folder.updatedAt = Date.now()
    folder.version += 1
    const enc = { type: 'aes256' as const, key: this.masterKey }
    const out: BatchItem[] = [
      { data: new TextEncoder().encode(JSON.stringify(folder)), encryption: enc, tags: folderTag(path) },
    ]
    if (path !== '') {
      const index = await this.loadIndex()
      if (!index.folders.includes(path)) {
        index.folders.push(path)
        index.updatedAt = Date.now()
        index.version += 1
        out.push({ data: new TextEncoder().encode(JSON.stringify(index)), encryption: enc, tags: indexTag() })
      }
    }
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
   * Remove multiple file records from one folder in two transactions
   * regardless of count: one folder-manifest write, one trash-manifest
   * write.
   */
  async removeFileRecords(
    folderPath: string,
    ids: string[],
    toTrash = true
  ): Promise<void> {
    if (ids.length === 0) return
    const path = normalizePath(folderPath)
    await this.refreshEvents()

    const folder = await this.loadFolder(path)
    if (folder === null) return
    const removed = folder.files.filter((f) => ids.includes(f.id))
    if (removed.length === 0) return

    folder.files = folder.files.filter((f) => !ids.includes(f.id))
    folder.updatedAt = Date.now()
    folder.version += 1
    await this.uploadManifest(
      new TextEncoder().encode(JSON.stringify(folder)),
      folderTag(path)
    )

    if (toTrash) {
      const trash =
        (await this.loadFolder(TRASH_PATH)) ?? {
          path: TRASH_PATH,
          files: [],
          updatedAt: 0,
          version: 0,
        }
      for (const rec of removed) {
        trash.files.push({ ...rec, originalPath: path })
      }
      trash.updatedAt = Date.now()
      trash.version += 1
      await this.uploadManifest(
        new TextEncoder().encode(JSON.stringify(trash)),
        folderTag(TRASH_PATH)
      )
    }
  }

  /** Create a folder (index entry; manifest materializes on first file). */
  async createFolder(folderPath: string): Promise<void> {
    const path = normalizePath(folderPath)
    if (path === '') return // the root always exists
    await this.refreshEvents()
    const index = await this.loadIndex()
    if (index.folders.includes(path)) return
    index.folders.push(path)
    await this.writeIndex(index)
  }

  /** Remove an empty folder from the index. */
  async removeFolder(folderPath: string): Promise<void> {
    const path = normalizePath(folderPath)
    if (path === '') throw new Error('The drive root cannot be removed')
    await this.refreshEvents()
    const folder = await this.loadFolder(path)
    if (folder !== null && folder.files.length > 0) {
      throw new Error(`Folder "${path}" is not empty — trash its files first`)
    }
    const index = await this.loadIndex()
    index.folders = index.folders.filter((f) => f !== path)
    await this.writeIndex(index)
  }

  /**
   * Move a folder and everything inside it (including all descendant
   * folders) to trash. Two transactions total:
   *   1. trash manifest update — all file records, each tagged with its
   *      original folder path (restorable individually)
   *   2. index update — the folder and its descendants stop existing
   * Descendant folder manifests are NOT rewritten: they become unreferenced
   * the moment the index drops their paths, so their old versions simply
   * stop being loaded. Empty descendant folders are not preserved (folder
   * existence lives only in the index).
   */
  async trashFolder(folderPath: string): Promise<void> {
    const path = normalizePath(folderPath)
    if (path === '') throw new Error('The drive root cannot be deleted')
    await this.refreshEvents()

    const index = await this.loadIndex()
    const descendants = index.folders.filter(
      (f) => f.startsWith(path + '/')
    )
    const affected = [path, ...descendants]

    const records: FileMeta[] = []
    for (const f of affected) {
      const manifest = await this.loadFolder(f)
      if (manifest !== null) {
        for (const rec of manifest.files) {
          records.push({ ...rec, originalPath: f })
        }
      }
    }

    if (records.length > 0) {
      const trash =
        (await this.loadFolder(TRASH_PATH)) ?? {
          path: TRASH_PATH,
          files: [],
          updatedAt: 0,
          version: 0,
        }
      trash.files.push(...records)
      trash.updatedAt = Date.now()
      trash.version += 1
      await this.uploadManifest(
        new TextEncoder().encode(JSON.stringify(trash)),
        folderTag(TRASH_PATH)
      )
    }

    index.folders = index.folders.filter((f) => !affected.includes(f))
    await this.writeIndex(index)
  }

  /** Rename a folder: re-manifest its files under the new path. */
  async renameFolder(oldPath: string, newPath: string): Promise<void> {
    const old = normalizePath(oldPath)
    const next = normalizePath(newPath)
    if (old === '' || next === '') {
      throw new Error('The drive root cannot be renamed')
    }
    if (old === next) return
    await this.refreshEvents()

    const folder = await this.loadFolder(old)
    if (folder !== null && folder.files.length > 0) {
      const moved: FolderManifest = {
        ...folder,
        path: next,
        updatedAt: Date.now(),
        version: folder.version + 1,
      }
      await this.uploadManifest(
        new TextEncoder().encode(JSON.stringify(moved)),
        folderTag(next)
      )
    }
    const index = await this.loadIndex()
    index.folders = index.folders
      .filter((f) => f !== old)
      .concat(next)
      .filter((f, i, arr) => arr.indexOf(f) === i)
    await this.writeIndex(index)
  }

  /** Restore a trashed file record to its original folder (or a given one). */
  async restoreFromTrash(id: string, targetPath?: string): Promise<void> {
    await this.restoreRecords([id], targetPath)
  }

  /**
   * Restore multiple trashed records: ONE trash-manifest write plus ONE
   * manifest write per distinct target folder (records remember their
   * original folders).
   */
  async restoreRecords(ids: string[], targetPath?: string): Promise<void> {
    if (ids.length === 0) return
    await this.refreshEvents()

    const trash = await this.loadFolder(TRASH_PATH)
    if (trash === null) return
    const restored = trash.files.filter((f) => ids.includes(f.id))
    if (restored.length === 0) return

    const byFolder = new Map<string, FileMeta[]>()
    for (const rec of restored) {
      const dest = normalizePath(targetPath ?? rec.originalPath ?? '')
      const list = byFolder.get(dest) ?? []
      const { originalPath: _op, ...clean } = rec
      list.push(clean)
      byFolder.set(dest, list)
    }

    for (const [dest, records] of byFolder) {
      const folder =
        (await this.loadFolder(dest)) ?? {
          path: dest,
          files: [],
          updatedAt: 0,
          version: 0,
        }
      folder.files.push(...records)
      folder.updatedAt = Date.now()
      folder.version += 1
      await this.uploadManifest(
        new TextEncoder().encode(JSON.stringify(folder)),
        folderTag(dest)
      )
      if (dest !== '') {
        const index = await this.loadIndex()
        if (!index.folders.includes(dest)) {
          index.folders.push(dest)
          await this.writeIndex(index)
        }
      }
    }

    trash.files = trash.files.filter((f) => !ids.includes(f.id))
    trash.updatedAt = Date.now()
    trash.version += 1
    await this.uploadManifest(
      new TextEncoder().encode(JSON.stringify(trash)),
      folderTag(TRASH_PATH)
    )
  }

  /**
   * Move file records out of one folder, each to its own destination: ONE
   * manifest write per destination folder, ONE for the source, plus an
   * index write if a destination is new. Metadata only — blobs don't move.
   */
  async moveRecords(fromPath: string, moves: { id: string; to: string }[]): Promise<void> {
    const from = normalizePath(fromPath)
    const byDest = new Map<string, string[]>()
    for (const m of moves) {
      const to = normalizePath(m.to)
      if (to === from) continue
      byDest.set(to, [...(byDest.get(to) ?? []), m.id])
    }
    if (byDest.size === 0) return
    await this.refreshEvents()

    const source = await this.loadFolder(from)
    if (source === null) return
    const moved = new Set<string>()

    // destinations first: an interruption leaves a duplicate, never a loss
    for (const [to, ids] of byDest) {
      const records = source.files.filter((f) => ids.includes(f.id))
      if (records.length === 0) continue
      const dest =
        (await this.loadFolder(to)) ?? { path: to, files: [], updatedAt: 0, version: 0 }
      const present = new Set(dest.files.map((f) => f.id))
      dest.files.push(...records.filter((f) => !present.has(f.id)))
      dest.updatedAt = Date.now()
      dest.version += 1
      await this.uploadManifest(new TextEncoder().encode(JSON.stringify(dest)), folderTag(to))
      records.forEach((f) => moved.add(f.id))
    }
    if (moved.size === 0) return

    source.files = source.files.filter((f) => !moved.has(f.id))
    source.updatedAt = Date.now()
    source.version += 1
    await this.uploadManifest(new TextEncoder().encode(JSON.stringify(source)), folderTag(from))

    const index = await this.loadIndex()
    const added = [...byDest.keys()].filter((p) => p !== '' && !index.folders.includes(p))
    if (added.length > 0) {
      index.folders.push(...added)
      await this.writeIndex(index)
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
    await this.uploadManifest(
      new TextEncoder().encode(JSON.stringify(trash)),
      folderTag(TRASH_PATH)
    )
  }
}

function manifestCandidates(
  events: UploadEvent[],
  purpose: 'index' | 'folder',
  folderPath?: string
): UploadEvent[] {
  return findManifestEvents(events, purpose, folderPath)
}
