export type EncryptionMode = 'aes256' | 'ecies' | 'none'

export type EncryptionInput =
  | { type: 'aes256'; key: Uint8Array }
  | { type: 'ecies'; recipientPubKey: Uint8Array | string }

export interface DecryptionInput {
  symmetricKey?: Uint8Array | string
  privateKey?: Uint8Array | string
}

/** Normalized upload result: arrays always populated; single-file convenience getters. */
export interface UploadResult {
  fragmented: boolean
  rootHashes: string[]
  txHashes: string[]
  txSeqs: number[]
  /** First root hash (the file ID for single-fragment uploads). */
  rootHash: string
  txHash: string
  txSeq: number
}

export interface DownloadResult {
  data: Uint8Array
  /** false when the file was encrypted but decryption failed (wrong key) — data is ciphertext. */
  decrypted: boolean
}

/** M1 local file record (replaced by 0G-KV metadata in M2). */
export interface FileMeta {
  id: string
  name: string
  size: number
  mime: string
  uploadedAt: number
  encryption: EncryptionMode
  rootHashes: string[]
  txHashes: string[]
  /** Storage txSeqs parallel to rootHashes (by-txSeq download fallback). */
  txSeqs?: number[]
  /**
   * Per-file content key wrapped under the drive master key (M3 model).
   * Absent on pre-M3 records, which were encrypted with the master key
   * directly (and therefore cannot be link-shared).
   */
  wrappedKey?: string
  /** Share bookkeeping — no longer written (sharing needs no chain write);
   *  kept so older manifests still parse. */
  shares?: ShareRecord[]
  network: string // e.g. "testnet:turbo"
  /** Set on records in the trash folder: the folder they were removed from. */
  originalPath?: string
  /**
   * Small thumbnail (data:image/webp|jpeg, a few KB), generated client-side
   * at upload. Lives inside the folder manifest, which is encrypted with the
   * master key — so it is as private as the file name, and costs no extra
   * transactions.
   */
  thumb?: string
  /**
   * On-device search index entry (Phase 1 AI), generated at upload. Stored
   * in the encrypted folder manifest alongside the record.
   */
  search?: SearchEntry
}

/**
 * Compact, versioned search data for one file. Vectors are int8-quantized,
 * L2-normalized embeddings, base64-encoded.
 */
export interface SearchEntry {
  v: 1
  /** Leading extracted text (≤280 chars) — shown in results, matched by name search. */
  t?: string
  /** Photo tags (CLIP zero-shot), English. */
  g?: string[]
  /** paraphrase-multilingual-MiniLM-L12-v2 passage embedding (384-d). */
  e?: string
  /** CLIP ViT-B/32 image embedding (512-d), photos only. */
  c?: string
}

export interface ProgressFn {
  (message: string, percent?: number): void
}

export interface UploadOpts {
  encryption?: EncryptionInput
  onProgress?: ProgressFn
  /** Wait for sector sealing before returning (default true). */
  finalityRequired?: boolean
  /**
   * Max time to wait for sector sealing before erroring (default 15 min).
   * The file may still seal later; the error tells the user to keep their
   * local copy.
   */
  finalityTimeoutMs?: number
  /**
   * Max automatic repair passes (re-upload of missing segments, no new
   * fee) while waiting for sealing. Default 2.
   */
  maxRepairs?: number
  /**
   * Transaction tags (hex). Tags are recorded on-chain in the Flow
   * contract's Submit event, so uploads can be discovered by tag without
   * downloading them. Used by the manifest layer (see manifest.ts).
   */
  tags?: string
}

export interface ShareRecord {
  mode: 'link' | 'ecies'
  /** Recipient address (ecies mode) or empty (link mode). */
  recipient?: string
  sharedAt: number
}

export interface DownloadOpts {
  decryption?: DecryptionInput
  onProgress?: ProgressFn
  /**
   * Storage txSeqs parallel to rootHashes — used as the fallback access
   * path when a node's root-hash lookup fails for a file.
   */
  txSeqs?: number[]
  /**
   * Streaming sink: when set, decrypted plaintext chunks are delivered in
   * order as they arrive and `data` in the result is left empty. Lets
   * large files be written to disk incrementally (File System Access API)
   * instead of buffered in memory. Supports unencrypted and AES-256 (v1)
   * files; ECIES (v2) files must use the buffered path.
   */
  onPlainChunk?: (chunk: Uint8Array) => void
}

/** Minimal structural view of the FileInfo returned by zgs_getFileInfo. */
export interface FileInfoLike {
  tx: { seq: number; size: number; startEntryIndex: number }
  finalized: boolean
  isCached: boolean
  uploadedSegNum: number
}
