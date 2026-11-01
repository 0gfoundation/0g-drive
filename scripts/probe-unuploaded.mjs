// Probe: what do storage nodes report for a log entry whose transaction was
// mined but whose data was never uploaded (the browser closed in between)?
// Submits one small blob via batchSubmit, uploads nothing, then asks every
// node about it and times a download attempt.
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Indexer, MemData, getFlowContract, getMarketContract } from '@0gfoundation/0g-storage-ts-sdk'
import { downloadFile, getNetworkConfig } from '../core/dist/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const privateKey =
  process.env.PRIVATE_KEY ??
  /^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(readFileSync(resolve(root, '.env'), 'utf8'))?.[1]
const network = getNetworkConfig('testnet', 'turbo')
const provider = new ethers.JsonRpcProvider(network.rpcUrl)
const wallet = new ethers.Wallet(privateKey, provider)
const address = await wallet.getAddress()
const t0 = Date.now()
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`

const data = crypto.getRandomValues(new Uint8Array(1500))
const file = new MemData(data)
const [tree] = await file.merkleTree()
const rootHash = tree.rootHash()
const [sub] = await file.createSubmission('0x', address)
const flow = getFlowContract(network.flowAddress, wallet)
const price = await getMarketContract(await flow.market(), provider).pricePerSector()
const fee = sub.data.nodes.reduce((n, node) => n + (1n << BigInt(node.height)), 0n) * price
const tx = await flow.getFunction('batchSubmit').send([sub], { value: fee })
const receipt = await tx.wait()
const ev = receipt.logs.map((l) => { try { return flow.interface.parseLog(l) } catch { return null } }).find((p) => p?.name === 'Submit')
const txSeq = Number(ev.args.submissionIndex)
console.log(`[${el()}] mined, root ${rootHash} txSeq ${txSeq}`)

const indexer = new Indexer(network.indexerRpc)
const [nodes] = await indexer.selectNodes(1)
const { trusted } = await indexer.getShardedNodes()
console.log('selected', nodes.length, 'trusted', trusted.length)
const { StorageNode } = await import('@0gfoundation/0g-storage-ts-sdk')
for (let round = 0; round < 6; round++) {
  await new Promise((r) => setTimeout(r, 10_000))
  const rows = await Promise.all(trusted.map(async (t) => {
    const n = new StorageNode(t.url)
    const a = await n.getFileInfo(rootHash, true).catch((e) => 'ERR ' + e.message)
    const b = await n.getFileInfoByTxSeq(txSeq).catch((e) => 'ERR ' + e.message)
    const s = (i) => i && typeof i === 'object' ? `fin=${i.finalized} seg=${i.uploadedSegNum} cached=${i.isCached} pruned=${i.pruned}` : String(i)
    return `${t.url} shard ${t.config.shardId}/${t.config.numShard}: byRoot ${s(a)} | bySeq ${s(b)}`
  }))
  console.log(`[${el()}] round ${round}\n  ` + rows.join('\n  '))
  const locs = await indexer.getFileLocations(rootHash).catch((e) => 'ERR ' + e.message)
  console.log('  locations', Array.isArray(locs) ? locs.length : locs)
}
const s = Date.now()
try {
  await downloadFile([rootHash], network, { txSeqs: [txSeq], onProgress: () => {} })
  console.log('download unexpectedly succeeded')
} catch (e) {
  console.log(`download failed after ${((Date.now() - s) / 1000).toFixed(1)}s: ${e.message}`)
}
console.log(JSON.stringify({ rootHash, txSeq }))
