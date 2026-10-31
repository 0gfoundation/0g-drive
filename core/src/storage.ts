import { ethers } from 'ethers'
import {
  Indexer,
  MemData,
  Blob as ZgBlob,
  StorageNode,
  tryDecrypt,
  newEciesEncryptedFile,
  newSymmetricEncryptedFile,
  cryptAt,
  parseEncryptionHeader,
  getFlowContract,
  getMarketContract,
} from '@0gfoundation/0g-storage-ts-sdk'
import type { UploadOption, ShardedNode, ShardedNodes } from '@0gfoundation/0g-storage-ts-sdk'
import type { NetworkConfig } from './config.js'
import { hexToBytes } from './keystore.js'
import { foldNodesToRoot, rpcProvider } from './events.js'
import type {
  DecryptionInput,
  DownloadOpts,
  DownloadResult,
  EncryptionInput,
  FileInfoLike,
  ProgressFn,
  UploadOpts,
  UploadResult,
} from './types.js'

/** Anything Indexer.upload accepts (ZgFile, MemData, browser Blob, …). */
type Uploadable = Parameters<Indexer['upload']>[0]

/**
 * Indexer with a short-lived node-list cache: getShardedNodes is an RPC
 * roundtrip the SDK makes before every upload and every finality poll,
 * but the trusted set changes rarely. Caching it trims pre-prompt latency
 * and poll traffic.
 */
const SHARD_CACHE_MS = 60_000
const shardCache = new Map<string, { at: number; nodes: ShardedNodes }>()

/**
 * Storage nodes only speak plain HTTP (`http://<ip>:5678`), which browsers
 * block from https pages (mixed content). With a relay set, every node URL
 * the indexer hands out becomes `<relay><ip>:<port>`, an https endpoint on
 * the app's own origin that forwards to the node (web/api/node.ts). All
 * node traffic — upload, finality checks, repair, download — gets its
 * StorageNode from these lists, so rewriting them here covers every path.
 */
let nodeRelay: string | null = null

/** Route storage-node calls through `base` (e.g. `https://drive.0g.ai/_node/`); null for direct. */
export function setNodeRelay(base: string | null): void {
  nodeRelay = base
}

function viaRelay<T extends { url: string }>(node: T): T {
  const m = nodeRelay ? /^http:\/\/([^/]+)\/?$/.exec(node.url) : null
  return m ? { ...node, url: nodeRelay + m[1] } : node
}

class SessionIndexer extends Indexer {
  private key: string
  constructor(url: string) {
    super(url)
    this.key = url
  }
  async getShardedNodes(): Promise<ShardedNodes> {
    const hit = shardCache.get(this.key)
    let nodes = hit && Date.now() - hit.at < SHARD_CACHE_MS ? hit.nodes : null
    if (!nodes) {
      nodes = await super.getShardedNodes()
      shardCache.set(this.key, { at: Date.now(), nodes })
    }
    return {
      trusted: (nodes.trusted ?? []).map(viaRelay),
      discovered: (nodes.discovered ?? []).map(viaRelay),
    }
  }
  async getFileLocations(rootHash: string): Promise<ShardedNode[]> {
    return (await super.getFileLocations(rootHash)).map(viaRelay)
  }
}
/**
 * The SDK's ethers Signer type. Cast needed at the boundary: the SDK's
 * generated types resolve ethers' commonjs build while this package
 * resolves the ESM build, so the nominal types disagree despite being
 * the same runtime class.
 */
type SdkSigner = Parameters<Indexer['upload']>[2]

const REPAIR_GRACE_MS = 90_000 // wait before the first repair pass
const REPAIR_INTERVAL_MS = 5 * 60_000
const SEAL_POLL_MS = 5_000
const DEFAULT_FINALITY_TIMEOUT_MS = 15 * 60_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wrap a file with client-side encryption (same helpers the SDK uses
 * internally). Wrapping once here — instead of passing `encryption` to
 * Indexer.upload — keeps the encrypted file instance stable across the
 * initial upload and repair passes: ECIES derives a per-instance ephemeral
 * key, so re-wrapping would produce a different root hash.
 */
function wrapEncryption(file: Uploadable, enc: EncryptionInput): Uploadable {
  return enc.type === 'aes256'
    ? newSymmetricEncryptedFile(file, enc.key)
    : newEciesEncryptedFile(file, enc.recipientPubKey)
}

