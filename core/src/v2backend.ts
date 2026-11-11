import { ethers } from 'ethers'
import { hkdf } from '@noble/hashes/hkdf'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { cryptAt, newEciesHeader, newSymmetricHeader, parseEncryptionHeader } from '@0gfoundation/0g-storage-ts-sdk'
import { decryptDownloaded } from './storage.js'
import { hexToBytes } from './keystore.js'
import type { DownloadOpts, DownloadResult, EncryptionInput, FileMeta } from './types.js'
import type { DriveBackend, FileUpload, ManifestWrite, StoredRef, UploadFilesOpts, UploadFilesResult } from './backend.js'
import { RelayerClient, RelayerError, type ByteSource } from './v2relayer.js'

/**
 * The drive's current listings: which stored version of each, by key. A
 * change uploads its new listings, then a new root naming them; until the
 * root is stored, nothing of the change shows (one change is all or none).
 */
interface Root {
  v: 1
  /** one more than the root it replaced */
  seq: number
  at: number
  listings: Record<string, ListingRef>
  /**
   * What this root made obsolete: the root it replaced and the listing
   * versions it replaced. They are deleted (rent stops) one change later,
   * so a reader still on the previous root can finish reading it.
   */
  retired: string[]
}

interface ListingRef {
  /** data hash, 64 hex digits */
  h: string
  /** stored size */
  n: number
}

interface FoundRoot {
  root: Root
  hash: string
}

export interface V2BackendOpts {
  onProgress?: (msg: string) => void
  /** files uploaded at once (each sends a few parts in parallel; the relayer allows 8 per account) */
  fileConcurrency?: number
}

/** a root's file starts with this many bytes of tag (see rootTag) */
const TAG_BYTES = 32
const ROOT_TAG_INFO = '0gdrive/root-tag/v1'
/** listings uploaded at once */
const LISTING_CONCURRENCY = 3
/** bytes encrypted at a time on reads of an EncryptedSource */
const ENC_PIECE = 4 * 1024 * 1024

/** after storing a root, look for one stored at the same time this long after */
const VERIFY_AFTER_MS = 1000
/** roots stored again over another device's, at most */
const MERGE_ROUNDS = 3

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const strip0x = (h: string) => h.replace(/^0x/i, '').toLowerCase()
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * Bytes as stored: an encryption header (the SDK's, as on V1, so the same
 * decryption reads both), then the payload encrypted as it is read.
 */
class EncryptedSource implements ByteSource {
  readonly size: number
  private header: Uint8Array
  private nonce: Uint8Array
  private key: Uint8Array

  constructor(
    private plain: Blob,
    enc: EncryptionInput
  ) {
    const made = enc.type === 'aes256' ? { header: newSymmetricHeader(), key: enc.key } : newEciesHeader(enc.recipientPubKey)
    this.header = made.header.toBytes()
    this.nonce = made.header.nonce
    this.key = made.key
    this.size = this.header.length + plain.size
  }

  async slice(from: number, to: number): Promise<Uint8Array> {
    const out = new Uint8Array(to - from)
    const hl = this.header.length
    if (from < hl) out.set(this.header.subarray(from, Math.min(to, hl)))
    for (let at = Math.max(from, hl); at < to; at += ENC_PIECE) {
      const end = Math.min(to, at + ENC_PIECE)
      const piece = new Uint8Array(await this.plain.slice(at - hl, end - hl).arrayBuffer())
      cryptAt(this.key, this.nonce, at - hl, piece) // offsets are payload-relative
      out.set(piece, at - from)
    }
    return out
  }
}

const asBlob = (data: Blob | Uint8Array) => (data instanceof Uint8Array ? new Blob([data as BlobPart]) : data)

/**
 * 0G Storage V2 through the relayer (v2relayer.ts). No transactions: the
 * storage account (derived from the recovery signature) signs statements
 * locally, and its balance in the PaymentVault pays rent. See D18 in
 * docs/decisions.md.
 *
 * Listings are encrypted files; a root (also encrypted) names the current
 * version of each, and is found as the newest of the account's files that
 * starts with this account's root tag. Superseded versions are deleted a
 * change later, so the account doesn't pay rent for history.
 */
