// A listing that never got its data, seen from a device that can't finish
// it (Node, Galileo testnet, a FRESH funded wallet). Creates folder "Kept",
// then creates "Lost" in a child process that exits as soon as the
// transaction is mined, before any data is sent. A store with a fresh
// device memory then loads the drive, first within the abandon threshold
// (shortened to 1 minute here; 30 in the app), then after it:
//   within it: "Lost" is undone, but its listing isn't abandoned yet
//   after it: the listing is marked abandoned and the user is told
//   a later load doesn't try that listing again
//
//   node scripts/test-abandoned-listing.mjs
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DriveStore, bytesToHex, hexToBytes, getNetworkConfig } from '../core/dist/index.js'
import { refund } from './lib/refund.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const network = getNetworkConfig('testnet', 'turbo')
const provider = new ethers.JsonRpcProvider(network.rpcUrl)
const store = (key, signer, startBlock, opts = {}) => {
  let cache = { events: [], toBlock: startBlock }
  return new DriveStore(network, signer, key, {
    finalityRequired: false,
    eventCache: { load: () => cache, save: (events, toBlock) => (cache = { events, toBlock }) },
    ...opts,
  })
}

if (process.argv[2] === 'child') {
  // create "Lost", then die once its transaction is mined
  const [, , , pk, keyHex, startBlock] = process.argv
  const wallet = new ethers.Wallet(pk, provider)
  const s = store(hexToBytes(keyHex), wallet, Number(startBlock), {
    onProgress: async (msg) => {
      const m = /^Transaction submitted: (0x[0-9a-f]+)/i.exec(msg)
      if (!m) return
      await provider.waitForTransaction(m[1])
      console.log(`mined ${m[1]}`)
      process.exit(0)
    },
  })
  await s.loadDrive()
  await s.createFolder('Lost')
  console.log('child: upload finished before exit (unexpected)')
  process.exit(2)
}

const t0 = Date.now()
const el = () => `[${((Date.now() - t0) / 1000).toFixed(0)}s]`
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${el()} ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const funderKey = /^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(readFileSync(resolve(root, '.env'), 'utf8'))[1]
const funder = new ethers.Wallet(funderKey, provider)
const wallet = ethers.Wallet.createRandom().connect(provider)
await (await funder.sendTransaction({ to: wallet.address, value: ethers.parseEther('0.2') })).wait()
const masterKey = crypto.getRandomValues(new Uint8Array(32))
const startBlock = (await provider.getBlockNumber()) - 5
const ABANDON_MS = 60_000 // the app uses 30 minutes

try {
  const s1 = store(masterKey, wallet, startBlock)
  await s1.loadDrive()
  await s1.createFolder('Kept')
  console.log(`${el()} created "Kept"`)

  const out = await new Promise((res) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'child', wallet.privateKey, bytesToHex(masterKey), String(startBlock)])
    let text = ''
    child.stdout.on('data', (d) => (text += d))
    child.stderr.on('data', (d) => (text += d))
    child.on('exit', (code) => res({ code, text }))
  })
  const minedHash = /mined (0x[0-9a-f]+)/i.exec(out.text)?.[1]
  check('"Lost": transaction mined, then the page is gone before any data', out.code === 0 && !!minedHash, out.text.trim().slice(0, 200))
  const block = await provider.getBlock((await provider.getTransactionReceipt(minedHash)).blockNumber)

  const abandoned = new Set()
  const marked = []
  const messages = []
  const device = {
    savePending: async () => {},
    pending: async () => [],
    removePending: async () => {},
    isAbandoned: (r) => abandoned.has(r.toLowerCase()),
    markAbandoned: (r) => {
      marked.push(r)
      abandoned.add(r.toLowerCase())
    },
  }
  const opts = {
    device,
    abandonedAfterMs: ABANDON_MS,
    onProgress: (m) => m.startsWith('Interrupted change') && messages.push(m),
  }
  const d1 = await store(masterKey, wallet, startBlock, opts).loadDrive()
  check(
    'another device, soon after: "Lost" is undone, "Kept" stays, not abandoned yet',
    d1.paths.includes('Kept') && !d1.paths.includes('Lost') && marked.length === 0 && messages.length === 0,
    `${JSON.stringify(d1.paths)}; ${marked.length} marked`
  )

  const waitMs = block.timestamp * 1000 + ABANDON_MS + 5_000 - Date.now()
  console.log(`${el()} waiting ${(waitMs / 1000).toFixed(0)} s for it to pass the threshold`)
  await new Promise((r) => setTimeout(r, Math.max(0, waitMs)))
  let t = Date.now()
  const d2 = await store(masterKey, wallet, startBlock, opts).loadDrive()
  const load2 = (Date.now() - t) / 1000
  check('another device, later: "Lost" still undone, "Kept" stays', d2.paths.includes('Kept') && !d2.paths.includes('Lost'), JSON.stringify(d2.paths))
  check('its listing is marked abandoned, and the user is told', marked.length === 1 && messages.length === 1, `${marked.length} marked; ${messages[0]}`)

  messages.length = 0
  t = Date.now()
  const d3 = await store(masterKey, wallet, startBlock, opts).loadDrive()
  const load3 = (Date.now() - t) / 1000
  check(
    'a later load skips it: same drive, no second message',
    JSON.stringify(d3.paths) === JSON.stringify(d2.paths) && messages.length === 0 && marked.length === 1,
    `loads ${load2.toFixed(1)} s → ${load3.toFixed(1)} s`
  )
} catch (err) {
  check('run completed', false, err.message.split('\n')[0])
}

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} checks passed`)
await refund(wallet, funder.address)
process.exit(passed === results.length ? 0 : 1)