const CHUNK_SIZE = 256
const SEGMENT_MAX_CHUNKS = 1024
const SEGMENT_SIZE = CHUNK_SIZE * SEGMENT_MAX_CHUNKS // 256 KB
const ROOT_HASH_REGEX = /^0x[0-9a-fA-F]{64}$/
/** segments prefetched per file (they still queue for a request slot) */
const SEGMENT_CONCURRENCY = 6
/** full passes over a segment's nodes before a download fails */
const SEGMENT_ROUNDS = 3

/**
 * App-wide limit on segment requests in flight. Browsers allow ~6
 * connections per host and the RPC timeout (30 s) counts time spent queued
 * behind them, so parallel downloads (preview + thumbnails + indexing) on a
 * slow link could time out on every node at once. Requests wait here
 * instead, and the limit halves on a failure and creeps back on successes.
 */
const segmentSlots = (() => {
  const MAX = 6
  let limit = MAX
  let active = 0
  let streak = 0
  const waiting: (() => void)[] = []
  const pump = () => {
    while (active < limit && waiting.length) {
      active++
      waiting.shift()!()
    }
  }
  return {
    async acquire(): Promise<(ok: boolean) => void> {
      await new Promise<void>((resolve) => {
        waiting.push(resolve)
        pump()
      })
      let released = false
      return (ok: boolean) => {
        if (released) return
        released = true
        active--
        if (ok) {
          if (++streak >= limit * 2 && limit < MAX) {
            limit++
            streak = 0
          }
        } else {
          limit = Math.max(1, Math.floor(limit / 2))
          streak = 0
        }
        pump()
      }
    },
  }
})()

function ceilDiv(total: number, unit: number): number {
  return Math.floor((total - 1) / unit + 1)
}

async function uploadAbstract(
  file: Uploadable,
  network: NetworkConfig,
  signer: ethers.Signer,
  opts: UploadOpts
): Promise<UploadResult> {
  const indexer = new SessionIndexer(network.indexerRpc)

  let payload: Uploadable = file
  if (opts.encryption) {
    payload = wrapEncryption(file, opts.encryption)
  }

  // NOTE: no merkleTree() call here — the SDK's uploadFile computes it
  // internally and does NOT cache, so a pre-call would hash the whole
  // file twice. (Halved the pre-prompt delay for large uploads.)

  // Never let the SDK block on finality internally: its wait loop polls
  // every selected node with no timeout, so a single node missing a
  // segment hangs the upload forever (observed on testnet). We enforce
  // strict finality ourselves — bounded, with repair — in ensureFinality.
  const uploadOpts: UploadOption = {
    onProgress: opts.onProgress,
    finalityRequired: false,
    tags: opts.tags ?? '0x',
  }

  opts.onProgress?.('Uploading to 0G Storage…')
  const [tx, uploadErr] = await indexer.upload(
    payload,
    network.rpcUrl,
    signer as unknown as SdkSigner,
    uploadOpts
  )
  if (uploadErr !== null) {
    throw new Error(`Upload failed: ${uploadErr}`)
  }

  const single = 'rootHash' in tx
  const result: UploadResult = {
    fragmented: !single,
    rootHashes: single ? [tx.rootHash] : tx.rootHashes,
    txHashes: single ? [tx.txHash] : tx.txHashes,
    txSeqs: single ? [tx.txSeq] : tx.txSeqs,
    rootHash: single ? tx.rootHash : tx.rootHashes[0],
    txHash: single ? tx.txHash : tx.txHashes[0],
    txSeq: single ? tx.txSeq : tx.txSeqs[0],
  }

  // Strict default (user decision): block until every shard node in the
  // covering set has sealed the sector — with a timeout and automatic
  // repair for missing segments instead of an unbounded hang.
  if (opts.finalityRequired ?? true) {
    await ensureFinality(payload, indexer, network, signer, result.rootHashes, opts)
  }
  return result
}

interface SealStatus {
  /** true when every node in the covering set reports the file finalized */
  sealed: boolean
  /** true when at least one node knows the log entry (safe to repair) */
  visible: boolean
}

async function sealStatus(
  indexer: Indexer,
  rootHashes: string[]
): Promise<SealStatus> {
  const [nodes, err] = await indexer.selectNodes(1)
  if (err !== null || nodes.length === 0) {
    return { sealed: false, visible: false }
  }
  let sealed = true
  let visible = false
  for (const root of rootHashes) {
    for (const node of nodes) {
      let info: FileInfoLike | null = null
      try {
        info = (await node.getFileInfo(root, true)) as unknown as FileInfoLike
      } catch {
        // node unreachable — treat as not sealed, keep checking the rest
      }
      if (info !== null) visible = true
      if (info === null || !info.finalized) sealed = false
    }
  }
  return { sealed, visible }
}

