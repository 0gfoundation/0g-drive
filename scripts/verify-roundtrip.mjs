// Fast E2E roundtrip: upload (without waiting for sector finality),
// immediately download, decrypt, and byte-compare.
// Complements smoke-upload.mjs, which exercises the strict finality path.
// Usage: PRIVATE_KEY=0x… node scripts/verify-roundtrip.mjs
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  uploadData,
  downloadFile,
  getFileInfo,
  getNetworkConfig,
} from '../core/dist/index.js'

// PRIVATE_KEY from env, or from the repo's .env (created by gen-test-wallet.mjs)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let privateKey = process.env.PRIVATE_KEY
if (!privateKey) {
  try {
    privateKey = /^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(
      readFileSync(resolve(root, '.env'), 'utf8')
    )?.[1]
  } catch {
    /* no .env */
  }
}
const network = getNetworkConfig('testnet', 'turbo')
if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
  console.error('Usage: node scripts/verify-roundtrip.mjs (needs PRIVATE_KEY env or .env)')
  process.exit(1)
}

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || network.rpcUrl)
const wallet = new ethers.Wallet(privateKey, provider)
const address = await wallet.getAddress()
const balanceBefore = await provider.getBalance(address)
console.log(`Wallet:  ${address}`)

// 256 KB (one segment) of random data
const data = new Uint8Array(256 * 1024)
for (let i = 0; i < data.length; i += 65536) {
  crypto.getRandomValues(data.subarray(i, Math.min(i + 65536, data.length)))
}
console.log(`Payload: ${data.length} bytes random`)

const recipientPubKey = ethers.SigningKey.computePublicKey(
  wallet.signingKey.publicKey,
  true
)

console.log('\n— upload (finalityRequired: false) —')
const result = await uploadData(data, network, wallet, {
  encryption: { type: 'ecies', recipientPubKey },
  onProgress: (msg) => console.log(`  ${msg}`),
})
console.log(`rootHash: ${result.rootHash}`)
console.log(`txHash:   ${result.txHash}`)

console.log('\n— download + decrypt —')
const { data: roundTripped, decrypted } = await downloadFile(
  [result.rootHash],
  network,
  {
    decryption: { privateKey },
    txSeqs: [result.txSeq],
    onProgress: (msg, pct) => console.log(`  ${pct !== undefined ? pct + '% ' : ''}${msg}`),
  }
)

let equal = roundTripped.length === data.length
if (equal) {
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== roundTripped[i]) {
      equal = false
      break
    }
  }
}

const info = await getFileInfo(result.rootHash, network)
const balanceAfter = await provider.getBalance(address)

console.log(`\ndecrypted:   ${decrypted}`)
console.log(`bytes match: ${equal} (${roundTripped.length} / ${data.length})`)
console.log(`finalized:   ${info?.finalized ?? 'n/a'} (data retrievable regardless)`)
console.log(`cost:        ${ethers.formatEther(balanceBefore - balanceAfter)} 0G`)

if (!decrypted || !equal) {
  console.error('\nROUNDTRIP FAILED')
  process.exit(1)
}
console.log('\nROUNDTRIP PASSED ✓')
