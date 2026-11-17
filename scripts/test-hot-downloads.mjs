// Hot downloads and the free path's limits, against the testnet relayer and
// its hot nodes, with a fresh storage account funded from the .env wallet.
// Free reads keep to the relayer's 2 in flight per address (no 429s, small
// reads first); a big upload is warmed on a hot node; a big file is read
// from a hot node, paid per byte, and a small one from the free path; an
// unfunded account, a node serving wrong bytes and a failing node each fall
// back or move on and still give the file. Every file is deleted at the end.
// Usage: npm run test:hot-downloads  (reads PRIVATE_KEY from env or .env)
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { V2Backend, RelayerClient, V2_TESTNET, HOT_MIN_BYTES, depositForUser } from '../core/dist/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const privateKey =
  process.env.PRIVATE_KEY ?? /^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(readFileSync(resolve(root, '.env'), 'utf8'))?.[1]
if (!privateKey) {
  console.error('Usage: npm run test:hot-downloads (needs PRIVATE_KEY env or .env)')
  process.exit(1)
}

const t0 = Date.now()
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(0)}s]`
let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) passed++
  else failed++
  console.log(`${stamp()} ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0

// every request, as the core makes it: the relayer's free reads, ticket requests, hot node reads
const R = new URL(V2_TESTNET.relayer).host
const log = []
let inFlightFree = 0
let maxInFlightFree = 0
/** a test's hook into hot node responses: return a Response to send instead */
let hotHook = null
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url)
  const headers = new Headers(init.headers)
  const kind = url.host === R ? (url.pathname.startsWith('/v1/files/') ? 'free' : url.pathname.startsWith('/v1/hot/') ? 'ticket' : 'relayer') : url.pathname.startsWith('/v1/files/') ? 'hot' : 'other'
  const entry = { kind, host: url.host, path: url.pathname, range: headers.get('range'), body: typeof init.body === 'string' ? init.body : null, status: 0 }
  log.push(entry)
  if (kind === 'free') maxInFlightFree = Math.max(maxInFlightFree, ++inFlightFree)
  try {
    const res = await realFetch(input, init)
    entry.status = res.status
    if (kind === 'hot' && hotHook) {
      const swapped = await hotHook(res, entry)
      if (swapped) return swapped
    }
    if (kind !== 'free') return res
    // count a free read in flight until its body is read
    const reader = res.body?.getReader()
    if (!reader) return (inFlightFree--, res)
    const body = new ReadableStream({
      async pull(c) {
        const { done, value } = await reader.read().catch((e) => (inFlightFree--, Promise.reject(e)))
        if (done) {
          inFlightFree--
          c.close()
        } else c.enqueue(value)
      },
    })
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
  } catch (e) {
    if (kind === 'free') inFlightFree--
    throw e
  }
}
const since = (i) => log.slice(i)

const provider = new ethers.JsonRpcProvider(V2_TESTNET.rpc)
const funder = new ethers.Wallet(privateKey, provider)
const account = ethers.Wallet.createRandom()
console.log(`Storage account: ${account.address}`)
const DEPOSIT = ethers.parseEther(process.env.V2_DEPOSIT ?? '0.05')
await depositForUser(V2_TESTNET, funder, account.address, DEPOSIT)
console.log(`${stamp()} deposited ${ethers.formatEther(DEPOSIT)} 0G`)
const standing = async (a) => (await realFetch(`${V2_TESTNET.relayer}/v1/users/${a}/standing`)).json()
// the relayer sees a deposit a moment after it lands
for (let i = 0; i < 30 && BigInt((await standing(account.address)).balance) === 0n; i++) await sleep(5000)

const masterKey = crypto.getRandomValues(new Uint8Array(32))
const backend = (acct = account, opts = {}) => new V2Backend(new RelayerClient(V2_TESTNET), acct, masterKey, opts)
const main = backend()

// files as the app stores them: each encrypted with a key of its own
const files = [
  { name: 'big', bytes: randomBytes(HOT_MIN_BYTES + 3 * 1024 * 1024) },
  ...Array.from({ length: 8 }, (_, i) => ({ name: `small${i}`, bytes: randomBytes(64 * 1024 + i) })),
]
for (const f of files) f.key = crypto.getRandomValues(new Uint8Array(32))
const uploadStart = log.length
const up = await main.uploadFiles(
  files.map((f) => ({ data: f.bytes, encryption: { type: 'aes256', key: f.key } })),
  {}
)
check('files uploaded', up.files.every((r) => r.ok), up.files.filter((r) => !r.ok).map((r) => r.error).join('; '))
files.forEach((f, i) => (f.meta = { id: f.name, name: f.name, size: f.bytes.length, encryption: 'aes256', rootHashes: up.files[i].ref.rootHashes, txHashes: [] }))
const big = files[0]
const bigHash = big.meta.rootHashes[0].slice(2)
const read = (f, b = main) => b.download(f.meta, { decryption: { symmetricKey: f.key } })

// --- warming: a big upload is read one byte from a hot node, small ones aren't
let warmed = null
for (let i = 0; i < 60 && !warmed; i++) {
  warmed = since(uploadStart).find((e) => e.kind === 'hot' && e.range === 'bytes=0-0' && e.path.includes(bigHash) && e.status === 206)
  if (!warmed) await sleep(1000)
}
check('a big upload is warmed on a hot node (one byte read)', !!warmed, warmed ? warmed.host : 'no warming read seen')
const tickets = since(uploadStart).filter((e) => e.kind === 'ticket')
check('only the big upload asks for a ticket', tickets.length >= 1 && tickets.every((e) => e.path.includes(bigHash)), `${tickets.length} ticket requests`)
await sleep(20_000) // the node fills the whole file in the background

