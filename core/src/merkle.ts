// What a 0G upload needs computed before its transaction — the submission
// (sub-tree roots) and the file's Merkle root — plus each segment's proof
// for sending it afterwards, from ONE read of the file.
//
// The SDK does this in pure JavaScript on hex strings and rebuilds the whole
// tree after the transaction (~12 MB/s in a browser; docs/decisions.md). Here
// the same layout is computed on bytes with WebAssembly keccak (hash-wasm) and
// the platform's AES-CTR (WebCrypto), segment by segment, keeping only one
// 32-byte root per 256 KB segment. Roots are byte-identical to the SDK's
// (scripts/test-merkle.mjs compares them across sizes).
//
// No ethers or SDK imports: web workers load this module on its own
// (`@0gdrive/core/merkle`).

import { createKeccak, type IHasher } from 'hash-wasm'

export const CHUNK_SIZE = 256
export const SEGMENT_MAX_CHUNKS = 1024
export const SEGMENT_SIZE = CHUNK_SIZE * SEGMENT_MAX_CHUNKS

/** The stored bytes of an upload: `header || AES-256-CTR(data)` when encrypted, else `data`. */
export interface StreamSource {
  data: Blob | Uint8Array
  /** AES-256 key and the SDK encryption header (v1: version byte + 16-byte nonce) */
  enc?: { key: Uint8Array; header: Uint8Array }
}

// ─── layout (mirrors the SDK's file/utils.js) ─────────────────────────────

export function numSplits(total: number, unit: number): number {
  return Math.floor((total - 1) / unit) + 1
}

function nextPow2(n: number): number {
  return n <= 1 ? 1 : 2 ** Math.ceil(Math.log2(n))
}

/** Chunks after flow padding, and the next power of two. */
function paddedChunks(chunks: number): [number, number] {
  const pow = nextPow2(chunks)
  if (pow === chunks) return [pow, pow]
  const min = pow >= 16 ? Math.floor(pow / 16) : 1
  return [numSplits(chunks, min) * min, pow]
}

export function streamSize(src: StreamSource): number {
  const n = src.data instanceof Uint8Array ? src.data.length : src.data.size
  return n + (src.enc?.header.length ?? 0)
}

/** Segments of the padded stream: the leaves of the file's Merkle tree. */
export function numPaddedSegments(size: number): number {
  return numSplits(paddedChunks(numSplits(size, CHUNK_SIZE))[0] * CHUNK_SIZE, SEGMENT_SIZE)
}

/** The submission's sub-trees, in chunks, largest first. */
function splitNodes(chunks: number): number[] {
  let [left, next] = paddedChunks(chunks)
  const nodes: number[] = []
  while (left > 0) {
    if (left >= next) {
      left -= next
      nodes.push(next)
    }
    next /= 2
  }
  return nodes
}

// ─── bytes ────────────────────────────────────────────────────────────────

const keys = new WeakMap<Uint8Array, Promise<CryptoKey>>()

/** AES-256-CTR at byte `offset` of the encrypted payload, as the SDK's cryptAt. */
async function ctrAt(key: Uint8Array, nonce: Uint8Array, offset: number, data: Uint8Array): Promise<Uint8Array> {
  let ck = keys.get(key)
  if (!ck) {
    ck = crypto.subtle.importKey('raw', key as BufferSource, 'AES-CTR', false, ['encrypt'])
    keys.set(key, ck)
  }
  const counter = nonce.slice()
  let carry = Math.floor(offset / 16)
  for (let i = 15; i >= 0 && carry > 0; i--) {
    const sum = counter[i] + (carry % 256)
    counter[i] = sum & 0xff
    carry = Math.floor(carry / 256) + (sum > 0xff ? 1 : 0)
  }
  const skip = offset % 16
  const padded = new Uint8Array(skip + data.length)
  padded.set(data, skip)
  const out = await crypto.subtle.encrypt({ name: 'AES-CTR', counter, length: 128 }, await ck, padded)
  return new Uint8Array(out, skip)
}

/** Stored bytes [start, end) (end clamped to the stream). */
export async function readStream(src: StreamSource, start: number, end: number): Promise<Uint8Array> {
  end = Math.min(end, streamSize(src))
  const out = new Uint8Array(Math.max(0, end - start))
  const header = src.enc?.header ?? new Uint8Array(0)
  let at = 0
  if (start < header.length) {
    const part = header.subarray(start, Math.min(header.length, end))
    out.set(part)
    at = part.length
  }
  const from = Math.max(start, header.length) - header.length
  const to = end - header.length
  if (to > from) {
    let plain =
      src.data instanceof Uint8Array
        ? src.data.subarray(from, to)
        : new Uint8Array(await src.data.slice(from, to).arrayBuffer())
    if (src.enc) plain = await ctrAt(src.enc.key, src.enc.header.subarray(1, 17), from, plain)
    out.set(plain, at)
  }
  return out
}

// ─── hashing ──────────────────────────────────────────────────────────────

let hasher: Promise<IHasher> | null = null
const keccak = () => (hasher ??= createKeccak(256))

function pair(h: IHasher, a: Uint8Array, b: Uint8Array): Uint8Array {
  h.init()
  h.update(a)
  h.update(b)
  return h.digest('binary')
}

