// Grid thumbnail timing: uploads N phone-sized photos (~5.5 MB each) to a
// V2 drive on a FRESH funded wallet, reloads, and reports how many grid
// tiles have their sharp preview; then reloads again and checks they come
// back from this device with no downloads (no photo fetched from the
// relayer). The drive's files are deleted and the wallet refunded at the
// end.   N=8 node scripts/test-grid-thumbs.mjs
import { chromium } from 'playwright'
import { answerAsks } from './lib/ask.mjs'
import { connectExtension } from './lib/connect.mjs'
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { refund } from './lib/refund.mjs'
import { getNetworkConfig, RelayerClient, V2_TESTNET, deriveStorageKey, hexToBytes } from '../core/dist/index.js'

const base = process.argv[2] ?? 'http://localhost:5173'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const funderKey = /^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(readFileSync(resolve(root, '.env'), 'utf8'))[1]
const network = getNetworkConfig('testnet', 'turbo')
const provider = new ethers.JsonRpcProvider(network.rpcUrl)
const t0 = Date.now()
const el = () => `[${((Date.now() - t0) / 1000).toFixed(0)}s]`
const step = (m) => console.log(`${el()} ${m}`)

// ── fresh funded wallet ──
const wallet = ethers.Wallet.createRandom().connect(provider)
const funder = new ethers.Wallet(funderKey, provider)
await (await funder.sendTransaction({ to: wallet.address, value: ethers.parseEther('2') })).wait()
step(`fresh wallet ${wallet.address} funded with 2 0G`)

// ── injected wallet ──
const prompts = { tx: 0, sign: 0 }
async function rpc(method, params) {
  switch (method) {
    case 'eth_requestAccounts':
    case 'eth_accounts':
      return [wallet.address]
    case 'eth_chainId':
      return network.chainIdHex.toLowerCase()
    case 'net_version':
      return String(network.chainId)
    case 'wallet_switchEthereumChain':
    case 'wallet_addEthereumChain':
      return null
    case 'personal_sign': {
      prompts.sign++
      const [data] = params
      return wallet.signMessage(ethers.isHexString(data) ? ethers.getBytes(data) : data)
    }
    case 'eth_sendTransaction': {
      prompts.tx++
      const [tx] = params
      const sent = await wallet.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value ? BigInt(tx.value) : 0n,
        gasLimit: tx.gas ? BigInt(tx.gas) : undefined,
      })
      return sent.hash
    }
    default:
      return provider.send(method, params ?? [])
  }
}

const browser = await chromium.launch()

/** Stop paying for the test drive: delete every file of its storage account. */
async function deleteDriveFiles(masterKeyHex) {
  if (!masterKeyHex) return
  const account = deriveStorageKey(hexToBytes(masterKeyHex))
  const relayer = new RelayerClient(V2_TESTNET)
  const files = (await relayer.list(account.address, { limit: 100 }).catch(() => ({ files: [] }))).files
  for (const f of files) await relayer.delete(account, f.dataHash).catch(() => undefined)
  console.log(`${el()} deleted the drive's ${files.length} files`)
}
const net = []
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
const consoleTail = []
page.on('console', (m) => {
  consoleTail.push(`${m.type()}: ${m.text().slice(0, 200)}`)
  if (consoleTail.length > 40) consoleTail.shift()
})
page.on('worker', (w) => w.on('console', (m) => {
  consoleTail.push(`worker ${m.type()}: ${m.text().slice(0, 200)}`)
  if (consoleTail.length > 40) consoleTail.shift()
}))
answerAsks(page, (q) => (q.title === 'New folder' ? 'Recipes' : true))
await page.exposeFunction('__eth', async (method, params) => {
  try {
    return { ok: await rpc(method, params) }
  } catch (e) {
    return { err: e.shortMessage ?? e.message }
  }
})
await page.addInitScript(() => {
  const listeners = {}
  window.ethereum = {
    isMetaMask: true,
    async request({ method, params }) {
      const r = await window.__eth(method, params)
      if (r.err) throw Object.assign(new Error(r.err), { code: -32000 })
      return r.ok
    },
    on(ev, fn) {
      ;(listeners[ev] ??= []).push(fn)
    },
    removeListener() {},
  }
})


// reads from the V2 relayer: a photo is a file of a megabyte or more (the
// drive's root and listings are small, and its 32-byte reads find the root)
page.on('requestfinished', async (req) => {
  if (!req.url().includes('/v1/files/')) return
  const bytes = (await req.sizes().catch(() => null))?.responseBodySize ?? 0
  net.push({ at: Date.now() - t0, m: 'file', bytes, ms: Math.round(req.timing().responseEnd) })
})
page.on('requestfailed', (req) => {
  if (req.url().includes('/v1/files/')) net.push({ at: Date.now() - t0, m: 'file', failed: req.failure()?.errorText })
})

