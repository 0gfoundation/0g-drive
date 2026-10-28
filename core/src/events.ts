import { ethers } from 'ethers'
import { FixedPriceFlow__factory } from '@0gfoundation/0g-storage-ts-sdk'
import type { NetworkConfig } from './config.js'

export interface UploadEvent {
  blockNumber: number
  txHash: string
  /**
   * The file's true merkle root (`tx.dataMerkleRoot` on the nodes) —
   * computed from the submission's witness nodes. Do NOT use the event's
   * `identity` topic here: for single-node submissions (small files) it is
   * a flow-derived hash that does not resolve on storage nodes.
   */
  rootHash: string
  /** The submission's storage txSeq (== `submissionIndex`). */
  txSeq: number
  /** Transaction tags as emitted (hex string; '0x' when empty). */
  tags: string
  /** The raw event `identity` topic (flow context hash) — reference only. */
  identityHash?: string
}

/**
 * Fold the submission's merkle witness nodes into the file root, mirroring
 * the storage node's `nodes_to_root` (log_entry_fetcher.rs:782): start from
 * the last node, fold right-to-left, each step keccak256(left ‖ right) over
 * the 64 raw concatenated bytes.
 */
export function foldNodesToRoot(
  nodes: ReadonlyArray<{ root: ethers.BytesLike; height?: ethers.BigNumberish }>
): string {
  const roots = nodes.map((n) => ethers.getBytes(n.root))
  let acc = roots[roots.length - 1]
  for (let i = roots.length - 2; i >= 0; i--) {
    acc = ethers.getBytes(
      ethers.keccak256(new Uint8Array([...roots[i], ...acc]))
    )
  }
  return ethers.hexlify(acc)
}

/**
 * Block span of one getLogs query. The 0G RPC rejects a query whose result
 * set is "too large" (and suggests a narrower range); filtered to the Flow
 * contract + sender it accepts ~30M blocks, but 20M already gets rejected
 * now and then, so a full history is split into 10M-block chunks, queried
 * in parallel (one round trip instead of one per chunk). A rejected chunk
 * shrinks to the suggested range (or halves) and carries on from there.
 */
const SCAN_SPAN = 10_000_000
const SCAN_SPAN_MIN = 10_000
const SCAN_PARALLEL = 8

interface ScanCtx {
  provider: ethers.JsonRpcProvider
  iface: ethers.Interface
  topics: string[]
  flowAddress: string
}

function scanContext(address: string, network: NetworkConfig): ScanCtx {
  const provider = new ethers.JsonRpcProvider(network.rpcUrl)
  const iface = new ethers.Interface(FixedPriceFlow__factory.abi)
  return {
    provider,
    iface,
    topics: [iface.getEvent('Submit')!.topicHash, ethers.zeroPadValue(address, 32)],
    flowAddress: network.flowAddress,
  }
}

/** Submit events in [from, to], narrowing the span when the RPC asks to. */
async function scanRange(ctx: ScanCtx, from: number, to: number): Promise<UploadEvent[]> {
  const events: UploadEvent[] = []
  let start = from
  let span = to - from + 1
  while (start <= to) {
    const end = Math.min(start + span - 1, to)
    let logs: ethers.Log[]
    try {
      logs = await ctx.provider.getLogs({
        address: ctx.flowAddress,
        topics: ctx.topics,
        fromBlock: start,
        toBlock: end,
      })
    } catch (err) {
      if (span <= SCAN_SPAN_MIN) throw err
      const suggested = /suggested block range is \[(\d+),\s*(\d+)\]/.exec(
        String((err as { error?: { message?: string } }).error?.message ?? (err as Error).message)
      )
      const suggestedEnd = suggested ? Number(suggested[2]) : NaN
      span =
        suggestedEnd >= start && suggestedEnd < end
          ? Math.max(SCAN_SPAN_MIN, suggestedEnd - start + 1)
          : Math.max(SCAN_SPAN_MIN, Math.floor(span / 2))
      continue
    }
    start = end + 1
    for (const log of logs) {
      try {
        const parsed = ctx.iface.parseLog({ topics: log.topics, data: log.data })
        if (parsed === null) continue
        events.push({
          blockNumber: log.blockNumber,
          txHash: log.transactionHash,
          rootHash: foldNodesToRoot(parsed.args.submission.nodes),
          txSeq: Number(parsed.args.submissionIndex),
          tags: String(parsed.args.submission?.tags ?? '0x'),
          identityHash: String(parsed.args.identity),
        })
      } catch {
        // skip malformed log
      }
    }
  }
  return events
}

/** [from, to] in SCAN_SPAN chunks, oldest first. */
function chunks(from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let s = from; s <= to; s += SCAN_SPAN) out.push([s, Math.min(s + SCAN_SPAN - 1, to)])
  return out
}

