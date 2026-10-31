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
  uploadBatch,
  folderTag,
  indexTag,
  TRASH_PATH,
} from '../core/dist/index.js'
import { refund } from './lib/refund.mjs'

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
const newStore = (signer = wallet, key = masterKey) => {
  let cache = { events: [], toBlock: startBlock }
  return new DriveStore(network, signer, key, {
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
check('index empty', state.paths.length === 0)

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
check('folders', JSON.stringify(state.paths.sort()) === JSON.stringify(['Documents', 'Photos']),
  state.paths.join(', '))
check('Photos files', state.folders.get('Photos')?.files.length === 2,
  state.folders.get('Photos')?.files.map((f) => f.name).join(', '))
check('Documents files', state.folders.get('Documents')?.files.length === 1)
check('trash empty', (state.trash?.files.length ?? 0) === 0)

// ── 4. Trash + rename + remove-folder guards ──────────────────────────
console.log('\n— removeFileRecord → trash; renameFolder; removeFolder —')
let nonce = await provider.getTransactionCount(wallet.address)
const txsSince = async () => {
  const now = await provider.getTransactionCount(wallet.address)
  const n = now - nonce
  nonce = now
  return n
}
await store.removeFileRecord('Photos', 'f1')
const trashTxs = await txsSince()
check('move to trash: one transaction (folder + trash)', trashTxs === 1, `${trashTxs} tx`)
await txsSince()
await store.renameFolder('Documents', 'Docs')
const renameTxs = await txsSince()
check('rename folder: one transaction (index only)', renameTxs === 1, `${renameTxs} tx`)
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
  JSON.stringify(state.paths.sort()) === JSON.stringify(['Docs', 'Photos']) &&
  state.folders.get('Docs')?.files.length === 1)
check('Temp removed', !state.paths.includes('Temp'))

// ── 6. Moves: two destinations (one new folder) in ONE transaction ──
console.log('\n— moveRecords: Inbox → Docs + Archive (new), one transaction —')
await store.putFileRecords('Inbox', [fileMeta('f4', 'invoice.pdf'), fileMeta('f5', 'old-photo.jpg')])
nonce = await provider.getTransactionCount(wallet.address)
await store.moveRecords('Inbox', [
  { id: 'f4', to: 'Docs' },
  { id: 'f5', to: 'Archive' },
])
const moveTxs = await txsSince()
check('one transaction for 3 manifests + the index', moveTxs === 1, `${moveTxs} tx`)
store = newStore()
state = await store.loadDrive()
check('after restart: invoice in Docs, photo in new Archive, Inbox empty',
  state.folders.get('Docs')?.files.some((f) => f.id === 'f4') &&
  state.folders.get('Archive')?.files.length === 1 &&
  state.paths.includes('Archive') &&
  state.folders.get('Inbox')?.files.length === 0,
  state.paths.join(', '))

// ── 7. Folder trash + restore, each in ONE transaction ───────────────
console.log('\n— trashFolder(Archive), then restore its file —')
await store.createFolder('Archive/2025')
await store.putFileRecord('Archive/2025', fileMeta('f6', 'tax.pdf'))
await txsSince()
await store.trashFolder('Archive')
const folderTxs = await txsSince()
check('folder to trash: one transaction (trash + index)', folderTxs === 1, `${folderTxs} tx`)
await store.restoreRecords(['f5', 'f6'])
const restoreTxs = await txsSince()
check('restore to 2 folders (both gone from the index): one transaction', restoreTxs === 1, `${restoreTxs} tx`)
store = newStore()
state = await store.loadDrive()
check('after restart: both restored to their own folders, trash keeps only sunset.jpg',
  state.folders.get('Archive')?.files.some((f) => f.id === 'f5') &&
  state.folders.get('Archive/2025')?.files.some((f) => f.id === 'f6') &&
  state.paths.includes('Archive') && state.paths.includes('Archive/2025') &&
  JSON.stringify(state.trash?.files.map((f) => f.name)) === '["sunset.jpg"]',
  `${state.paths.join(', ')} | trash: ${state.trash?.files.map((f) => f.name).join(', ')}`)

// ── 8. Folder ids: rename with subfolders, trash follows, no reuse ───
console.log('\n— trash tax.pdf, rename Archive → Old, restore it; trash Old, re-create it —')
await store.removeFileRecord('Archive/2025', 'f6')
await txsSince()
const newPath = await store.renameFolder('Archive', 'Old')
const renameTreeTxs = await txsSince()
check('rename a folder with a subfolder: one transaction', renameTreeTxs === 1 && newPath === 'Old', `${renameTreeTxs} tx → ${newPath}`)
try {
  await store.renameFolder('Old', 'docs')
  check('rename to a sibling’s name (other case) refused', false)
} catch (err) {
  check('rename to a sibling’s name (other case) refused', /already a folder named "Docs"/.test(err.message), err.message)
}
store = newStore()
state = await store.loadDrive()
check('after restart: files and subfolder under the new name; trash shows the new path',
  state.folders.get('Old')?.files.some((f) => f.id === 'f5') &&
  state.paths.includes('Old/2025') && !state.paths.some((p) => p.startsWith('Archive')) &&
  state.trash?.files.find((f) => f.id === 'f6')?.originalPath === 'Old/2025',
  `${state.paths.join(', ')} | f6 from ${state.trash?.files.find((f) => f.id === 'f6')?.originalPath}`)
await store.restoreRecords(['f6'])
await store.trashFolder('Old')
await store.createFolder('Old')
store = newStore()
state = await store.loadDrive()
check('restore went to the renamed folder; a re-created "Old" starts empty',
  state.paths.includes('Old') && !state.paths.includes('Old/2025') && !state.paths.includes('Archive/2025') &&
  (state.folders.get('Old')?.files.length ?? 0) === 0 &&
  state.trash?.files.find((f) => f.id === 'f6')?.originalPath === 'Old/2025',
  `${state.paths.join(', ')} | Old: ${state.folders.get('Old')?.files.length ?? 0} files`)

// ── 9. A drive made before folder ids (v1 index of paths) ─────────────
// Written raw, as the old code did: on a fresh wallet so its index is
// the only one.
console.log('\n— v1 drive (folder paths): read, rename, restore, no stale lists —')
const legacy = ethers.Wallet.createRandom().connect(provider)
await (await wallet.sendTransaction({ to: legacy.address, value: ethers.parseEther('0.05') })).wait()
const legacyKey = crypto.getRandomValues(new Uint8Array(32))
const raw = (value, tag) => ({
  data: new TextEncoder().encode(JSON.stringify(value)),
  encryption: { type: 'aes256', key: legacyKey },
  tags: tag,
})
const m = (path, files) => raw({ path, files, updatedAt: Date.now(), version: 1 }, folderTag(path))
await uploadBatch([
  raw({ folders: ['Work', 'Work/2025'], updatedAt: Date.now(), version: 3 }, indexTag()),
  m('Work', [fileMeta('g1', 'plan.md')]),
  m('Work/2025', [fileMeta('g2', 'report.pdf')]),
  m(TRASH_PATH, [{ ...fileMeta('g3', 'draft.md'), originalPath: 'Work' }]),
  m('Gone', [fileMeta('g4', 'stale.txt')]), // a folder the old code trashed
], network, legacy, {})
let lstore = newStore(legacy, legacyKey)
state = await lstore.loadDrive()
check('v1 drive loads: folders, files, trash',
  JSON.stringify(state.paths) === '["Work","Work/2025"]' &&
  state.folders.get('Work')?.files[0]?.id === 'g1' && state.folders.get('Work/2025')?.files[0]?.id === 'g2' &&
  state.trash?.files[0]?.originalPath === 'Work', state.paths.join(', '))
let lnonce = await provider.getTransactionCount(legacy.address)
await lstore.renameFolder('Work', 'Projects')
check('rename a v1 folder: one transaction', (await provider.getTransactionCount(legacy.address)) - lnonce === 1)
await lstore.createFolder('Gone')
await lstore.restoreRecords(['g3'])
lstore = newStore(legacy, legacyKey)
state = await lstore.loadDrive()
check('after restart: renamed with its subfolder, old trash restored into it, "Gone" empty',
  state.folders.get('Projects')?.files.map((f) => f.id).sort().join() === 'g1,g3' &&
  state.folders.get('Projects/2025')?.files[0]?.id === 'g2' &&
  !state.paths.includes('Work') && state.paths.includes('Gone') &&
  (state.folders.get('Gone')?.files.length ?? 0) === 0,
  `${state.paths.join(', ')} | Projects: ${state.folders.get('Projects')?.files.map((f) => f.name).join(', ')}`)
await refund(legacy, wallet.address)

// ── 10. Cost report ───────────────────────────────────────────────────
const balanceAfter = await provider.getBalance(wallet.address)
console.log(`\ndrive key:  ${masterKeyHex}`)
console.log(`cost:       ${ethers.formatEther(balanceBefore - balanceAfter)} 0G for ~25 metadata txs`)

if (failures > 0) {
  console.error(`\n${failures} CHECKS FAILED`)
  process.exit(1)
}
console.log('\nDRIVE TEST PASSED ✓')