/**
 * Enforce strict finality with a timeout. If sealing stalls (observed
 * cause: a segment that never landed on its shard node), re-upload the
 * file with skipTx — no new fee, the log entry already exists — which
 * targets only unfinalized nodes and re-sends their shard's segments.
 */
async function ensureFinality(
  payload: Uploadable,
  indexer: Indexer,
  network: NetworkConfig,
  signer: ethers.Signer,
  rootHashes: string[],
  opts: UploadOpts
): Promise<void> {
  const timeoutMs = opts.finalityTimeoutMs ?? DEFAULT_FINALITY_TIMEOUT_MS
  const maxRepairs = opts.maxRepairs ?? 2
  const deadline = Date.now() + timeoutMs
  let repairs = 0
  let nextRepairAt = Date.now() + REPAIR_GRACE_MS

  while (Date.now() < deadline) {
    const status = await sealStatus(indexer, rootHashes)
    if (status.sealed) {
      opts.onProgress?.('Sector sealed — file stored permanently.')
      return
    }

    if (
      repairs < maxRepairs &&
      status.visible &&
      Date.now() >= nextRepairAt
    ) {
      repairs++
      nextRepairAt = Date.now() + REPAIR_INTERVAL_MS
      opts.onProgress?.(
        `Sealing incomplete — re-uploading missing segments (pass ${repairs}/${maxRepairs})…`
      )
      try {
        const [, repairErr] = await indexer.upload(
          payload,
          network.rpcUrl,
          signer as unknown as SdkSigner,
          {
            skipTx: true, // log entry exists — must not pay the fee again
            // the SDK's skip check asks ONE node; a node holding no segment
            // of a small file reports it "finalized", which would make this
            // repair a silent no-op for the node that actually needs it
            skipIfFinalized: false,
            finalityRequired: false,
            onProgress: opts.onProgress,
          }
        )
        if (repairErr !== null) {
          opts.onProgress?.(`Repair pass incomplete: ${repairErr.message}`)
        }
      } catch (err) {
        opts.onProgress?.(`Repair pass failed: ${(err as Error).message}`)
      }
      continue
    }

    opts.onProgress?.('Waiting for sector sealing…')
    await sleep(SEAL_POLL_MS)
  }

  throw new Error(
    `Sector sealing not confirmed within ${Math.round(timeoutMs / 60_000)} minutes ` +
      `(root ${rootHashes[0]}). The data is uploaded and retrievable, and may ` +
      `still seal later — but permanence is not yet guaranteed. Keep your ` +
      `local copy and retry the upload later.`
  )
}

// ─── Batch upload: many blobs, ONE transaction ─────────────────────────
//
// The Flow contract's batchSubmit registers several submissions in one
// transaction (one wallet prompt, one fee transfer). Segments are then
// uploaded per blob with skipTx — through a signer that refuses to sign, so
// a node that hasn't seen the log entry yet can never trigger a second,
// paid transaction. Verified on Galileo: scripts/test-batch-submit.mjs.

export interface BatchItem {
  data: Uint8Array | Blob
  encryption?: EncryptionInput
  tags?: string
}

export type BatchPhase = 'preparing' | 'approve' | 'uploading' | 'sealing' | 'done' | 'skipped' | 'error'

export interface BatchOpts {
  /** Per-item progress; indexes cover primary items, then finalize() items. */
  onItem?: (index: number, phase: BatchPhase, message?: string) => void
  onProgress?: ProgressFn
  /**
   * Called once every primary item's root is known, before the transaction.
   * Returns items that ride in the SAME transaction (e.g. the manifest that
   * lists the files). Their segments upload last — and only if every
   * primary item stored (and sealed, under strict finality); otherwise
   * their log entries stay empty and readers fall back to older versions.
   */
  finalize?: (roots: string[]) => Promise<BatchItem[]>
  finalityRequired?: boolean
  finalityTimeoutMs?: number
  maxRepairs?: number
}

export type BatchItemResult =
  | { ok: true; result: UploadResult }
  | { ok: false; error: string; skipped?: boolean }

export interface BatchResult {
  txHash: string
  /** Primary items, in order. */
  items: BatchItemResult[]
  /** finalize() items, in order. */
  extras: BatchItemResult[]
}