/** One level up: pairs hashed, an odd last node carried up as is (the SDK's MerkleTree). */
function levelUp(h: IHasher, nodes: Uint8Array[]): Uint8Array[] {
  const up: Uint8Array[] = []
  for (let i = 0; i + 1 < nodes.length; i += 2) up.push(pair(h, nodes[i], nodes[i + 1]))
  if (nodes.length % 2 === 1) up.push(nodes[nodes.length - 1])
  return up
}

function rootOf(h: IHasher, nodes: Uint8Array[]): Uint8Array {
  while (nodes.length > 1) nodes = levelUp(h, nodes)
  return nodes[0]
}

/** Root over `data`'s 256-byte chunks (`data` is chunk-aligned). */
function chunksRoot(h: IHasher, data: Uint8Array): Uint8Array {
  const leaves: Uint8Array[] = []
  for (let o = 0; o < data.length; o += CHUNK_SIZE) {
    h.init()
    h.update(data.subarray(o, o + CHUNK_SIZE))
    leaves.push(h.digest('binary'))
  }
  return rootOf(h, leaves)
}

const zeroRoots = new Map<number, Uint8Array>()

/**
 * Roots of padded segments [from, to), 32 bytes each, concatenated. A
 * segment past the data is zeros up to the padded size, as in the SDK's
 * iterator. Independent ranges can run in parallel (web workers).
 */
export async function hashSegments(src: StreamSource, from: number, to: number): Promise<Uint8Array> {
  const h = await keccak()
  const size = streamSize(src)
  const padded = paddedChunks(numSplits(size, CHUNK_SIZE))[0] * CHUNK_SIZE
  const out = new Uint8Array((to - from) * 32)
  for (let s = from; s < to; s++) {
    const start = s * SEGMENT_SIZE
    const len = Math.min(SEGMENT_SIZE, padded - start)
    let root: Uint8Array
    if (start >= size) {
      root = zeroRoots.get(len) ?? chunksRoot(h, new Uint8Array(len))
      zeroRoots.set(len, root)
    } else {
      const seg = new Uint8Array(len)
      seg.set(await readStream(src, start, start + len))
      root = chunksRoot(h, seg)
    }
    out.set(root, (s - from) * 32)
  }
  return out
}

// ─── the tree over segments: root, submission, proofs ──────────────────────

const hex = (b: Uint8Array) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

export interface SegmentProof {
  lemma: string[]
  path: boolean[]
}

export class SegmentTree {
  private constructor(private levels: Uint8Array[][]) {}

  /** From hashSegments' output for every padded segment. */
  static async build(roots: Uint8Array): Promise<SegmentTree> {
    const h = await keccak()
    let level = Array.from({ length: roots.length / 32 }, (_, i) => roots.subarray(i * 32, i * 32 + 32))
    const levels = [level]
    while (level.length > 1) levels.push((level = levelUp(h, level)))
    return new SegmentTree(levels)
  }

  get root(): string {
    return hex(this.levels[this.levels.length - 1][0])
  }

  /** Root of segments [first, first + count), a full aligned power of two. */
  async subtree(first: number, count: number): Promise<string> {
    return hex(rootOf(await keccak(), this.levels[0].slice(first, first + count)))
  }

  /** The proof the storage nodes check a segment against (the SDK's proofAt). */
  proof(i: number): SegmentProof {
    if (this.levels[0].length === 1) return { lemma: [this.root], path: [] }
    const lemma = [hex(this.levels[0][i])]
    const path: boolean[] = []
    for (let l = 0; l < this.levels.length - 1; l++) {
      const level = this.levels[l]
      if (!(i === level.length - 1 && level.length % 2 === 1)) {
        lemma.push(hex(level[i ^ 1]))
        path.push(i % 2 === 0)
      }
      i = Math.floor(i / 2)
    }
    lemma.push(this.root)
    return { lemma, path }
  }
}

export interface SubmissionNode {
  root: string
  height: number
}

/**
 * The submission's nodes: sub-trees of a segment or more come from the tree;
 * smaller ones (the tail of a small file) are hashed from the stream.
 */
export async function submissionNodes(src: StreamSource, tree: SegmentTree): Promise<SubmissionNode[]> {
  const h = await keccak()
  const nodes: SubmissionNode[] = []
  let offset = 0 // in chunks
  for (const chunks of splitNodes(numSplits(streamSize(src), CHUNK_SIZE))) {
    let root: string
    if (chunks >= SEGMENT_MAX_CHUNKS) {
      root = await tree.subtree(offset / SEGMENT_MAX_CHUNKS, chunks / SEGMENT_MAX_CHUNKS)
    } else {
      const data = new Uint8Array(chunks * CHUNK_SIZE)
      data.set(await readStream(src, offset * CHUNK_SIZE, (offset + chunks) * CHUNK_SIZE))
      root = hex(chunksRoot(h, data))
    }
    nodes.push({ root, height: Math.log2(chunks) })
    offset += chunks
  }
  return nodes
}

/** Bytes of segment `i` as sent to a node: zero-padded to whole chunks, none past the data. */
export async function segmentData(src: StreamSource, i: number): Promise<Uint8Array | null> {
  const size = streamSize(src)
  const chunks = numSplits(size, CHUNK_SIZE)
  const first = i * SEGMENT_MAX_CHUNKS
  if (first >= chunks) return null
  const len = Math.min(SEGMENT_MAX_CHUNKS, chunks - first) * CHUNK_SIZE
  const data = new Uint8Array(len)
  data.set(await readStream(src, i * SEGMENT_SIZE, i * SEGMENT_SIZE + len))
  return data
}