export class V2Backend implements DriveBackend {
  readonly kind = 'v2'
  private current: FoundRoot | null = null
  /** listing JSON by data hash (stored bytes never change) */
  private texts = new Map<string, string>()
  /** account files seen not to be roots */
  private notRoots = new Set<string>()
  /** one change at a time: each reads the latest root and replaces it */
  private writing: Promise<unknown> = Promise.resolve()
  private tag: Uint8Array

  constructor(
    readonly relayer: RelayerClient,
    /** the storage account: owns and pays for the drive's files */
    private account: ethers.Wallet,
    /** Drive master key (32 bytes): listings and roots are encrypted with it. */
    private masterKey: Uint8Array,
    private opts: V2BackendOpts = {}
  ) {
    // keyed by the account, not the drive key: a wrong drive key still finds
    // the root, and fails loudly instead of showing an empty drive
    const tagKey = hkdf(sha256, ethers.getBytes(account.privateKey), undefined, ROOT_TAG_INFO, 32)
    this.tag = hmac(sha256, tagKey, new TextEncoder().encode('root'))
  }

  get address(): string {
    return this.account.address
  }

  async refresh(): Promise<void> {
    this.current = this.newer(await this.findRoot(), this.current)
  }

  /**
   * The later of the newest listed root and the one held. A root may be
   * listed a moment after it's stored, so an older listed one never wins;
   * one as new as ours but not ours is another device's change made at the
   * same time, and wins (commit then lays ours over it).
   */
  private newer(found: FoundRoot | null, held: FoundRoot | null): FoundRoot | null {
    if (!found) return held
    if (!held) return found
    return found.root.seq >= held.root.seq ? found : held
  }

  /** The newest root among the account's files, or null for a new drive. */
  private async findRoot(): Promise<FoundRoot | null> {
    let before: string | undefined
    for (;;) {
      const page = await this.relayer.list(this.account.address, { limit: 100, before })
      for (const f of page.files) {
        const hash = strip0x(f.dataHash)
        if (this.current?.hash === hash) return this.current
        if (this.notRoots.has(hash)) continue
        if (f.fileSize > TAG_BYTES && sameBytes(await this.relayer.head(hash, TAG_BYTES), this.tag)) {
          return { root: await this.readRoot(hash, f.fileSize), hash }
        }
        this.notRoots.add(hash)
      }
      if (!page.next || page.files.length === 0) return null
      before = page.next
    }
  }

  private async readRoot(hash: string, size: number): Promise<Root> {
    const { blob } = await this.relayer.download(hash, { size })
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const root = this.decryptJson<Root>(bytes.subarray(TAG_BYTES))
    if (root?.v !== 1 || typeof root.listings !== 'object') {
      throw new Error('Manifest decryption failed — wrong drive key for this account')
    }
    return root
  }

  /** JSON encrypted with the drive key, or null when it isn't (wrong key, or not ours). */
  private decryptJson<T>(stored: Uint8Array): T | null {
    const { data, decrypted } = decryptDownloaded(stored, { symmetricKey: this.masterKey })
    if (!decrypted) return null
    try {
      return JSON.parse(new TextDecoder().decode(data)) as T
    } catch {
      return null
    }
  }

  async readManifest(key: string): Promise<string | null> {
    for (let attempt = 0; ; attempt++) {
      const ref = this.current?.root.listings[key]
      if (!ref) return null
      const cached = this.texts.get(ref.h)
      if (cached !== undefined) return cached
      try {
        const { blob } = await this.relayer.download(ref.h, { size: ref.n })
        const value = this.decryptJson<unknown>(new Uint8Array(await blob.arrayBuffer()))
        if (value === null) throw new Error('Manifest decryption failed — wrong drive key for this account')
        const text = JSON.stringify(value)
        this.texts.set(ref.h, text)
        return text
      } catch (err) {
        // gone: another device replaced it two changes ago; read its latest root
        if (!(err instanceof RelayerError && (err.status === 404 || err.status === 410)) || attempt > 0) throw err
        await this.refresh()
      }
    }
  }

