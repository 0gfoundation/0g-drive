// Experiment: register several blobs in ONE Flow transaction (batchSubmit),
// then upload each blob's segments with skipTx. If this works on Galileo,
// an upload batch (N files + manifest) costs a single wallet prompt.
//
// Steps: build N submissions → one batchSubmit tx (fee = sum) → parse Submit
// events (one per blob, in order) → wait until storage nodes see each root →
// upload segments with skipTx through a signer that REFUSES transactions (so
// a fallback can never silently pay twice) → wait for sealing → download and
// compare bytes.
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Indexer,
  MemData,
  getFlowContract,
  getMarketContract,
} from '@0gfoundation/0g-storage-ts-sdk'
import { downloadFile, getNetworkConfig } from '../core/dist/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const privateKey =
  process.env.PRIVATE_KEY ??
  /^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(readFileSync(resolve(root, '.env'), 'utf8'))?.[1]
const network = getNetworkConfig('testnet', 'turbo')
const provider = new ethers.JsonRpcProvider(network.rpcUrl)
const wallet = new ethers.Wallet(privateKey, provider)
const address = await wallet.getAddress()
const N = Number(process.env.N ?? 3)
const t0 = Date.now()
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`

console.log(`Wallet ${address}  balance ${ethers.formatEther(await provider.getBalance(address))} 0G`)

// Varied sizes: tiny, multi-segment, odd length
const sizes = [3_000, 700_000, 1_234_567, 50_000, 300_001].slice(0, N)
const blobs = sizes.map((n) => {
  const d = new Uint8Array(n)
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(d.subarray(i, Math.min(i + 65536, n)))
  return d
})
const files = blobs.map((b) => new MemData(b))

// 1. Submissions + roots
const submissions = []
const roots = []
for (const f of files) {
  const [tree, terr] = await f.merkleTree()
  if (terr) throw terr
  roots.push(tree.rootHash())
  const [sub, serr] = await f.createSubmission('0x', address)
  if (serr) throw serr
  submissions.push(sub)
}
console.log(`[${el()}] prepared ${N} submissions:`, roots.map((r, i) => `${sizes[i]}B ${r.slice(0, 10)}…`).join(', '))

// 2. Fee = sum of per-submission fees (same formula as the SDK)
const flow = getFlowContract(network.flowAddress, wallet)
const market = getMarketContract(await flow.market(), provider)
const pricePerSector = await market.pricePerSector()
const fee = submissions.reduce((acc, s) => {
  const sectors = s.data.nodes.reduce((n, node) => n + (1n << BigInt(node.height)), 0n)
  return acc + sectors * pricePerSector
}, 0n)
console.log(`[${el()}] total fee ${ethers.formatEther(fee)} 0G`)

// 3. One transaction
const tx = await flow.getFunction('batchSubmit').send(submissions, { value: fee })
console.log(`[${el()}] batchSubmit tx ${tx.hash}`)
const receipt = await tx.wait()
console.log(`[${el()}] mined block ${receipt.blockNumber} status ${receipt.status} gasUsed ${receipt.gasUsed}`)

const submitEvents = receipt.logs
  .filter((l) => l.address.toLowerCase() === network.flowAddress.toLowerCase())
  .map((l) => { try { return flow.interface.parseLog(l) } catch { return null } })
  .filter((p) => p?.name === 'Submit')
const txSeqs = submitEvents.map((e) => Number(e.args.submissionIndex))
console.log(`[${el()}] Submit events: ${submitEvents.length}, txSeqs ${txSeqs.join(', ')}`)
if (submitEvents.length !== N) throw new Error('expected one Submit event per blob')

// 4. A signer that can sign nothing: proves skipTx never falls back to a tx
const guard = new Proxy(wallet, {
  get(target, prop, recv) {
    if (prop === 'sendTransaction' || prop === 'signTransaction') {
      return () => { throw new Error('GUARD: unexpected transaction during segment upload') }
    }
    const v = Reflect.get(target, prop, recv)
    return typeof v === 'function' ? v.bind(target) : v
  },
})

const indexer = new Indexer(network.indexerRpc)
const [nodes, nerr] = await indexer.selectNodes(1)
if (nerr) throw nerr

async function waitVisible(rootHash) {
  for (let i = 0; i < 120; i++) {
    let seen = 0
    for (const n of nodes) {
      try { if (await n.getFileInfo(rootHash, true)) seen++ } catch {}
    }
    if (seen === nodes.length) return
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`root ${rootHash} not visible on nodes`)
}

// 5. Segments, per blob, no tx
for (let i = 0; i < N; i++) {
  await waitVisible(roots[i])
  const [res, err] = await indexer.upload(files[i], network.rpcUrl, guard, {
    skipTx: true,
    // the SDK's skip check asks one node; for a 1-segment blob that node may
    // own none of it and report "finalized" — found by this test
    skipIfFinalized: false,
    finalityRequired: false,
  })
  if (err) throw err
  console.log(`[${el()}] segments uploaded for blob ${i} (txSeq ${res.txSeq ?? '?'})`)
}

// 6. Sealing
for (let i = 0; i < N; i++) {
  for (let k = 0; ; k++) {
    let sealed = true
    for (const n of nodes) {
      const info = await n.getFileInfo(roots[i], true).catch(() => null)
      if (!info?.finalized) sealed = false
    }
    if (sealed) break
    if (k > 180) throw new Error(`blob ${i} not sealed after 15 min`)
    await new Promise((r) => setTimeout(r, 5000))
  }
  console.log(`[${el()}] blob ${i} sealed`)
}

// 7. Round-trip
for (let i = 0; i < N; i++) {
  const { data } = await downloadFile([roots[i]], network, { txSeqs: [txSeqs[i]] })
  const ok = data.length === blobs[i].length && data.every((b, j) => b === blobs[i][j])
  console.log(`[${el()}] blob ${i} download ${ok ? 'MATCH' : 'MISMATCH'} (${data.length} B)`)
  if (!ok) process.exitCode = 1
}
console.log(`balance after ${ethers.formatEther(await provider.getBalance(address))} 0G`)
