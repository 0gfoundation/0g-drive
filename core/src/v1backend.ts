import type { ethers } from 'ethers'
import type { NetworkConfig } from './config.js'
import {
  uploadData,
  uploadBatch,
  downloadFile,
  decryptDownloaded,
  resumeWrites,
  storagePrice,
  wakeWallet,
  NotUploadedError,
  type BatchItem,
  type BatchItemResult,
} from './storage.js'
import { timed } from './timing.js'
import type { DownloadOpts, FileMeta } from './types.js'
import { rpcProvider, scanUploadsCached, type EventCache, type UploadEvent } from './events.js'
import type { DriveBackend, FileUpload, ManifestWrite, UploadFilesOpts, UploadFilesResult } from './backend.js'

/** One listing of a change, kept on the device until its data is stored. */
export interface PendingWrite {
  root: string
  /** exactly what is stored: the encrypted listing */
  bytes: Uint8Array
  /** the writes of one change (one transaction) share an id */
  change: string
  /** stage 1 is stored only once all of stage 0 is (writeManifests' first/then) */
  stage: 0 | 1
  order: number
  savedAt: number
}

/**
 * This device's memory of the drive's writes. A change's listings are saved
 * before the wallet is asked and dropped once stored, so if the page closes
 * between the transaction and the upload, the next visit finishes the
 * upload (no new transaction or fee). Listings that never got their data
 * and can't be finished here (another device, cleared site data) are
 * marked abandoned, so loads skip them instead of retrying every node.
 */
export interface DriveDevice {
  savePending(writes: PendingWrite[]): Promise<void>
  pending(): Promise<PendingWrite[]>
  removePending(change: string): Promise<void>
  isAbandoned(rootHash: string): boolean
  markAbandoned(rootHash: string): void
}

export interface V1BackendOpts {
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
  /** Keeps changes on this device until their data is stored (see DriveDevice). */
  device?: DriveDevice
  /** How old a listing with no data must be to be abandoned (default 30 minutes; tests shorten it). */
  abandonedAfterMs?: number
}

/** a listing with no data this long after its transaction was abandoned */
const ABANDONED_AFTER_MS = 30 * 60_000
/** a newer one is retried after this, in case its upload was still running */
const MISSING_RETRY_MS = 2 * 60_000
/** a saved change whose transaction never appeared was never sent */
const NEVER_SENT_AFTER_MS = 30 * 60_000

/**
 * 0G Storage V1: listings are tagged uploads (manifest.ts), found through
 * the wallet's Submit events; every change is one wallet transaction where
 * the network has batchSubmit (both do), its fee paid by the wallet.
 * See docs/decisions.md D3.
 */
export class V1Backend implements DriveBackend {
  readonly kind = 'v1'
  private events: UploadEvent[] = []
  /**
   * Manifest JSON by the root hash of its stored (encrypted) bytes. A root
   * names one immutable upload, so an entry never goes stale; which root
   * is current still comes from the event scan. Saves re-downloading the
   * index and folders before every action's wallet prompt.
   */
  private manifests = new Map<string, string>()
  /** listings found with no data on the nodes, by root: when */
  private missing = new Map<string, number>()
  /** changes being stored by this page, or finished from this device's copy */
  private finishing = new Set<string>()

  constructor(
    private network: NetworkConfig,
    private signer: ethers.Signer,
    /** Drive master key (32 bytes) — manifests are encrypted with it. */
    private masterKey: Uint8Array,
    private opts: V1BackendOpts = {}
  ) {}

  private progress(msg: string): void {
    this.opts.onProgress?.(msg)
  }

  /** (Re)scan the wallet's upload events from the chain — incrementally
   *  when an eventCache is configured. On a drive load, also finish this
   *  device's interrupted changes. */
  async refresh(load = false): Promise<void> {
    // this action's fee: a fresh price, in the same request as the scan
    if (this.network.batchSubmit) storagePrice(this.network, 0).catch(() => undefined)
    wakeWallet(this.signer)
    const address = await this.signer.getAddress()
    const { events } = await timed('chain', scanUploadsCached(address, this.network, this.opts.eventCache))
    this.events = events
    if (load) await this.finishInterrupted()
  }

  async readManifest(key: string): Promise<string | null> {
    const t = key.toLowerCase()
    const candidates = this.events.filter((e) => e.tags.toLowerCase() === t)
    return candidates.length === 0 ? null : this.downloadManifest(candidates)
  }