/** Scan chunks in parallel (bounded), results concatenated in chunk order. */
async function scanChunks(ctx: ScanCtx, list: Array<[number, number]>): Promise<UploadEvent[]> {
  const results: UploadEvent[][] = new Array(list.length)
  let next = 0
  const worker = async () => {
    while (next < list.length) {
      const i = next++
      results[i] = await scanRange(ctx, list[i][0], list[i][1])
    }
  }
  await Promise.all(Array.from({ length: Math.min(SCAN_PARALLEL, list.length) }, worker))
  return results.flat()
}

/**
 * Latest block, and whether the wallet has ever sent a transaction: one
 * that hasn't has no uploads of its own (0GDrive always submits from the
 * user's own wallet), so the full-history scan can be skipped — the common
 * case for a brand-new user.
 */
async function head(ctx: ScanCtx, address: string, fullScan: boolean) {
  const [latest, nonce] = await Promise.all([
    ctx.provider.getBlockNumber(),
    fullScan ? ctx.provider.getTransactionCount(address) : Promise.resolve(1),
  ])
  return { latest, neverSent: nonce === 0 }
}

/**
 * Scan a wallet's storage submissions (Flow contract `Submit` events).
 * Both `sender` (topic1) and the root hash (topic2) are indexed, and the
 * submission's tags ride in the event data — so the full upload history of
 * an address is reconstructible from the public RPC with no server.
 *
 * `fromBlock` allows incremental scans (cache the highest scanned block and
 * pass it next time); 0 means a full scan.
 */
export async function scanUploads(
  address: string,
  network: NetworkConfig,
  fromBlock = 0
): Promise<{ events: UploadEvent[]; scannedToBlock: number }> {
  const ctx = scanContext(address, network)
  const { latest, neverSent } = await head(ctx, address, fromBlock <= 0)
  if (neverSent) return { events: [], scannedToBlock: latest }
  // block 0 is outside the RPC's searchable range (and has no logs)
  const events = await scanChunks(ctx, chunks(Math.max(1, fromBlock), latest))
  return { events, scannedToBlock: latest }
}

/**
 * Full-history scan that tries the newest chunk first and stops there when
 * `enough(events)` says what was found suffices (e.g. "has a backup
 * manifest" — only the latest one matters). Otherwise scans the rest in
 * parallel. `complete` tells the caller whether it saw the whole history.
 */
export async function scanUploadsNewestFirst(
  address: string,
  network: NetworkConfig,
  enough: (events: UploadEvent[]) => boolean
): Promise<{ events: UploadEvent[]; complete: boolean }> {
  const ctx = scanContext(address, network)
  const { latest, neverSent } = await head(ctx, address, true)
  if (neverSent) return { events: [], complete: true }
  // the newest SCAN_SPAN blocks, then everything before them
  const split = Math.max(1, latest - SCAN_SPAN + 1)
  const newest = await scanRange(ctx, split, latest)
  if (split === 1) return { events: newest, complete: true }
  if (enough(newest)) return { events: newest, complete: false }
  const older = await scanChunks(ctx, chunks(1, split - 1))
  return { events: [...older, ...newest], complete: true }
}

/**
 * Persistence hook for incremental scans. Without one, every page load
 * rescans the wallet's whole upload history from block 1 (a few getLogs
 * calls); with one, only recent blocks.
 */
export interface EventCache {
  load(): { events: UploadEvent[]; toBlock: number } | null
  save(events: UploadEvent[], toBlock: number): void
}

/** recent blocks re-scanned on every incremental scan (see scanUploadsCached) */
const RESCAN_BLOCKS = 20_000

const inflight = new Map<string, Promise<{ events: UploadEvent[]; scannedToBlock: number }>>()

/**
 * `scanUploads`, incremental when a cache is given: scans only new blocks,
 * merges them into the cached list and saves it. Concurrent calls for the
 * same wallet share one scan (a page load asks for the drive, the recovery
 * backup and the share key at once).
 */
export function scanUploadsCached(
  address: string,
  network: NetworkConfig,
  cache?: EventCache
): Promise<{ events: UploadEvent[]; scannedToBlock: number }> {
  const key = `${network.flowAddress}:${address.toLowerCase()}:${cache ? 'c' : 'n'}`
  const running = inflight.get(key)
  if (running) return running
  const p = (async () => {
    const cached = cache?.load()
    // The public RPC is load-balanced and its backends can lag the head by
    // a few blocks, so a getLogs may not yet see logs up to the height that
    // getBlockNumber just returned. Re-scan a recent window every time
    // (still one getLogs call) so an event missed that way is picked up on
    // the next scan instead of never.
    const fromBlock =
      cached && cached.toBlock > 0 ? Math.max(1, cached.toBlock + 1 - RESCAN_BLOCKS) : 0
    const prior = fromBlock > 0 ? cached!.events : []
    const { events: fresh, scannedToBlock } = await scanUploads(address, network, fromBlock)
    // fresh may overlap the boundary block
    const seen = new Set(prior.map((e) => e.txSeq + ':' + e.txHash))
    const events = [...prior, ...fresh.filter((e) => !seen.has(e.txSeq + ':' + e.txHash))]
    cache?.save(events, scannedToBlock)
    return { events, scannedToBlock }
  })().finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}
