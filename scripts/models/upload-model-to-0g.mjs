// Upload the pruned text model (scripts/models/prune-text-model.py) to 0G
// Storage, unencrypted (the files are public), in one transaction, and print
// what the app pins in web/src/ai/modelOn0g.ts: each file's root hash,
// txSeq, size and SHA-256. Paid by .env's PRIVATE_KEY wallet.
//
//   [NETWORK=mainnet] node scripts/models/upload-model-to-0g.mjs MODEL_DIR
import { ethers } from 'ethers'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { uploadBatch, getNetworkConfig } from '../../core/dist/index.js'

const FILES = ['config.json', 'tokenizer_config.json', 'special_tokens_map.json', 'tokenizer.json', 'onnx/model_quantized.onnx']
const dir = process.argv[2]
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const privateKey = /^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(readFileSync(resolve(root, '.env'), 'utf8'))[1]
const which = process.env.NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
const network = getNetworkConfig(which, 'turbo')
const wallet = new ethers.Wallet(privateKey, new ethers.JsonRpcProvider(network.rpcUrl))

const bytes = FILES.map((f) => new Uint8Array(readFileSync(join(dir, f))))
console.error(`uploading ${FILES.length} files (${(bytes.reduce((n, b) => n + b.length, 0) / 1e6).toFixed(1)} MB) to ${which}…`)
const res = await uploadBatch(
  bytes.map((data) => ({ data })),
  network,
  wallet,
  { finalityRequired: true, onItem: (i, phase) => console.error(`  ${FILES[i]}: ${phase}`) }
)
const failed = res.items.filter((r) => !r.ok)
if (failed.length) {
  console.error('failed:', failed.map((r) => r.error).join('; '))
  process.exit(1)
}
const out = {}
FILES.forEach((f, i) => {
  const r = res.items[i].result
  out[f] = { root: r.rootHash, txSeq: r.txSeq, size: bytes[i].length, sha256: createHash('sha256').update(bytes[i]).digest('hex') }
})
console.log(JSON.stringify({ network: `${which}:turbo`, tx: res.txHash, files: out }, null, 2))
