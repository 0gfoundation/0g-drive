import { ethers } from 'ethers'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'

/**
 * 0G Storage V2 through the relayer's HTTP API (proof of concept).
 *
 * The relayer takes each upload once over HTTPS and writes every replica;
 * reads and listings are open. What changes state carries an EIP-712
 * statement signed by the account that owns and pays for the file:
 *   Upload(bytes32 dataHash, uint64 fileSize, uint64 signedAt)
 *   Delete(bytes32 dataHash, uint64 signedAt)
 * accepted within 15 minutes of signedAt on the relayer's clock, so a
 * long upload signs again. The account is a storage key derived from the
 * drive master key (see v2account.ts), so nothing prompts; the wallet only
 * funds it in the PaymentVault.
 *
 * Browser-only APIs it needs (fetch, Blob, WebCrypto) are in Node 22 too.
 */

export interface V2Network {
  relayer: string
  chainId: number
  paymentVault: string
  rpc: string
  /** the PaymentVault's first block: deposits are looked up from here */
  vaultFromBlock: number
}

export const V2_TESTNET: V2Network = {
  relayer: 'https://galileo-storage-v2-relayer.0g.ai',
  chainId: 16602,
  paymentVault: '0x8A3366F6E2F44DaDa740Ea725C24F11a180CCEcD',
  rpc: 'https://evmrpc-testnet.0g.ai',
  vaultFromBlock: 63_550_840,
}

export interface RelayerInfo {
  chunkSize: number
  maxFileSize: number
  maxChunksPerFile: number
  maxPartBytes: number
  replicas: number
  domain: { name: string; version: string; chainId: number; verifyingContract: string }
}

/** Something that signs EIP-712 typed data: an ethers Wallet. */
export interface StatementSigner {
  address: string
  signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, ethers.TypedDataField[]>,
    value: Record<string, unknown>
  ): Promise<string>
}

/** A relayer refusal: its JSON body ({code, reason, message, retry, …}) and status. */
export class RelayerError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, any>,
    readonly retryAfterMs = 0
  ) {
    super(body.message ?? body.reason ?? `relayer answered ${status}`)
  }
  get retry(): boolean {
    return this.body.retry === true
  }
  get reason(): string | undefined {
    return this.body.reason ?? this.body.code
  }
}

type Range = [number, number]
type Moved = [number, string][]

const TYPES = {
  Upload: [
    { name: 'dataHash', type: 'bytes32' },
    { name: 'fileSize', type: 'uint64' },
    { name: 'signedAt', type: 'uint64' },
  ],
  Delete: [
    { name: 'dataHash', type: 'bytes32' },
    { name: 'signedAt', type: 'uint64' },
  ],
}

/** Statements are good for 15 minutes either side; sign again well before. */
const RESIGN_AFTER_S = 10 * 60
const MAX_TRIES = 6

const STORAGEKEY_INFO = '0gdrive/storagekey/v2'
const VAULT_ABI = [
  'function depositForUser(address user) payable',
  'function getUserBalance(address user) view returns (uint256)',
]

/**
 * The storage account's key, derived from the drive master key under its
 * own label: whoever holds the drive key (restored by signature, password
 * or key file) has its account, and nothing prompts per upload. Its
 * address owns and pays for the drive's files.
 */
export function deriveStorageKey(masterKey: Uint8Array): ethers.Wallet {
  return new ethers.Wallet(ethers.hexlify(hkdf(sha256, masterKey, undefined, STORAGEKEY_INFO, 32)))
}

/** how long a sent deposit is waited for before the wait gives up (the transaction may still land) */
const DEPOSIT_WAIT_MS = 3 * 60_000
const RECEIPT_POLL_MS = 2000

/**
 * Fund an account's storage balance from a wallet. Once the transaction
 * is sent, its receipt is polled from the network's RPC, and a failed
 * poll is tried again: one RPC error must not report a deposit that went
 * through as failed.
 */
