// M2 end-to-end test: drive semantics on 0G (manifest-based metadata).
// Exercises the full DriveStore API against Galileo testnet, including a
// simulated restart (fresh store instance, zero local state) to prove the
// drive is reconstructible purely from on-chain events + downloads.
// Usage: node scripts/test-drive.mjs  (reads PRIVATE_KEY from env or .env)
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DriveStore,
  getNetworkConfig,
  bytesToHex,
} from '../core/dist/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let privateKey = process.env.PRIVATE_KEY
if (!privateKey) {
  privateKey = /^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(
    readFileSync(resolve(root, '.env'), 'utf8')
  )?.[1]
}
if (!privateKey) {
  console.error('Usage: node scripts/test-drive.mjs (needs PRIVATE_KEY env or .env)')
  process.exit(1)
}

const network = getNetworkConfig('testnet', 'turbo')
const provider = new ethers.JsonRpcProvider(network.rpcUrl)
const wallet = new ethers.Wallet(privateKey, provider)
const balanceBefore = await provider.getBalance(wallet.address)
console.log(`Wallet:  ${await wallet.getAddress()}`)
console.log(`Balance: ${ethers.formatEther(balanceBefore)} 0G\n`)

// Drive master key for this test run (random — persistence is the
// keystore's job in the real app)
const masterKey = new Uint8Array(32)
crypto.getRandomValues(masterKey)
const masterKeyHex = bytesToHex(masterKey)

// Each store gets its own event cache starting at this run's first block:
// without one, every refresh rescans the test wallet's entire upload
// history (hundreds of getLogs calls at current chain heights). A new store
// still starts with NO cached events — restart recovery is still proven
// from chain state alone, just not across years of unrelated history.
const startBlock = (await provider.getBlockNumber()) - 5
const newStore = () => {
  let cache = { events: [], toBlock: startBlock }
  return new DriveStore(network, wallet, masterKey, {
    onProgress: (msg) => {
      if (msg.includes('sealed') || msg.includes('Repair')) console.log(`    ${msg}`)
    },
    eventCache: {
      load: () => cache,
      save: (events, toBlock) => {
        cache = { events, toBlock }
      },
    },
  })
}

function fileMeta(id, name) {
  return {
    id,
    name,
    size: 1024 * 1024,
    mime: 'application/octet-stream',
    uploadedAt: Date.now(),
    encryption: 'aes256',
    rootHashes: ['0x' + 'ab'.repeat(32)],
    txHashes: ['0x' + 'cd'.repeat(32)],
    network: 'testnet:turbo',
  }
}

let failures = 0
function check(label, cond, detail = '') {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

// ── 1. Fresh drive ────────────────────────────────────────────────────
console.log('— load fresh drive —')
let store = newStore()
let state = await store.loadDrive()
check('index empty', state.index.folders.length === 0)

// ── 2. Folder + files ─────────────────────────────────────────────────
console.log('\n— createFolder("Photos") + putFileRecord ×2 —')
await store.createFolder('Photos')
await store.putFileRecord('Photos', fileMeta('f1', 'sunset.jpg'))
await store.putFileRecord('Photos', fileMeta('f2', 'beach.png'))
await store.putFileRecord('Documents', fileMeta('f3', 'notes.md')) // implicit folder
console.log('  (3 manifest txs + 2 index txs submitted, sealed)')

// ── 3. Simulated restart: fresh store, no local state ────────────────
console.log('\n— restart: fresh DriveStore, reconstruct from chain —')
store = newStore() // same key, zero cached state
state = await store.loadDrive()
check('folders', JSON.stringify(state.index.folders.sort()) === JSON.stringify(['Documents', 'Photos']),
  state.index.folders.join(', '))
check('Photos files', state.folders.get('Photos')?.files.length === 2,
  state.folders.get('Photos')?.files.map((f) => f.name).join(', '))
check('Documents files', state.folders.get('Documents')?.files.length === 1)
check('trash empty', (state.trash?.files.length ?? 0) === 0)

// ── 4. Trash + rename + remove-folder guards ──────────────────────────
console.log('\n— removeFileRecord → trash; renameFolder; removeFolder —')
await store.removeFileRecord('Photos', 'f1')
await store.renameFolder('Documents', 'Docs')
await store.createFolder('Temp')
await store.removeFolder('Temp')

try {
  await store.removeFolder('Docs')
  check('removeFolder on non-empty folder rejected', false)
} catch (err) {
  check('removeFolder on non-empty folder rejected', /not empty/.test(err.message))
}

// ── 5. Final restart & verify ────────────────────────────────────────
console.log('\n— final restart & verify —')
store = newStore()
state = await store.loadDrive()
const photos = state.folders.get('Photos')?.files ?? []
check('Photos has 1 file after trash', photos.length === 1 && photos[0].name === 'beach.png')
check('trash has sunset.jpg with originalPath',
  state.trash?.files.length === 1 &&
  state.trash.files[0].name === 'sunset.jpg' &&
  state.trash.files[0].originalPath === 'Photos')
check('Docs renamed (files moved)',
  JSON.stringify(state.index.folders.sort()) === JSON.stringify(['Docs', 'Photos']) &&
  state.folders.get('Docs')?.files.length === 1)
check('Temp removed', !state.index.folders.includes('Temp'))

// ── 6. Cost report ────────────────────────────────────────────────────
const balanceAfter = await provider.getBalance(wallet.address)
console.log(`\ndrive key:  ${masterKeyHex}`)
console.log(`cost:       ${ethers.formatEther(balanceBefore - balanceAfter)} 0G for ~11 metadata txs`)

if (failures > 0) {
  console.error(`\n${failures} CHECKS FAILED`)
  process.exit(1)
}
console.log('\nDRIVE TEST PASSED ✓')
