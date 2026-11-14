import type { BatchOpts } from './storage.js'
import type { DownloadOpts, DownloadResult, EncryptionInput, FileMeta } from './types.js'

/**
 * Where a drive keeps its data: the seam between the drive's logic
 * (DriveStore: folders, trash, names, search entries) and a storage
 * network. V1Backend is 0G Storage as the drive has always used it; a V2
 * backend (the relayer, v2relayer.ts) implements the same contract.
 *
 * The drive's metadata is a set of small encrypted listings (the index,
 * one per folder, the trash), each under a stable key (manifest.ts's tags).
 * A backend stores a new version of any of them and reads back the latest
 * readable one; how it finds "latest" is its own business (V1: tagged
 * Submit events; V2: a root listing uploaded last). Listings go in and come
 * out as plain JSON: the backend encrypts them with the drive master key.
 */
export interface DriveBackend {
  readonly kind: 'v1' | 'v2'

  /**
   * Bring this backend's view of the drive up to date (before every
   * read-modify-write). `load`: the drive is being loaded, a time to
   * finish what this device left unfinished.
   */
  refresh(load?: boolean): Promise<void>

  /**
   * The latest readable version of the listing under `key` (its JSON), or
   * null when it has none. Throws when the drive key is wrong.
   */
  readManifest(key: string): Promise<string | null>

  /**
   * Store new versions of listings as one change. `first` is stored before
   * `then`, and `then` only once all of `first` is (callers put first what
   * must not be lost, so a failure part-way duplicates a record rather than
   * dropping it). `extras` are optional and ride along: their failure is
   * never the change's. Throws `partial` (with the reason) when `first`
   * stored but `then` didn't.
   */
  writeManifests(first: ManifestWrite[], then: ManifestWrite[], extras: ManifestWrite[], partial: string): Promise<void>

  /**
   * Upload files and, in the same change, the listings that record them:
   * `finalize` gets each file's storage fields (FileMeta's) once they are
   * known and answers the listings to store with them.
   */
  uploadFiles(files: FileUpload[], opts: UploadFilesOpts): Promise<UploadFilesResult>

  /** Storage fields this backend fills in on records read from a listing (V1: txSeqs). */
  fixRecords(files: FileMeta[]): void

  /** A file's bytes by its record; decrypted when `decryption` is given. */
  download(meta: FileMeta, opts?: DownloadOpts): Promise<DownloadResult>

  /**
   * Files whose records were just dropped for good (purged, deleted from
   * trash): delete their bytes where the network can (V2: rent stops).
   * Best effort; never throws.
   */
  discard(files: FileMeta[]): Promise<void>

  /**
   * The drive's current version (after refresh), changing with every change
   * stored from any device; null for a new drive.
   */
  version(): string | null

  /** Keys of every listing the drive's current version names (after refresh). */
  listingKeys(): string[]

  /**
   * Delete the account's stored files nothing needs any more (a deletion
   * that failed, an upload whose change never stored): every file but the
   * drive's own current version and what it still needs, the files in
   * `keep` (data hashes of every file record), and anything stored less
   * than `minAgeMs` ago (another device's upload whose change is still to
   * come). How many it deleted.
   */
  sweep(keep: Set<string>, minAgeMs: number): Promise<number>
}

/** One listing to store: its key and its contents. */
export interface ManifestWrite {
  key: string
  value: unknown
}

export interface FileUpload {
  data: Blob | Uint8Array
  encryption?: EncryptionInput
}

/** FileMeta's storage fields: where a file's bytes are. */
export type StoredRef = Pick<FileMeta, 'rootHashes' | 'txHashes' | 'txSeqs'>

export interface UploadFilesOpts
  extends Pick<BatchOpts, 'segmentHasher' | 'onItemProgress' | 'onProgress' | 'onItem' | 'finalityRequired'> {
  finalize?: (refs: StoredRef[]) => Promise<{ records: ManifestWrite[]; extras: ManifestWrite[] }>
}

export interface UploadFilesResult {
  /** per file: stored, with its storage fields as final as they get; or why not */
  files: ({ ok: true; ref: StoredRef } | { ok: false; error: string })[]
  /** every listing `finalize` returned as `records` was stored with the files */
  recordsStored: boolean
}