  /** Encrypt and upload one listing; its ref. */
  private async storeListing(w: ManifestWrite): Promise<ListingRef> {
    const text = JSON.stringify(w.value)
    const src = new EncryptedSource(new Blob([text]), { type: 'aes256', key: this.masterKey })
    const r = await this.relayer.upload(this.account, src)
    this.texts.set(r.dataHash, text)
    return { h: r.dataHash, n: src.size }
  }

  /** Upload listings a few at a time; per listing, its ref or its error. */
  private async storeListings(ws: ManifestWrite[]): Promise<({ ok: true; ref: ListingRef } | { ok: false; error: string })[]> {
    const out: ({ ok: true; ref: ListingRef } | { ok: false; error: string })[] = new Array(ws.length)
    let next = 0
    const worker = async () => {
      while (next < ws.length) {
        const i = next++
        try {
          out[i] = { ok: true, ref: await this.storeListing(ws[i]) }
        } catch (err) {
          out[i] = { ok: false, error: (err as Error).message }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(LISTING_CONCURRENCY, ws.length) }, worker))
    return out
  }

  /**
   * One change: its listings, then a root naming them. All of `first` and
   * `then` are required (on V2 nothing shows until the root is stored, so
   * their order doesn't matter and a change is never half done); extras
   * join the root only if they stored.
   */
  writeManifests(first: ManifestWrite[], then: ManifestWrite[], extras: ManifestWrite[], _partial: string): Promise<void> {
    const run = this.writing.then(() => this.change([...first, ...then], extras))
    this.writing = run.catch(() => undefined)
    return run
  }

  private async change(required: ManifestWrite[], extras: ManifestWrite[]): Promise<void> {
    if (required.length === 0) return
    const stored = await this.storeListings([...required, ...extras])
    const failed = stored.slice(0, required.length).find((r) => !r.ok)
    if (failed && !failed.ok) throw new Error(`nothing was changed: a listing could not be stored (${failed.error})`)
    const refs: Record<string, ListingRef> = {}
    ;[...required, ...extras].forEach((w, i) => {
      const r = stored[i]
      if (r.ok) refs[w.key] = r.ref
    })
    await this.commit(refs)
  }

  /**
   * Store a root naming `refs` over the latest root's listings. Then look
   * again: if another device stored a root at the same time, ours may not
   * be the one readers find, so lay `refs` over theirs and store again.
   */
  private async commit(refs: Record<string, ListingRef>): Promise<void> {
    let ours: FoundRoot | null = null
    for (let round = 0; ; round++) {
      // the latest: another device may have changed the drive since our last read
      const base = this.newer(await this.findRoot(), this.current)
      const kept = base !== null && Object.entries(refs).every(([key, ref]) => base.root.listings[key]?.h === ref.h)
      if (ours && (kept || round > MERGE_ROUNDS)) return
      ours = await this.storeRoot(base, refs, ours)
      await sleep(VERIFY_AFTER_MS)
    }
  }

  private async storeRoot(base: FoundRoot | null, refs: Record<string, ListingRef>, replacing: FoundRoot | null): Promise<FoundRoot> {
    const retired = Object.entries(refs)
      .map(([key, ref]) => base?.root.listings[key]?.h !== ref.h && base?.root.listings[key]?.h)
      .filter((h): h is string => typeof h === 'string')
    // a root of ours that lost to another device's is obsolete too
    if (replacing && replacing.hash !== base?.hash) retired.unshift(replacing.hash)
    if (base) retired.unshift(base.hash)
    const root: Root = {
      v: 1,
      seq: (base?.root.seq ?? 0) + 1,
      at: Date.now(),
      listings: { ...base?.root.listings, ...refs },
      retired,
    }
    const src = new EncryptedSource(new Blob([JSON.stringify(root)]), { type: 'aes256', key: this.masterKey })
    const tagged: ByteSource = {
      size: TAG_BYTES + src.size,
      slice: async (from, to) => {
        const out = new Uint8Array(to - from)
        if (from < TAG_BYTES) out.set(this.tag.subarray(from, Math.min(to, TAG_BYTES)))
        if (to > TAG_BYTES) out.set(await src.slice(Math.max(from, TAG_BYTES) - TAG_BYTES, to - TAG_BYTES), Math.max(0, TAG_BYTES - from))
        return out
      },
    }
    const r = await this.relayer.upload(this.account, tagged)
    this.current = { root, hash: r.dataHash }
    // what the replaced root retired is now two changes old: stop paying for it
    if (base) void this.deleteAll(base.root.retired)
    return this.current
  }