export async function depositForUser(
  net: V2Network,
  payer: ethers.Signer,
  account: string,
  amount: bigint,
  onSent?: (hash: string) => void
): Promise<ethers.TransactionReceipt> {
  const vault = new ethers.Contract(net.paymentVault, VAULT_ABI, payer)
  const tx: ethers.TransactionResponse = await vault.depositForUser(account, { value: amount })
  onSent?.(tx.hash)
  const provider = new ethers.JsonRpcProvider(net.rpc, net.chainId, { staticNetwork: true })
  const deadline = Date.now() + DEPOSIT_WAIT_MS
  let lastError = ''
  for (;;) {
    try {
      const receipt = await provider.getTransactionReceipt(tx.hash)
      if (receipt) {
        if (receipt.status === 0) throw new DepositRevertedError(tx.hash)
        return receipt
      }
    } catch (err) {
      if (err instanceof DepositRevertedError) throw err
      lastError = (err as Error).message
    }
    if (Date.now() > deadline) {
      throw new Error(
        `The deposit was sent (${tx.hash}) but couldn’t be confirmed${lastError ? ` (${lastError.slice(0, 120)})` : ''}. ` +
          'It may still go through: check your storage balance before depositing again.'
      )
    }
    await new Promise((r) => setTimeout(r, RECEIPT_POLL_MS))
  }
}

class DepositRevertedError extends Error {
  constructor(hash: string) {
    super(`The deposit transaction failed on chain (${hash}); nothing was deposited.`)
    this.name = 'DepositRevertedError'
  }
}

export async function storageBalance(net: V2Network, account: string): Promise<bigint> {
  const vault = new ethers.Contract(net.paymentVault, VAULT_ABI, new ethers.JsonRpcProvider(net.rpc, net.chainId, { staticNetwork: true }))
  return vault.getUserBalance(account)
}

const digest = async (...parts: BlobPart[]) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', await new Blob(parts).arrayBuffer()))
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

function merkleRoot(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return new Uint8Array(32)
  if (leaves.length === 1) return leaves[0]
  let k = 1
  while (k * 2 < leaves.length) k *= 2 // split at the largest power of two below the count
  const node = new Uint8Array(65)
  node[0] = 1
  node.set(merkleRoot(leaves.slice(0, k)), 1)
  node.set(merkleRoot(leaves.slice(k)), 33)
  return sha256(node)
}

/**
 * Bytes to upload: a Blob, or anything that reads ranges of itself (e.g. a
 * file encrypted as it is read, so a big one is never held in memory).
 */
export interface ByteSource {
  size: number
  slice(from: number, to: number): Blob | Promise<Uint8Array>
}

/**
 * A Blob's V2 data hash (64 hex digits, no 0x) and its chunk hashes:
 * leaf = SHA-256(0x00 ‖ chunk), an RFC 6962 tree over the leaves, and
 * dataHash = SHA-256(0x02 ‖ u64be(chunkSize) ‖ u64be(size) ‖ root).
 */
export async function hashBlob(blob: ByteSource, chunkSize: number): Promise<{ dataHash: string; leaves: Uint8Array[] }> {
  const leaves: Uint8Array[] = []
  for (let at = 0; at < blob.size; at += chunkSize)
    leaves.push(await digest(Uint8Array.of(0), (await blob.slice(at, Math.min(at + chunkSize, blob.size))) as BlobPart))
  const sizes = new DataView(new ArrayBuffer(16))
  sizes.setBigUint64(0, BigInt(chunkSize))
  sizes.setBigUint64(8, BigInt(blob.size))
  return { dataHash: toHex(await digest(Uint8Array.of(2), sizes, merkleRoot(leaves) as BlobPart)), leaves }
}

function base64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const backoff = (attempt: number, hintMs: number) => Math.max(hintMs, Math.min(500 * 2 ** attempt, 15_000))

/** [from, to) ranges of `range` not covered by `done`. */
function subtract([from, to]: Range, done: Range[]): Range[] {
  const left: Range[] = []
  let at = from
  for (const [a, b] of [...done].sort((x, y) => x[0] - y[0])) {
    if (b <= at || a >= to) continue
    if (a > at) left.push([at, a])
    at = Math.max(at, b)
  }
  if (at < to) left.push([at, to])
  return left
}

export interface RelayerUploadOptions {
  /** chunks per part (default: 16, 16 MiB at 1 MiB chunks) */
  partChunks?: number
  /** parts in flight (default 4; the relayer allows 8 per account) */
  parallel?: number
  onProgress?: (sentBytes: number, totalBytes: number) => void
  /** an earlier upload of these bytes was interrupted: find what it stored first */
  resume?: boolean
}