  /**
   * Download + decrypt the latest readable manifest among the candidate
   * events (highest block first). Older versions are the fallback when a
   * newer manifest was pruned before sealing — and a candidate that
   * decrypts to non-JSON (e.g. written under a different drive key;
   * AES-CTR decryption never fails loudly) is skipped the same way.
   */
  private async downloadManifest(candidates: UploadEvent[]): Promise<string | null> {
    const sorted = [...candidates].sort((a, b) => b.blockNumber - a.blockNumber)
    const skipped: string[] = []
    for (const event of sorted) {
      const root = event.rootHash.toLowerCase()
      const cached = this.manifests.get(root)
      if (cached !== undefined) return cached
      const missingAt = this.missing.get(root)
      if (this.opts.device?.isAbandoned(root) || (missingAt !== undefined && Date.now() - missingAt < MISSING_RETRY_MS)) {
        skipped.push(`block ${event.blockNumber} txSeq ${event.txSeq}: never uploaded`)
        continue
      }
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
        JSON.parse(text) // a candidate that isn't JSON is skipped
        this.manifests.set(root, text)
        if (skipped.length) {
          console.warn(
            `[drive] newest manifest version(s) unreadable, using block ${event.blockNumber}: ${skipped.join('; ')}`
          )
        }
        return text
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.includes('decryption failed')
        ) {
          throw err // wrong key fails for every candidate — stop
        }
        if (err instanceof NotUploadedError) await this.noteNeverUploaded(event)
        skipped.push(`block ${event.blockNumber} txSeq ${event.txSeq}: ${(err as Error).message}`)
        // this version is unreadable (pruned / not yet stored / non-JSON) —
        // try older
      }
    }
    return null
  }

  /**
   * A listing whose transaction is on chain but whose data never reached
   * the nodes. Skipped for a while in case its upload is still running;
   * once its transaction is old, for good, telling the user the change it
   * belonged to was undone.
   */
  private async noteNeverUploaded(event: UploadEvent): Promise<void> {
    const root = event.rootHash.toLowerCase()
    this.missing.set(root, Date.now())
    const block = await rpcProvider(this.network).getBlock(event.blockNumber).catch(() => null)
    if (!block || Date.now() - block.timestamp * 1000 < (this.opts.abandonedAfterMs ?? ABANDONED_AFTER_MS)) return
    this.opts.device?.markAbandoned(root)
    this.progress(
      `Interrupted change: a change made ${new Date(block.timestamp * 1000).toLocaleString()} never finished ` +
        `uploading (the page closed before its data was sent), so it was undone. Do it again if you still want it.`
    )
  }

  /**
   * Changes this device saved but didn't finish storing: if their
   * transaction is on chain, show them as done now (their listings are
   * here) and send their data in the background, with no new transaction.
   */
  private async finishInterrupted(): Promise<void> {
    const device = this.opts.device
    if (!device) return
    const writes = await device.pending().catch(() => [] as PendingWrite[])
    const onChain = new Set(this.events.map((e) => e.rootHash.toLowerCase()))
    const changes = new Map<string, PendingWrite[]>()
    for (const w of writes) changes.set(w.change, [...(changes.get(w.change) ?? []), w])
    for (const [change, ws] of changes) {
      if (this.finishing.has(change)) continue
      ws.sort((a, b) => a.order - b.order)
      // one transaction: all of its listings landed, or none did
      if (!ws.every((w) => onChain.has(w.root.toLowerCase()))) {
        if (Date.now() - ws[0].savedAt > NEVER_SENT_AFTER_MS) await device.removePending(change).catch(() => undefined)
        continue
      }
      for (const w of ws) {
        const { data, decrypted } = decryptDownloaded(w.bytes, { symmetricKey: this.masterKey })
        if (decrypted) this.manifests.set(w.root.toLowerCase(), new TextDecoder().decode(data))
      }
      this.finishing.add(change)
      void this.finishChange(change, ws).finally(() => this.finishing.delete(change))
    }
  }

  private async finishChange(change: string, ws: PendingWrite[]): Promise<void> {
    this.progress('Interrupted change: sending the data of your last change (no new transaction or fee)…')
    const stage0 = ws.filter((w) => w.stage === 0)
    const ok0 = (await resumeWrites(stage0, this.network, this.signer)).every(Boolean)
    const ok1 = ok0 && (await resumeWrites(ws.filter((w) => w.stage === 1), this.network, this.signer)).every(Boolean)
    if (ok1) {
      await this.opts.device?.removePending(change).catch(() => undefined)
      this.progress('Interrupted change: finished — it is stored now.')
    } else {
      this.progress('Interrupted change: could not send its data yet; will try again on your next visit.')
    }
  }

  /**
   * Records written in the same batch transaction as their files can't
   * know their txSeqs yet (assigned on mining). Fill them in from the
   * wallet's Submit events, which carry root → txSeq for every upload.
   */
  fixRecords(files: FileMeta[]): void {
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

  private batchItem(w: ManifestWrite): BatchItem {
    return {
      data: new TextEncoder().encode(JSON.stringify(w.value)),
      encryption: { type: 'aes256', key: this.masterKey },
      tags: w.key,
    }
  }

  /** what was stored is known: the next action reads it back from here */
  private remember(item: BatchItem, r: BatchItemResult): void {
    if (r.ok) this.manifests.set(r.result.rootHash.toLowerCase(), new TextDecoder().decode(item.data as Uint8Array))
  }

  /**
   * In ONE transaction where batchSubmit is on, else one transaction each.
   * Either way `first` is stored before `then`, and `then` only if all of
   * `first` stored (and sealed, under strict finality).
   */
  async writeManifests(first: ManifestWrite[], then: ManifestWrite[], extras: ManifestWrite[], partial: string): Promise<void> {
    const firstItems = first.map((w) => this.batchItem(w))
    const thenItems = then.map((w) => this.batchItem(w))
    const all = [...firstItems, ...thenItems]
    if (all.length === 0) return
    if (!this.network.batchSubmit) {
      for (let i = 0; i < all.length; i++) {
        try {
          const result = await uploadData(all[i].data as Uint8Array, this.network, this.signer, {
            encryption: all[i].encryption,
            tags: all[i].tags ?? '0x',
            finalityRequired: this.opts.finalityRequired ?? true,
            onProgress: (msg) => this.progress(msg),
          })
          this.remember(all[i], { ok: true, result })
        } catch (err) {
          if (i < first.length || first.length === 0) throw err
          throw new Error(`${partial} (${(err as Error).message})`)
        }
      }
      return
    }
    // a single manifest goes this way too: unlike the SDK's own upload, it
    // asks no storage node anything before the wallet prompt
    const primary = firstItems.length > 0 ? firstItems : thenItems
    // `then` rides as the first extras; optional ones after it, and if they
    // don't store, they stay pending (never this change's error)
    const required = firstItems.length > 0 ? thenItems.length : 0
    const rest = [...(firstItems.length > 0 ? thenItems : []), ...extras.map((w) => this.batchItem(w))]
    // kept on this device until stored (see DriveDevice)
    const device = this.opts.device
    const change = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    let sent = false
    let res: Awaited<ReturnType<typeof uploadBatch>>
    this.finishing.add(change) // a reload meanwhile must not "finish" it too
    try {
      res = await uploadBatch(primary, this.network, this.signer, {
        finalize: rest.length > 0 ? async () => rest : undefined,
        beforeSend: device
          ? (writes) =>
              device
                .savePending(
                  writes.map((w, i) => ({
                    ...w,
                    change,
                    stage: i < primary.length ? 0 : 1,
                    order: i,
                    savedAt: Date.now(),
                  }))
                )
                .catch(() => undefined) // best effort: never blocks the change
          : undefined,
        onSent: () => (sent = true),
        finalityRequired: this.opts.finalityRequired ?? true,
        onProgress: (msg) => this.progress(msg),
      })
      if ([...res.items, ...res.extras].every((r) => r.ok)) await device?.removePending(change).catch(() => undefined)
    } catch (err) {
      // not sent (e.g. rejected in the wallet): nothing to finish later
      if (!sent) await device?.removePending(change).catch(() => undefined)
      throw err
    } finally {
      this.finishing.delete(change)
    }
    res.items.forEach((r, i) => this.remember(primary[i], r))
    res.extras.forEach((r, i) => this.remember(rest[i], r))
    for (const r of res.items) {
      if (!r.ok) throw new Error(`nothing was changed: a listing could not be stored (${r.error})`)
    }
    for (const r of res.extras.slice(0, required)) {
      if (!r.ok) throw new Error(`${partial} (${r.error})`)
    }
  }

  /** Files and their listings in one transaction (batchSubmit networks). */
  async uploadFiles(files: FileUpload[], opts: UploadFilesOpts): Promise<UploadFilesResult> {
    const { finalize, ...batchOpts } = opts
    let records: BatchItem[] = []
    let rest: BatchItem[] = []
    const res = await uploadBatch(files, this.network, this.signer, {
      ...batchOpts,
      finalize: finalize
        ? async (roots) => {
            const out = await finalize(roots.map((root) => ({ rootHashes: [root], txHashes: [] })))
            records = out.records.map((w) => this.batchItem(w))
            rest = [...records, ...out.extras.map((w) => this.batchItem(w))]
            return rest
          }
        : undefined,
    })
    res.extras.forEach((r, i) => this.remember(rest[i], r))
    return {
      files: res.items.map((r) =>
        r.ok
          ? { ok: true as const, ref: { rootHashes: r.result.rootHashes, txHashes: r.result.txHashes, txSeqs: r.result.txSeqs } }
          : { ok: false as const, error: r.error }
      ),
      recordsStored: records.length > 0 && res.extras.slice(0, records.length).every((r) => r.ok),
    }
  }

  download(meta: FileMeta, opts: DownloadOpts = {}) {
    return downloadRecord(this.network, meta, opts)
  }
}

/** A V1 file's bytes by its record (no wallet needed: reads are open). */
export function downloadRecord(network: NetworkConfig, meta: FileMeta, opts: DownloadOpts = {}) {
  return downloadFile(meta.rootHashes, network, { txSeqs: meta.txSeqs, ...opts })
}