  /** Best effort, in the background: a file left behind only costs rent. */
  private async deleteAll(hashes: string[]): Promise<void> {
    for (const h of hashes) {
      await this.relayer.delete(this.account, h).catch((err) => {
        if (!(err instanceof RelayerError && (err.status === 404 || err.status === 410))) console.warn(`[drive] could not delete ${h}: ${(err as Error).message}${err instanceof RelayerError ? ` (${err.reason})` : ''}`)
      })
    }
  }

  /**
   * Files, then (when every one stored) their records in the same change.
   * If some fail, the stored ones' records are left to the caller
   * (recordsStored false), as on V1.
   */
  async uploadFiles(files: FileUpload[], opts: UploadFilesOpts): Promise<UploadFilesResult> {
    const results: UploadFilesResult['files'] = new Array(files.length)
    let next = 0
    const worker = async () => {
      while (next < files.length) {
        const i = next++
        const f = files[i]
        opts.onItem?.(i, 'uploading')
        try {
          const plain = asBlob(f.data)
          const src: ByteSource = f.encryption ? new EncryptedSource(plain, f.encryption) : plain
          const r = await this.relayer.upload(this.account, src, {
            onProgress: (sent, total) => opts.onItemProgress?.(i, 'sending', total ? sent / total : 1),
          })
          results[i] = { ok: true, ref: { rootHashes: ['0x' + r.dataHash], txHashes: [] } }
          opts.onItem?.(i, 'done')
        } catch (err) {
          results[i] = { ok: false, error: (err as Error).message }
          opts.onItem?.(i, 'error', (err as Error).message)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.opts.fileConcurrency ?? 2, files.length) }, worker))

    let recordsStored = false
    if (opts.finalize) {
      const none: StoredRef = { rootHashes: [], txHashes: [] }
      const { records, extras } = await opts.finalize(results.map((r) => (r.ok ? r.ref : none)))
      if (records.length > 0 && results.every((r) => r.ok)) {
        opts.onItem?.(files.length, 'uploading')
        try {
          await this.writeManifests(records, [], extras, '')
          recordsStored = true
        } catch (err) {
          console.warn(`[drive] records not stored with the files: ${(err as Error).message}`)
        }
      }
    }
    return { files: results, recordsStored }
  }

  fixRecords(_files: FileMeta[]): void {}

  async download(meta: FileMeta, opts: DownloadOpts = {}): Promise<DownloadResult> {
    if (meta.rootHashes.length !== 1) throw new Error('not a V2 file record')
    const { blob } = await this.relayer.download(strip0x(meta.rootHashes[0]), {
      onProgress: (got, total) => opts.onProgress?.(`Downloading ${got} of ${total} bytes`, total > 0 ? Math.round((got / total) * 100) : undefined),
    })
    const stored = new Uint8Array(await blob.arrayBuffer())
    if (!opts.decryption) {
      opts.onPlainChunk?.(stored)
      return { data: opts.onPlainChunk ? new Uint8Array(0) : stored, decrypted: true }
    }
    if (opts.onPlainChunk && opts.decryption.symmetricKey) {
      // AES-256 (v1 header): decrypt and hand over a piece at a time
      const header = parseEncryptionHeader(stored)
      if (header.version !== 1) throw new Error('Streaming download supports AES-256 (v1) files only')
      const key = typeof opts.decryption.symmetricKey === 'string' ? hexToBytes(opts.decryption.symmetricKey) : opts.decryption.symmetricKey
      const body = stored.subarray(header.size())
      for (let at = 0; at < body.length; at += ENC_PIECE) {
        const piece = body.slice(at, at + ENC_PIECE)
        cryptAt(key, header.nonce, at, piece)
        opts.onPlainChunk(piece)
      }
      return { data: new Uint8Array(0), decrypted: true }
    }
    return decryptDownloaded(stored, opts.decryption)
  }
}