export interface RelayerUploadResult {
  dataHash: string
  fileId?: string
  dedup: boolean
  /** times a statement was signed: once, plus once per 10 minutes */
  signatures: number
  /** part requests sent, retries included */
  partRequests: number
}

export class RelayerClient {
  /** relayer clock minus ours, in seconds, from its Date header */
  private skewS = 0
  private infoP?: Promise<RelayerInfo>

  constructor(readonly net: V2Network = V2_TESTNET) {}

  private now() {
    return Math.floor(Date.now() / 1000) + this.skewS
  }

  private noteDate(res: Response) {
    const date = Date.parse(res.headers.get('date') ?? '')
    if (!Number.isNaN(date)) this.skewS = Math.round((date - Date.now()) / 1000)
  }

  /** One request; its JSON, or a RelayerError. */
  private async call<T>(method: string, path: string, init: { headers?: Record<string, string>; body?: BodyInit } = {}): Promise<T> {
    const res = await fetch(this.net.relayer + path, { method, ...init })
    this.noteDate(res)
    const text = await res.text()
    let body: any = {}
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      // a 502–504 from the load balancer is not the API's JSON, and may pass later
      body = { message: text.slice(0, 200) || res.statusText, retry: res.status >= 502 && res.status <= 504 }
    }
    if (!res.ok) throw new RelayerError(res.status, body, Number(res.headers.get('retry-after') ?? 0) * 1000)
    return body as T
  }

  /** `call`, again while the refusal says it may pass later or the connection dropped. */
  private async retrying<T>(what: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await what()
      } catch (e) {
        const transient = e instanceof RelayerError ? e.retry : e instanceof TypeError // fetch: network error
        if (!transient || attempt + 1 >= MAX_TRIES) throw e
        await sleep(backoff(attempt, e instanceof RelayerError ? e.retryAfterMs : 0))
      }
    }
  }

  /** GET /v1/info, checked against the domain we sign under. */
  info(): Promise<RelayerInfo> {
    this.infoP ??= this.retrying(() => this.call<RelayerInfo>('GET', '/v1/info')).then((info) => {
      const d = info.domain
      if (d.chainId !== this.net.chainId || d.verifyingContract.toLowerCase() !== this.net.paymentVault.toLowerCase())
        throw new Error(`relayer signs for chain ${d.chainId} / ${d.verifyingContract}, not ${this.net.chainId} / ${this.net.paymentVault}`)
      return info
    })
    this.infoP.catch(() => (this.infoP = undefined))
    return this.infoP
  }

  private domain(): ethers.TypedDataDomain {
    return { name: '0G Storage', version: '1', chainId: this.net.chainId, verifyingContract: this.net.paymentVault }
  }

  /** The headers carrying a signed statement; V normalized to 0/1. */
  async sign(signer: StatementSigner, kind: 'Upload' | 'Delete', value: Record<string, unknown>) {
    const signedAt = this.now()
    const sig = await signer.signTypedData(this.domain(), { [kind]: TYPES[kind] }, { ...value, signedAt })
    const v = parseInt(sig.slice(130), 16) % 27
    return { signedAt, headers: { 'X-0G-Signature': sig.slice(0, 130) + v.toString(16).padStart(2, '0'), 'X-0G-Signed-At': String(signedAt) } }
  }

  /** Store bytes for the signer's account. Resumes what an earlier, interrupted upload of the same bytes stored. */
  async upload(signer: StatementSigner, blob: ByteSource, opts: RelayerUploadOptions = {}): Promise<RelayerUploadResult> {
    const info = await this.info()
    if (blob.size > info.maxFileSize) throw new Error(`${blob.size} bytes is over the relayer's ${info.maxFileSize}-byte file limit`)
    const { dataHash, leaves } = await hashBlob(blob, info.chunkSize)
    const partChunks = Math.max(1, Math.min(opts.partChunks ?? 16, Math.floor(info.maxPartBytes / info.chunkSize)))
    const parallel = Math.max(1, Math.min(opts.parallel ?? 4, 8))
    const chunkHashes = base64(new Uint8Array(await new Blob(leaves as BlobPart[]).arrayBuffer()))
    const result: RelayerUploadResult = { dataHash, dedup: false, signatures: 0, partRequests: 0 }

    let auth = { signedAt: 0, headers: {} as Record<string, string> }
    const fresh = async () => {
      if (this.now() - auth.signedAt > RESIGN_AFTER_S) {
        auth = await this.sign(signer, 'Upload', { dataHash: '0x' + dataHash, fileSize: blob.size })
        result.signatures++
      }
      return auth.headers
    }
    // a statement refused as expired means our clock was off: noteDate has corrected it
    const signedCall = async <T>(send: (h: Record<string, string>) => Promise<T>): Promise<T> => {
      try {
        return await send(await fresh())
      } catch (e) {
        if (!(e instanceof RelayerError && e.reason === 'AUTHORIZATION_EXPIRED')) throw e
        auth.signedAt = 0
        return send(await fresh())
      }
    }

    const moved: Moved = []
    const begin = (resume: boolean) =>
      this.retrying(() =>
        signedCall((h) =>
          this.call<{ fileId: string; dedup: boolean; completed: boolean; capability?: string; missing: Range[] }>('POST', '/v1/uploads', {
            headers: { ...h, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileSize: blob.size, dataHash, chunkHashes, ...(resume ? { resume: true, moved } : {}) }),
          })
        )
      )
    let begun = await begin(opts.resume ?? false)
    result.fileId = begun.fileId
    // a first begin's dedup is content stored before; with `completed`, this upload's own earlier parts
    if (begun.dedup) return { ...result, dedup: !begun.completed }

    let sent = 0
    const chunkBytes = (r: Range) => Math.min(r[1] * info.chunkSize, blob.size) - r[0] * info.chunkSize
    const done = blob.size - begun.missing.reduce((n, r) => n + chunkBytes(r), 0)
    opts.onProgress?.(done, blob.size)

    /** Send `ranges` in parts, `parallel` at a time; a part cut short is sent again from where it stopped. */
    const sendRanges = async (ranges: Range[]) => {
      const queue: Range[] = ranges.flatMap(([from, to]) => {
        const parts: Range[] = []
        for (let i = from; i < to; i += partChunks) parts.push([i, Math.min(to, i + partChunks)])
        return parts
      })
      let stale = false
      const worker = async () => {
        let failures = 0
        for (let part = queue.shift(); part && !stale; part = queue.shift()) {
          try {
            result.partRequests++
            const body = (await blob.slice(part[0] * info.chunkSize, Math.min(part[1] * info.chunkSize, blob.size))) as BodyInit
            const answer = await signedCall((h) =>
              this.call<{ stored: Range[]; moved: Moved }>('PUT', `/v1/uploads/${begun.fileId}/chunks/${part![0]}`, {
                headers: { ...h, 'X-0G-Capability': begun.capability!, 'Content-Type': 'application/octet-stream' },
                body,
              })
            )
            moved.push(...answer.moved)
            sent += chunkBytes(part)
            opts.onProgress?.(done + sent, blob.size)
            failures = 0
          } catch (e) {
            if (e instanceof RelayerError && (e.reason === 'CAPABILITY_STALE' || e.reason === 'NOT_PENDING')) {
              stale = true
              return
            }
            const transient = e instanceof RelayerError ? e.retry : e instanceof TypeError
            if (!transient || ++failures >= MAX_TRIES) throw e
            if (e instanceof RelayerError) {
              moved.push(...((e.body.moved as Moved) ?? []))
              const stored: Range[] = e.body.stored ?? []
              queue.unshift(...subtract(part, stored))
              sent += chunkBytes(part) - subtract(part, stored).reduce((n, r) => n + chunkBytes(r), 0)
            } else queue.unshift(part)
            await sleep(backoff(failures, e instanceof RelayerError ? e.retryAfterMs : 0))
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, worker))
      return !stale
    }

    for (let round = 0; ; round++) {
      if (!(await sendRanges(begun.missing))) {
        // the write permission went stale: begin again, resuming, and send what is still missing
        if (round >= MAX_TRIES) throw new Error('upload kept losing its write permission')
        begun = await begin(true)
        if (begun.dedup) return result
        continue
      }
      try {
        const r = await this.retrying(() =>
          signedCall((h) =>
            this.call<{ fileId: string }>('POST', `/v1/uploads/${begun.fileId}/complete`, {
              headers: { ...h, 'Content-Type': 'application/json' },
              body: JSON.stringify({ moved }),
            })
          )
        )
        result.fileId = r.fileId
        return result
      } catch (e) {
        if (!(e instanceof RelayerError && e.reason === 'INCOMPLETE') || round >= MAX_TRIES) throw e
        begun = { ...begun, missing: e.body.missing ?? [] }
      }
    }
  }

  /**
   * Read a file by its data hash. A download cut midway resumes from the
   * last byte received, held to the same content by If-Match. `size`, when
   * the caller knows it (the drive's manifest does), also catches a body cut
   * short by something between us and the relayer.
   */
  async download(
    dataHash: string,
    opts: { size?: number; onProgress?: (got: number, total: number) => void } = {}
  ): Promise<{ blob: Blob; resumes: number }> {
    const parts: Uint8Array[] = []
    let got = 0
    let total = opts.size ?? -1
    let resumes = 0
    const etag = `"${dataHash}"`
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`${this.net.relayer}/v1/files/${dataHash}`, {
          headers: got ? { Range: `bytes=${got}-`, 'If-Match': etag } : {},
        })
        this.noteDate(res)
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new RelayerError(res.status, body, Number(res.headers.get('retry-after') ?? 0) * 1000)
        }
        if (total < 0) total = Number(res.headers.get('content-length'))
        const reader = res.body!.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          parts.push(value)
          got += value.length
          opts.onProgress?.(got, total)
        }
        if (got < total) throw new TypeError('download ended early')
        return { blob: new Blob(parts as BlobPart[]), resumes }
      } catch (e) {
        const transient = e instanceof RelayerError ? e.retry : e instanceof TypeError
        if (!transient || attempt + 1 >= MAX_TRIES) throw e
        if (got) resumes++
        await sleep(backoff(attempt, e instanceof RelayerError ? e.retryAfterMs : 0))
      }
    }
  }

  /** A file's first `n` bytes (fewer when it is shorter). */
  head(dataHash: string, n: number): Promise<Uint8Array> {
    return this.retrying(async () => {
      const res = await fetch(`${this.net.relayer}/v1/files/${dataHash}`, { headers: { Range: `bytes=0-${n - 1}` } })
      this.noteDate(res)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new RelayerError(res.status, body, Number(res.headers.get('retry-after') ?? 0) * 1000)
      }
      return new Uint8Array(await res.arrayBuffer()).slice(0, n)
    })
  }

  /** An account's available files, newest first. */
  list(account: string, opts: { limit?: number; before?: string } = {}) {
    const q = new URLSearchParams({ limit: String(opts.limit ?? 100), ...(opts.before ? { before: opts.before } : {}) })
    return this.retrying(() =>
      this.call<{ files: { fileId: string; dataHash: string; fileSize: number; availableAt: number }[]; next?: string }>(
        'GET',
        `/v1/users/${account}/files?${q}`
      )
    )
  }

  /** Delete one of the signer's files: billing stops and its copies are erased. */
  async delete(signer: StatementSigner, dataHash: string) {
    const send = async () =>
      this.call<{ fileId: string; deletedAt: number; deletedNow: boolean; erasing: boolean }>('DELETE', `/v1/files/${dataHash}`, {
        headers: (await this.sign(signer, 'Delete', { dataHash: '0x' + dataHash })).headers,
      })
    return this.retrying(async () => {
      try {
        return await send()
      } catch (e) {
        // expired (our clock: noteDate corrected it), or signed before the
        // upload on the relayer's clock (a file deleted the second it was
        // stored): sign again a moment later
        if (e instanceof RelayerError && (e.reason === 'AUTHORIZATION_EXPIRED' || e.reason === 'AUTHORIZATION_MISMATCH')) {
          if (e.reason === 'AUTHORIZATION_MISMATCH') await sleep(2000)
          return send()
        }
        throw e
      }
    })
  }
}