const FRAGMENT_LIMIT = 4 * 1024 * 1024 * 1024 // SDK default fragment size
const VISIBLE_TIMEOUT_MS = 4 * 60_000

/** A view of `signer` that can read its address but never send a transaction. */
function noTxSigner(signer: ethers.Signer): ethers.Signer {
  return new Proxy(signer, {
    get(target, prop, recv) {
      if (prop === 'sendTransaction' || prop === 'signTransaction') {
        return () => {
          throw new Error('refused: segment upload attempted a new storage transaction')
        }
      }
      const v = Reflect.get(target, prop, recv)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

/** Wait until every selected storage node has the log entry for `root`. */
async function waitVisible(indexer: Indexer, root: string): Promise<void> {
  const deadline = Date.now() + VISIBLE_TIMEOUT_MS
  while (Date.now() < deadline) {
    const [nodes, err] = await indexer.selectNodes(1)
    if (err === null && nodes.length > 0) {
      let seen = 0
      for (const node of nodes) {
        try {
          if (await node.getFileInfo(root, true)) seen++
        } catch {
          // unreachable node — not seen
        }
      }
      if (seen === nodes.length) return
    }
    await sleep(2_000)
  }
  throw new Error(`storage nodes did not pick up the log entry for ${root} in time`)
}

/**
 * The Flow market's price per sector. The contract takes whatever fee is
 * sent (a simulated batchSubmit with no fee succeeds), so the price is
 * never cached for long: drive actions fetch it fresh at the start, in the
 * same batched request as their event scan, and the upload reuses that
 * reading instead of spending two round trips right before the prompt.
 * Only the market's address — fixed per Flow contract — is kept.
 */
const PRICE_MAX_AGE_MS = 30_000
const priceCache = new Map<string, { at: number; price: Promise<bigint> }>()
const marketAddress = new Map<string, Promise<string>>()

export function storagePrice(network: NetworkConfig, maxAgeMs = PRICE_MAX_AGE_MS): Promise<bigint> {
  const key = network.flowAddress.toLowerCase()
  const hit = priceCache.get(key)
  if (hit && Date.now() - hit.at <= maxAgeMs) return hit.price
  const provider = rpcProvider(network)
  let market = marketAddress.get(key)
  if (!market) {
    market = getFlowContract(network.flowAddress, provider as unknown as SdkSigner).market()
    marketAddress.set(key, market)
    market.catch(() => marketAddress.delete(key))
  }
  const price = market.then(async (address) =>
    BigInt(await getMarketContract(address, provider as unknown as Parameters<typeof getMarketContract>[1]).pricePerSector())
  )
  priceCache.set(key, { at: Date.now(), price })
  price.catch(() => {
    if (priceCache.get(key)?.price === price) priceCache.delete(key)
  })
  return price
}

export async function uploadBatch(
  items: BatchItem[],
  network: NetworkConfig,
  signer: ethers.Signer,
  opts: BatchOpts = {}
): Promise<BatchResult> {
  if (!network.batchSubmit) throw new Error(`batch submission is not enabled on ${network.chainName}`)
  if (items.length === 0) throw new Error('empty batch')
  const submitter = await signer.getAddress()
  const onItem = opts.onItem ?? (() => undefined)
  // fetched while hashing (or reused from the action's own scan)
  const price = storagePrice(network)
  price.catch(() => undefined) // awaited below

  type Prepared = {
    payload: Uploadable
    submission: Awaited<ReturnType<MemData['createSubmission']>>[0] & object
    root: string
    tags: string
  }
  const prepare = async (item: BatchItem, index: number): Promise<Prepared> => {
    onItem(index, 'preparing')
    const base: Uploadable =
      item.data instanceof Uint8Array ? new MemData(item.data) : new ZgBlob(item.data as File)
    const payload = item.encryption ? wrapEncryption(base, item.encryption) : base
    if (payload.size() > FRAGMENT_LIMIT) throw new Error('file too large for batch upload (> 4 GB)')
    const tags = item.tags ?? '0x'
    const [submission, err] = await payload.createSubmission(tags, submitter)
    if (err !== null || submission === null) throw new Error(`cannot build submission: ${err}`)
    return { payload, submission, root: foldNodesToRoot(submission.data.nodes), tags }
  }

  // 1. Hash everything (the only pass before the prompt)
  const primary: Prepared[] = []
  for (let i = 0; i < items.length; i++) primary.push(await prepare(items[i], i))
  const extraItems = opts.finalize ? await opts.finalize(primary.map((p) => p.root)) : []
  const extras: Prepared[] = []
  for (let i = 0; i < extraItems.length; i++) extras.push(await prepare(extraItems[i], items.length + i))
  const all = [...primary, ...extras]

  // 2. One transaction
  const provider = rpcProvider(network)
  const flow = getFlowContract(network.flowAddress, signer as unknown as SdkSigner)
  const sectors = all.reduce(
    (acc, p) => acc + p.submission.data.nodes.reduce((n, node) => n + (1n << BigInt(node.height)), 0n),
    0n
  )
  const fee = sectors * (await price)
  all.forEach((_, i) => onItem(i, 'approve'))
  opts.onProgress?.('Waiting for wallet approval…')
  const tx = {
    to: network.flowAddress,
    data: flow.interface.encodeFunctionData('batchSubmit', [all.map((p) => p.submission)]),
    value: fee,
  }
  // A browser wallet gets the transaction as is: ethers' JsonRpcSigner
  // would first ask it for the block number and a gas estimate (two
  // round trips through the extension, ~0.9 s) that the wallet then
  // works out again itself before its prompt.
  const sent = {
    hash:
      signer instanceof ethers.JsonRpcSigner
        ? ((await signer.provider.send('eth_sendTransaction', [
            { from: submitter, to: tx.to, data: tx.data, value: ethers.toQuantity(tx.value) },
          ])) as string)
        : (await signer.sendTransaction(tx)).hash,
  }
  opts.onProgress?.(`Transaction submitted: ${sent.hash}`)
  const receipt = await provider.waitForTransaction(sent.hash)
  if (!receipt || receipt.status !== 1) throw new Error(`batch transaction failed (${sent.hash})`)

  const txSeqByRoot = new Map<string, number>()
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== network.flowAddress.toLowerCase()) continue
    try {
      const parsed = flow.interface.parseLog({ topics: [...log.topics], data: log.data })
      if (parsed?.name !== 'Submit') continue
      txSeqByRoot.set(foldNodesToRoot(parsed.args.submission.nodes), Number(parsed.args.submissionIndex))
    } catch {
      // not a Flow event
    }
  }
  for (const p of all) {
    if (!txSeqByRoot.has(p.root)) throw new Error(`batch receipt is missing the entry for ${p.root}`)
  }

  // 3. Segments (no transactions possible from here on), then sealing
  const indexer = new SessionIndexer(network.indexerRpc)
  const guard = noTxSigner(signer)
  const strict = opts.finalityRequired ?? true

  const store = async (p: Prepared, index: number): Promise<BatchItemResult> => {
    try {
      onItem(index, 'uploading')
      await waitVisible(indexer, p.root)
      const [, err] = await indexer.upload(p.payload, network.rpcUrl, guard as unknown as SdkSigner, {
        skipTx: true,
        skipIfFinalized: false, // see ensureFinality: one node's view isn't enough
        finalityRequired: false,
        tags: p.tags,
      })
      if (err !== null) throw err
      return { ok: true, result: resultFor(p) }
    } catch (err) {
      onItem(index, 'error', (err as Error).message)
      return { ok: false, error: (err as Error).message }
    }
  }
  const resultFor = (p: Prepared): UploadResult => {
    const txSeq = txSeqByRoot.get(p.root)!
    return {
      fragmented: false,
      rootHashes: [p.root],
      txHashes: [sent.hash],
      txSeqs: [txSeq],
      rootHash: p.root,
      txHash: sent.hash,
      txSeq,
    }
  }
  const seal = async (p: Prepared, index: number, r: BatchItemResult): Promise<BatchItemResult> => {
    if (!r.ok || !strict) {
      if (r.ok) onItem(index, 'done')
      return r
    }
    try {
      onItem(index, 'sealing')
      await ensureFinality(p.payload, indexer, network, guard, [p.root], {
        finalityTimeoutMs: opts.finalityTimeoutMs,
        maxRepairs: opts.maxRepairs,
        onProgress: (m) => onItem(index, 'sealing', m),
      })
      onItem(index, 'done')
      return r
    } catch (err) {
      onItem(index, 'error', (err as Error).message)
      return { ok: false, error: (err as Error).message }
    }
  }

  const stored: BatchItemResult[] = []
  for (let i = 0; i < primary.length; i++) stored.push(await store(primary[i], i))
  const itemResults = await Promise.all(primary.map((p, i) => seal(p, i, stored[i])))

  let extraResults: BatchItemResult[]
  if (itemResults.every((r) => r.ok)) {
    const off = primary.length
    const s: BatchItemResult[] = []
    for (let i = 0; i < extras.length; i++) s.push(await store(extras[i], off + i))
    extraResults = await Promise.all(extras.map((p, i) => seal(p, off + i, s[i])))
  } else {
    extraResults = extras.map((_, i) => {
      onItem(primary.length + i, 'skipped')
      return { ok: false, skipped: true, error: 'not stored: an item it depends on failed' }
    })
  }

  return { txHash: sent.hash, items: itemResults, extras: extraResults }
}

/** Upload in-memory bytes (works in Node and browser). */
export async function uploadData(
  data: Uint8Array,
  network: NetworkConfig,
  signer: ethers.Signer,
  opts: UploadOpts = {}
): Promise<UploadResult> {
  return uploadAbstract(new MemData(data), network, signer, opts)
}

/** Upload a browser File object. */
export async function uploadBrowserFile(
  file: File,
  network: NetworkConfig,
  signer: ethers.Signer,
  opts: UploadOpts = {}
): Promise<UploadResult> {
  return uploadAbstract(new ZgBlob(file), network, signer, opts)
}

/** Poll zgs_getFileInfo across nodes holding the file. */
/**
 * Find nodes that may hold a file. Prefers indexer locations; falls back
 * to the trusted node list when the indexer reports none (observed when
 * one shard node is missing a segment, so no complete covering set exists
 * yet — the other nodes can still serve their segments).
 */
async function locateFile(
  indexer: Indexer,
  rootHash: string
): Promise<ShardedNode[]> {
  let locations: ShardedNode[] = []
  try {
    locations = await indexer.getFileLocations(rootHash)
  } catch {
    // fall through to the trusted list
  }
  if (!locations || locations.length === 0) {
    try {
      const sharded = await indexer.getShardedNodes()
      locations = sharded.trusted ?? []
    } catch {
      // leave empty — caller reports "not found"
    }
  }
  return locations ?? []
}

export async function getFileInfo(
  rootHash: string,
  network: NetworkConfig
): Promise<FileInfoLike | null> {
  if (!ROOT_HASH_REGEX.test(rootHash)) return null
  const indexer = new SessionIndexer(network.indexerRpc)
  const locations = await locateFile(indexer, rootHash)
  for (const loc of locations) {
    try {
      const node = new StorageNode(loc.url)
      const info = await node.getFileInfo(rootHash, true)
      if (info) return info as unknown as FileInfoLike
    } catch {
      // try the next node
    }
  }
  return null
}

/**
 * Download file bytes by root hash(es). Browser-safe: fetches segments
 * in memory (no fs). Mirrors the SDK Downloader's segment math.
 *
 * Single-fragment decryption is done in-memory via tryDecrypt; multi-
 * fragment encrypted files are delegated to Indexer.downloadToBlob,
 * which coordinates the AES-CTR stream across fragments.
 */
export async function downloadFile(
  rootHashes: string[],
  network: NetworkConfig,
  opts: DownloadOpts = {}
): Promise<DownloadResult> {
  if (rootHashes.length === 0) throw new Error('No root hashes provided')

  // Encrypted multi-fragment path: SDK handles cross-fragment CTR offsets.
  // (Streaming mode handles fragments itself below.)
  if (opts.decryption && rootHashes.length > 1 && !opts.onPlainChunk) {
    opts.onProgress?.('Downloading fragments…')
    const indexer = new SessionIndexer(network.indexerRpc)
    const [blob, err] = await indexer.downloadToBlob(rootHashes, {
      proof: true,
      decryption: opts.decryption,
    })
    if (err !== null) throw new Error(`Download failed: ${err}`)
    const data = new Uint8Array(await blob.arrayBuffer())
    const header = await indexer
      .peekHeader(rootHashes[0])
      .then(([h]) => h)
      .catch(() => null)
    return { data, decrypted: header === null }
  }

  const indexer = new SessionIndexer(network.indexerRpc)
  const parts: Uint8Array[] = []

  // Streaming setup (see DownloadOpts.onPlainChunk)
  const stream = opts.onPlainChunk
  const streamKey =
    stream && opts.decryption?.symmetricKey !== undefined
      ? typeof opts.decryption.symmetricKey === 'string'
        ? hexToBytes(opts.decryption.symmetricKey)
        : opts.decryption.symmetricKey
      : stream && opts.decryption?.privateKey !== undefined
        ? null // ECIES streaming unsupported
        : undefined // no decryption
  if (stream && opts.decryption && streamKey === null) {
    throw new Error(
      'Streaming download supports symmetric-key (AES-256) decryption only — use the buffered path for ECIES files'
    )
  }
  let streamNonce: Uint8Array | null = null
  let streamPayloadBase = 0 // cumulative PLAINTEXT offset of earlier fragments
  let fragmentPlaintextRemaining = 0

  for (let f = 0; f < rootHashes.length; f++) {
    const rootHash = rootHashes[f]
    if (!ROOT_HASH_REGEX.test(rootHash)) {
      throw new Error(`Invalid root hash: ${rootHash}`)
    }
    opts.onProgress?.(
      `Fragment ${f + 1}/${rootHashes.length}: locating file…`
    )

    const locations = await locateFile(indexer, rootHash)
    if (locations.length === 0) {
      throw new Error(`File not found on any storage node: ${rootHash}`)
    }
    const nodeEntries = locations.map((loc) => ({
      node: new StorageNode(loc.url),
      shardId: loc.config.shardId,
      numShard: loc.config.numShard,
    }))

    // Try the root-hash index first; if every node draws a blank (e.g. a
    // record holding the Submit event's `identity`, which is not the data
    // root for single-segment files — see "Verification (M2)" in
    // docs/decisions.md) and the caller knows the txSeq, retry by txSeq.
    let fileInfo: FileInfoLike | null = null
    for (const { node } of nodeEntries) {
      try {
        const info = (await node.getFileInfo(
          rootHash,
          true
        )) as unknown as FileInfoLike
        if (info) {
          fileInfo = info
          break
        }
      } catch {
        // try the next node
      }
    }
    let byTxSeq = false
    if (fileInfo === null && opts.txSeqs?.[f] !== undefined) {
      byTxSeq = true
      for (const { node } of nodeEntries) {
        try {
          const info = (await node.getFileInfoByTxSeq(
            opts.txSeqs[f]
          )) as unknown as FileInfoLike
          if (info) {
            fileInfo = info
            break
          }
        } catch {
          // try the next node
        }
      }
    }
    if (fileInfo === null) {
      throw new Error(`Could not retrieve file info for ${rootHash}`)
    }

    const fileSize = Number(fileInfo.tx.size)
    const txSeq = Number(fileInfo.tx.seq)
    const numChunks = ceilDiv(fileSize, CHUNK_SIZE)
    // Global segment indices (chain-wide) — used for shard-affinity routing.
    const startSegGlobal = Math.floor(
      fileInfo.tx.startEntryIndex / SEGMENT_MAX_CHUNKS
    )
    const endSegGlobal = Math.floor(
      (fileInfo.tx.startEntryIndex + numChunks - 1) / SEGMENT_MAX_CHUNKS
    )
    const numSegments = endSegGlobal - startSegGlobal + 1

    // Plaintext bytes this fragment will yield (header lives in fragment 0)
    fragmentPlaintextRemaining =
      fileSize - (f === 0 && streamKey ? 17 : 0)

    // Segment/chunk indices passed to downloadSegmentByTxSeq are
    // file-relative (0-based) — see SDK Downloader.downloadTask.
    const fetchSegment = async (segIdx: number): Promise<Uint8Array> => {
      const startIndex = segIdx * SEGMENT_MAX_CHUNKS
      let endIndex = startIndex + SEGMENT_MAX_CHUNKS
      if (endIndex > numChunks) endIndex = numChunks

      // A node holds this segment iff (global segment index) mod numShard
      // equals its shardId; rotate through matching nodes on failure.
      // In by-txSeq fallback mode the shard filter is unreliable (we're
      // iterating the whole trusted set), so try every node in rotation.
      const globalSeg = startSegGlobal + segIdx
      const holders = byTxSeq
        ? nodeEntries
        : nodeEntries.filter((e) => globalSeg % e.numShard === e.shardId)
      const candidates = holders.length > 0 ? holders : nodeEntries

      let seg: Uint8Array | null = null
      let lastErr = ''
      for (let a = 0; a < SEGMENT_ROUNDS * candidates.length && seg === null; a++) {
        if (a > 0 && a % candidates.length === 0) {
          // every node failed this round: back off, then go round again
          await new Promise((r) => setTimeout(r, 1000 * (a / candidates.length)))
        }
        const { node } = candidates[(segIdx + a) % candidates.length]
        const release = await segmentSlots.acquire()
        try {
          const segment = await node.downloadSegmentByTxSeq(
            txSeq,
            startIndex,
            endIndex
          )
          if (segment == null) {
            release(true) // answered: this node just doesn't have it
            lastErr = 'segment not found'
            continue
          }
          release(true)
          seg = ethers.decodeBase64(segment as unknown as string)
          // Trim zero-padding after the final chunk of the final segment.
          if (segIdx === numSegments - 1) {
            const lastChunkSize = fileSize % CHUNK_SIZE
            if (lastChunkSize > 0 && seg.length >= CHUNK_SIZE - lastChunkSize) {
              seg = seg.slice(0, seg.length - (CHUNK_SIZE - lastChunkSize))
            }
          }
        } catch (err) {
          release(false)
          lastErr = (err as Error).message ?? String(err)
          // rotate to the next candidate node
        }
      }
      if (seg === null) {
        throw new Error(
          `Failed to download segment ${segIdx} of ${rootHash} from any node (${lastErr})`
        )
      }
      return seg
    }

    // Each segment is one ~0.5 s round trip, so keep a few in flight
    // (spread across nodes by the rotation above) and consume them in order.
    const inFlight = new Map<number, Promise<Uint8Array>>()
    let nextToFetch = 0
    const prefetch = (upTo: number) => {
      for (; nextToFetch < upTo && nextToFetch < numSegments; nextToFetch++) {
        const p = fetchSegment(nextToFetch)
        p.catch(() => {}) // surfaced when awaited in order
        inFlight.set(nextToFetch, p)
      }
    }
    for (let segIdx = 0; segIdx < numSegments; segIdx++) {
      prefetch(segIdx + SEGMENT_CONCURRENCY)
      const seg = await inFlight.get(segIdx)!
      inFlight.delete(segIdx)
      if (stream) {
        let chunk = seg
        if (streamKey) {
          if (f === 0 && segIdx === 0) {
            const header = parseEncryptionHeader(chunk)
            if (header.version !== 1) {
              throw new Error(
                'Streaming download supports AES-256 (v1) files only'
              )
            }
            streamNonce = header.nonce
          }
          if (streamNonce === null) {
            throw new Error('Encryption header missing')
          }
          // cryptAt offsets are payload-relative: the CTR stream starts at
          // 0 immediately after the header (see SDK decryptFragmentData).
          if (f === 0 && segIdx === 0) {
            // header + payload start: decrypt the payload view in place
            const body = chunk.subarray(17)
            cryptAt(streamKey, streamNonce, 0, body)
            chunk = body
          } else {
            const inFragmentOffset =
              f === 0
                ? SEGMENT_SIZE - 17 + (segIdx - 1) * SEGMENT_SIZE
                : segIdx * SEGMENT_SIZE
            cryptAt(
              streamKey,
              streamNonce,
              streamPayloadBase + inFragmentOffset,
              chunk
            )
          }
        }
        if (fragmentPlaintextRemaining < chunk.length) {
          chunk = chunk.slice(0, fragmentPlaintextRemaining)
        }
        fragmentPlaintextRemaining -= chunk.length
        if (chunk.length > 0) opts.onPlainChunk!(chunk)
      } else {
        parts.push(seg)
      }
      opts.onProgress?.(
        `Fragment ${f + 1}/${rootHashes.length}: segment ${segIdx + 1}/${numSegments}`,
        Math.round(((segIdx + 1) / numSegments) * 100)
      )
    }
    streamPayloadBase += fileSize - (f === 0 && streamKey ? 17 : 0)
  }

  if (stream) {
    return { data: new Uint8Array(0), decrypted: true }
  }

  const total = parts.reduce((n, p) => n + p.length, 0)
  const assembled = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    assembled.set(p, offset)
    offset += p.length
  }

  if (!opts.decryption) {
    return { data: assembled, decrypted: true }
  }
  return decryptDownloaded(assembled, opts.decryption)
}

/**
 * Decrypt a single-fragment file's raw stored bytes (as `downloadFile`
 * without `decryption` returns them) — for callers that cache ciphertext.
 */
export function decryptDownloaded(
  raw: Uint8Array,
  decryption: DecryptionInput
): DownloadResult {
  // tryDecrypt requires the symmetric key as bytes (no hex strings)
  const rawKey = decryption.symmetricKey
  const symmetricKey =
    typeof rawKey === 'string' ? hexToBytes(rawKey) : rawKey
  const { bytes, decrypted } = tryDecrypt(raw, {
    symmetricKey,
    privateKey: decryption.privateKey,
  })
  return { data: bytes, decrypted }
}

export { SEGMENT_SIZE }
