// End-to-end smoke test against 0G Galileo testnet (Turbo).
// Requires a funded testnet wallet: PRIVATE_KEY=0x… npm run smoke
// Get funds at https://faucet.0g.ai (0.1 0G/day).
//
// Exercises the production path: ECIES-encrypt to the wallet's own pubkey,
// upload, wait for finality, download, decrypt, verify bytes match, and
// report the actual cost (balance delta).
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  uploadData,
  downloadFile,
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
  console.error('Usage: PRIVATE_KEY=0x<64 hex> npm run smoke (or create .env)')
  process.exit(1)
}

const provider = new ethers.JsonRpcProvider(
  process.env.RPC_URL || network.rpcUrl
)
const wallet = new ethers.Wallet(privateKey, provider)
const address = await wallet.getAddress()
console.log(`Wallet:      ${address}`)

const balanceBefore = await provider.getBalance(address)
console.log(`Balance:     ${ethers.formatEther(balanceBefore)} 0G`)

// ~1 MB of random data (crypto.getRandomValues caps at 64 KiB per call)
const data = new Uint8Array(1024 * 1024)
for (let i = 0; i < data.length; i += 65536) {
  crypto.getRandomValues(data.subarray(i, Math.min(i + 65536, data.length)))
}
console.log(`Payload:     ${data.length} bytes random`)

// ECIES to our own compressed pubkey — same path desktop/Node clients use
const recipientPubKey = ethers.SigningKey.computePublicKey(
  wallet.signingKey.publicKey,
  true
)
console.log(`Encrypting:  ECIES → ${recipientPubKey.slice(0, 20)}…`)

console.log('\n— upload —')
const result = await uploadData(data, network, wallet, {
  encryption: { type: 'ecies', recipientPubKey },
  // strict path: block until the storage miner seals the sector
  finalityRequired: true,
  onProgress: (msg, pct) => console.log(`  ${pct !== undefined ? pct + '% ' : ''}${msg}`),
})
console.log(`rootHash:    ${result.rootHash}`)
console.log(`txHash:      ${result.txHash}`)
console.log(`explorer:    ${network.explorerTxUrl}${result.txHash}`)

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
  for (let i = 0; i < data.length; i += 4096) {
    if (data[i] !== roundTripped[i]) {
      equal = false
      break
    }
  }
}
const balanceAfter = await provider.getBalance(address)
const cost = balanceBefore - balanceAfter

console.log(`\ndecrypted:   ${decrypted}`)
console.log(`bytes match: ${equal}`)
console.log(`size:        ${roundTripped.length} / ${data.length}`)
console.log(`cost:        ${ethers.formatEther(cost)} 0G (gas + storage fee)`)

if (!decrypted || !equal) {
  console.error('\nSMOKE TEST FAILED')
  process.exit(1)
}
console.log('\nSMOKE TEST PASSED ✓')