async function photo(i) {
  // phone-sized noisy JPEG (~3-6 MB)
  const b64 = await page.evaluate(async (i) => {
    const c = document.createElement('canvas'); c.width = 4032; c.height = 3024
    const x = c.getContext('2d')
    const g = x.createLinearGradient(0, 0, 4032, 3024)
    g.addColorStop(0, `hsl(${i * 45},70%,50%)`); g.addColorStop(1, `hsl(${i * 45 + 120},70%,30%)`)
    x.fillStyle = g; x.fillRect(0, 0, 4032, 3024)
    const d = x.getImageData(0, 0, 4032, 3024)
    for (let k = 0; k < d.data.length; k += 4) { const n = (Math.random() - 0.5) * 60; d.data[k] += n; d.data[k + 1] += n; d.data[k + 2] += n }
    x.putImageData(d, 0, 0)
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9))
    const buf = new Uint8Array(await blob.arrayBuffer())
    let s = ''; for (let k = 0; k < buf.length; k += 0x8000) s += String.fromCharCode(...buf.subarray(k, k + 0x8000))
    return btoa(s)
  }, i)
  return { name: `IMG_${1000 + i}.jpg`, mimeType: 'image/jpeg', buffer: Buffer.from(b64, 'base64') }
}

const tiles = () => page.$$eval('.grid .tile', (els) => els.map((e) => {
  const img = e.querySelector('img')
  return { name: e.textContent.trim().slice(0, 14), src: img ? img.src.slice(0, 5) : 'none', nw: img?.naturalWidth ?? 0, pending: !!e.querySelector('.thumb-pending') }
}))

let masterKeyHex = null
try {
  await page.goto(base)
  await page.evaluate(() => localStorage.setItem('0gdrive:layout', 'grid'))
  await connectExtension(page)
  // setup: 3 signatures and the storage deposit (one transaction)
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 5 * 60_000 })
  masterKeyHex = await page.evaluate((a) => localStorage.getItem('0gdrive:masterkey:' + a.toLowerCase()), wallet.address)
  step('drive created')
  const N = Number(process.env.N ?? 8)
  const files = []
  for (let i = 0; i < N; i++) files.push(await photo(i))
  step(`photos: ${files.map((f) => (f.buffer.length / 1e6).toFixed(1) + 'MB').join(' ')}`)
  await page.setInputFiles('.dropzone input[type=file]', files)
  await page.waitForFunction((n) => [...document.querySelectorAll('.queue-item')].filter((r) => /in your drive|✗/.test(r.textContent)).length >= n, N, { timeout: 15 * 60_000, polling: 2000 })
  step('uploaded')
  await page.waitForTimeout(5000)
  step('before reload: ' + JSON.stringify(await tiles()))
  async function afterReload(label) {
    await page.reload() // reconnects by itself
    await page.waitForFunction((n) => document.querySelectorAll('.grid img, .grid .thumb-pending').length >= n, N, { timeout: 5 * 60_000 })
    const tl = Date.now()
    net.length = 0
    step(`${label}: drive loaded`)
    let sharp = 0
    for (let s = 0; s < 60; s++) {
      const t = await tiles()
      sharp = t.filter((x) => x.src === 'blob:').length
      console.log(`  +${((Date.now() - tl) / 1000).toFixed(1)}s sharp=${sharp}/${t.length} small=${t.filter((x) => x.src === 'data:').length} none=${t.filter((x) => x.src === 'none').length}`)
      if (sharp >= N) break
      await page.waitForTimeout(s < 10 ? 500 : 5000)
    }
    const segs = net.filter((r) => r.m === 'file' && r.bytes >= 1e6).length
    step(`${label}: ${sharp}/${N} sharp in ${((Date.now() - tl) / 1000).toFixed(1)}s, ${segs} photo downloads`)
    return { sharp, segs }
  }
  const first = await afterReload('reload 1 (downloads)')
  const second = await afterReload('reload 2 (saved on device)')
  const ok = first.sharp === N && second.sharp === N && second.segs === 0
  console.log(ok ? 'GRID THUMBS TEST PASSED ✓' : 'GRID THUMBS TEST FAILED')
  if (!ok) process.exitCode = 1
} catch (e) {
  console.log('ERROR', e.message)
  process.exitCode = 1
} finally {
  console.log(consoleTail.filter((l) => !/vite|React DevTools/.test(l)).slice(-15).join('\n'))
  if (errors.length) console.log(errors)
  await browser.close()
  await deleteDriveFiles(masterKeyHex)
  await refund(wallet, funder.address)
}