// --- the free path's limit
{
  const raw = await Promise.all(files.slice(1, 7).map((f) => realFetch(`${V2_TESTNET.relayer}/v1/files/${f.meta.rootHashes[0].slice(2)}`).then(async (r) => (await r.arrayBuffer(), r.status))))
  console.log(`${stamp()} (6 free reads at once, unlimited: ${raw.filter((s) => s === 429).length} refused 429)`)
  await sleep(1500)
  const i = log.length
  maxInFlightFree = 0
  const relayer = main.relayer
  const results = await Promise.all([
    ...files.slice(1).map((f) => relayer.head(f.meta.rootHashes[0].slice(2), 20)),
    ...files.slice(1, 5).map((f) => read(f)),
  ])
  const refused = since(i).filter((e) => e.kind === 'free' && e.status === 429).length
  check('12 free reads at once: none refused 429', refused === 0, `${refused} refused`)
  check('at most 2 free reads in flight', maxInFlightFree <= 2, `max ${maxInFlightFree}`)
  check('they all read right', results.slice(8).every((r, k) => same(r.data, files[1 + k].bytes)))
  check('a small file is read free, with no ticket', since(i).every((e) => e.kind !== 'ticket' && e.kind !== 'hot'))
}

// --- small reads go before a big free read waiting with them
{
  // two big reads hold both slots; a third waits, then a small one: the small one is sent first
  const free = backend(account, { hot: false })
  const i = log.length
  const reads = [read(big, free), read(big, free), read(big, free)]
  await sleep(300)
  reads.push(free.relayer.head(files[2].meta.rootHashes[0].slice(2), 20))
  await Promise.all(reads)
  const sent = since(i).filter((e) => e.kind === 'free').map((e) => (e.range ? 'small' : 'big'))
  check('a small read is sent before a big one queued ahead of it', sent.join(' ') === 'big big small big', sent.join(' '))
}

// --- a big file from a hot node
{
  const i = log.length
  let a = performance.now()
  const r = await read(big)
  const hotSecs = (performance.now() - a) / 1000
  const hot = since(i).filter((e) => e.kind === 'hot')
  check('a big file is read from a hot node', hot.length >= 1 && hot.every((e) => e.status === 200 || e.status === 206), hot.map((e) => `${e.host} ${e.status}`).join(', '))
  check('… and not from the free path', since(i).every((e) => e.kind !== 'free'))
  check('… and decrypts to the bytes stored', same(r.data, big.bytes))
  a = performance.now()
  const f = await read(big, backend(account, { hot: false }))
  const freeSecs = (performance.now() - a) / 1000
  check('the same file read free', same(f.data, big.bytes))
  const mb = big.bytes.length / 1024 / 1024
  console.log(`${stamp()} ${mb.toFixed(0)} MB: hot ${hotSecs.toFixed(1)} s (${(mb / hotSecs).toFixed(1)} MB/s), free ${freeSecs.toFixed(1)} s (${(mb / freeSecs).toFixed(1)} MB/s)`)
}

// --- an account without the hot minimum reads free, and stops asking
{
  const poor = backend(ethers.Wallet.createRandom())
  const i = log.length
  const r = await read(big, poor)
  const asked = since(i).filter((e) => e.kind === 'ticket')
  check('an unfunded account is refused a ticket (402)', asked.length === 1 && asked[0].status === 402, asked.map((e) => e.status).join(','))
  check('… and reads the file free instead', same(r.data, big.bytes) && since(i).some((e) => e.kind === 'free'))
  const j = log.length
  await read(big, poor)
  check('… and asks for no ticket on its next read', since(j).every((e) => e.kind !== 'ticket'))
}

// --- a hot node serving wrong bytes: the file is checked, and read free
{
  hotHook = async (res) => {
    const bytes = new Uint8Array(await res.arrayBuffer())
    bytes[bytes.length >> 1] ^= 0xff
    return new Response(bytes, { status: res.status, headers: res.headers })
  }
  const i = log.length
  const r = await read(big, backend())
  hotHook = null
  check('wrong bytes from a hot node are caught; the file is read free', same(r.data, big.bytes) && since(i).some((e) => e.kind === 'free'))
}

// --- a hot node failing: the next ticket avoids it
{
  let failedOnce = false
  hotHook = async (res, entry) => {
    if (failedOnce) return null
    failedOnce = true
    await res.body?.cancel()
    entry.status = 503
    return new Response(JSON.stringify({ code: 'Unavailable', reason: 'AT_CAPACITY', retry: true }), { status: 503 })
  }
  const i = log.length
  const r = await read(big, backend())
  hotHook = null
  const asked = since(i).filter((e) => e.kind === 'ticket')
  const avoid = asked[1]?.body ? JSON.parse(asked[1].body).avoid : undefined
  check('a failing hot node is avoided on the next ticket', asked.length >= 2 && Array.isArray(avoid) && avoid.length === 1, `tickets ${asked.length}, avoid ${JSON.stringify(avoid)}`)
  check('… and the file still arrives whole', same(r.data, big.bytes))
}

const s = await standing(account.address)
check('hot reads are billed to the account', BigInt(s.hotCharges) > 0n || BigInt(s.outstanding) > 0n, `hotCharges ${s.hotCharges}, outstanding ${s.outstanding}`)

for (const f of files) await main.relayer.delete(account, f.meta.rootHashes[0].slice(2)).catch((e) => console.log(`could not delete ${f.name}: ${e.message}`))
console.log(`${stamp()} files deleted`)

console.log(failed ? `${failed} FAILED` : `${passed}/${passed} checks passed`)
process.exit(failed ? 1 : 0)
