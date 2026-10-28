// E2E: drive-key recovery (Option C) on testnet.
// 1. generate master key M, publish backup wrapped under S (signature)
// 2. fresh client restores M via signature alone
// 3. wrong wallet fails loudly
// 4. password path: set password, restore via password alone
// Usage: node scripts/test-recovery.mjs
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getNetworkConfig,
  publishDriveKeyBackup,
  hasDriveKeyBackup,
  restoreDriveKeyBySignature,
  restoreDriveKeyByPassword,
  setRecoveryPassword,
  RECOVERY_SIGN_MESSAGE,
} from '../core/dist/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const privateKey = /^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(
  readFileSync(resolve(root, '.env'), 'utf8')
)?.[1]
if (!privateKey) {
  console.error('needs PRIVATE_KEY env or .env')
  process.exit(1)
}

const network = getNetworkConfig('testnet', 'turbo')
const provider = new ethers.JsonRpcProvider(network.rpcUrl)
const wallet = new ethers.Wallet(privateKey, provider)
const wrongWallet = ethers.Wallet.createRandom()
const balanceBefore = await provider.getBalance(wallet.address)
console.log(`wallet: ${wallet.address}`)

let failures = 0
function check(label, cond, detail = '') {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

console.log('\n— publish backup (M wrapped under signature key) —')
const masterKey = new Uint8Array(32)
crypto.getRandomValues(masterKey)
// Node path: sign directly with the raw key (browser path uses MetaMask —
// same message, same derivation)
const sig = await wallet.signMessage(RECOVERY_SIGN_MESSAGE)
const { ethers: _e } = { ethers }
const { deriveRecoveryKey } = await import('../core/dist/index.js')
const recoveryKey = deriveRecoveryKey(sig)
const pub = await publishDriveKeyBackup(
  network, wallet, wallet.address, masterKey, recoveryKey
)
console.log(`  backup tx ${pub.txHash}`)
check('backup visible on-chain', await hasDriveKeyBackup(wallet.address, network))

console.log('\n— fresh client restores via signature alone —')
const restored = await restoreDriveKeyBySignature(wallet.address, network, wallet)
check(
  'master key restored',
  restored !== null && Buffer.from(restored.masterKey).equals(Buffer.from(masterKey))
)

console.log('\n— wrong wallet fails loudly —')
let wrongFails = false
try {
  await restoreDriveKeyBySignature(wallet.address, network, wrongWallet)
} catch {
  wrongFails = true
}
check('wrong wallet rejected', wrongFails)

console.log('\n— password path —')
await setRecoveryPassword(network, wallet, wallet.address, masterKey, 'correct horse battery staple')
const byPassword = await restoreDriveKeyByPassword(wallet.address, network, 'correct horse battery staple')
check(
  'master key restored via password',
  byPassword !== null && Buffer.from(byPassword.masterKey).equals(Buffer.from(masterKey))
)
let wrongPasswordFails = false
try {
  await restoreDriveKeyByPassword(wallet.address, network, 'wrong password')
} catch {
  wrongPasswordFails = true
}
check('wrong password rejected', wrongPasswordFails)

const balanceAfter = await provider.getBalance(wallet.address)
console.log(`\ncost: ${ethers.formatEther(balanceBefore - balanceAfter)} 0G (2 backup txs)`)
if (failures > 0) {
  console.error(`\n${failures} CHECKS FAILED`)
  process.exit(1)
}
console.log('\nRECOVERY TEST PASSED ✓')
