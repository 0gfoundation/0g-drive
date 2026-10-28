// End-to-end test of core's uploadBatch (the app's one-prompt upload path):
// 3 AES-encrypted files of varied sizes — including a 1-segment file, the
// case that exposed the SDK's single-node skipIfFinalized check — plus one
// finalize() item (stands in for the folder manifest), all in ONE
// transaction, with strict finality; then download + decrypt + compare.
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { uploadBatch, downloadFile, getNetworkConfig, generateFileKey } from '../core/dist/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const privateKey =
  process.env.PRIVATE_KEY ??
  /^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(readFileSync(resolve(root, '.env'), 'utf8'))?.[1]
const network = getNetworkConfig('testnet', 'turbo')
const provider = new ethers.JsonRpcProvider(network.rpcUrl)
const wallet = new ethers.Wallet(privateKey, provider)
const t0 = Date.now()
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`

// count transactions this wallet sends
let sentTxs = 0
const counting = new Proxy(wallet, {
  get(target, prop, recv) {
    if (prop === 'sendTransaction') {
      return (tx) => {
        sentTxs++
        return target.sendTransaction(tx)
      }
    }
    const v = Reflect.get(target, prop, recv)
    return typeof v === 'function' ? v.bind(target) : v
  },
})

const random = (n) => {
  const d = new Uint8Array(n)
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(d.subarray(i, Math.min(i + 65536, n)))
  return d
}
const files = [random(2_500), random(900_000), random(1_500_001)]
const keys = files.map(() => generateFileKey())
const manifestKey = generateFileKey()
let manifest = null

const before = await provider.getBalance(wallet.address)
console.log(`wallet ${wallet.address} balance ${ethers.formatEther(before)} 0G`)

const res = await uploadBatch(
  files.map((data, i) => ({ data, encryption: { type: 'aes256', key: keys[i] } })),
  network,
  counting,
  {
    finalize: async (roots) => {
      manifest = new TextEncoder().encode(JSON.stringify({ files: roots, at: Date.now() }))
      console.log(`[${el()}] finalize: roots known before the tx: ${roots.map((r) => r.slice(0, 10)).join(', ')}`)
      return [{ data: manifest, encryption: { type: 'aes256', key: manifestKey } }]
    },
    onProgress: (m) => console.log(`[${el()}] ${m}`),
    onItem: (i, phase, msg) => {
      if (phase !== 'sealing' || !msg || !msg.startsWith('Waiting')) console.log(`[${el()}]   item ${i}: ${phase}${msg ? ` — ${msg}` : ''}`)
    },
  }
)

console.log(`[${el()}] tx ${res.txHash}; wallet transactions sent: ${sentTxs}`)
const all = [...res.items, ...res.extras]
const blobs = [...files, manifest]
const allKeys = [...keys, manifestKey]
let ok = sentTxs === 1
for (let i = 0; i < all.length; i++) {
  const r = all[i]
  if (!r.ok) {
    console.log(`item ${i}: FAILED ${r.error}`)
    ok = false
    continue
  }
  const { data, decrypted } = await downloadFile(r.result.rootHashes, network, {
    decryption: { symmetricKey: allKeys[i] },
    txSeqs: r.result.txSeqs,
  })
  const match = decrypted && data.length === blobs[i].length && data.every((b, j) => b === blobs[i][j])
  console.log(`[${el()}] item ${i}: txSeq ${r.result.txSeq} ${blobs[i].length} B → ${match ? 'MATCH' : 'MISMATCH'}`)
  if (!match) ok = false
}
const after = await provider.getBalance(wallet.address)
console.log(`cost ${ethers.formatEther(before - after)} 0G (fees + gas)`)
console.log(ok ? 'PASS: 4 blobs, 1 transaction, all sealed and byte-identical' : 'FAIL')
process.exitCode = ok ? 0 : 1
