// Encrypted on-device file cache: upload a PNG to a FRESH funded wallet,
// preview it after a reload (downloads it from the V2 relayer), reload and
// preview again (must be 0 downloads of it), and check the saved copy is
// ciphertext, not PNG. The drive's files are deleted and the wallet
// refunded at the end.
//   node scripts/test-file-cache.mjs
import { chromium } from 'playwright'
import { connectExtension } from './lib/connect.mjs'
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getNetworkConfig, RelayerClient, V2_TESTNET, deriveStorageKey, hexToBytes } from '../core/dist/index.js'
import { refund } from './lib/refund.mjs'

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
page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Recipes' : undefined))
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


// downloads of the file itself from the relayer (GET /v1/files/<its data
// hash>); the drive's listings and root come from there too, but under
// other hashes
let fileHash = ''
page.on('requestfinished', (req) => {
  const u = new URL(req.url())
  if (u.origin === new URL(V2_TESTNET.relayer).origin && u.pathname.startsWith('/v1/files/')) {
    net.push({ at: Date.now() - t0, hash: u.pathname.split('/')[3], ms: Math.round(req.timing().responseEnd) })
  }
})
page.on('requestfailed', (req) => {
  net.push({ at: Date.now() - t0, url: req.url(), failed: req.failure()?.errorText })
})

/** Delete every file of the drive's storage account (rent stops), with its key from the page. */
async function deleteDriveFiles(pg = page, address = wallet.address) {
  const hex = await pg.evaluate((a) => localStorage.getItem('0gdrive:masterkey:' + a.toLowerCase()), address).catch(() => null)
  if (!hex) return
  const account = deriveStorageKey(hexToBytes(hex))
  const relayer = new RelayerClient(V2_TESTNET)
  const files = (await relayer.list(account.address, { limit: 100 }).catch(() => ({ files: [] }))).files
  for (const f of files) await relayer.delete(account, f.dataHash).catch(() => undefined)
  step(`deleted the drive's ${files.length} files`)
}


const segs = () => net.filter((r) => fileHash && r.hash === fileHash).length
/** Downloads of the file since the last reload (its thumbnail too), then the preview. */
async function openPreview(label) {
  const t = Date.now()
  await page.locator('table .fname-btn', { hasText: 'scan.png' }).click()
  await page.waitForFunction(() => document.querySelector('.preview-media')?.naturalWidth > 0, null, { timeout: 5 * 60_000 })
  const w = await page.$eval('.preview-media', (i) => i.naturalWidth)
  const r = { ms: Date.now() - t, segs: segs(), w }
  step(`${label}: preview ${w}px wide in ${r.ms}ms, ${r.segs} downloads of the file`)
  await page.keyboard.press('Escape')
  return r
}
async function reopen() {
  net.length = 0 // count from the reload: the thumbnail reads the file too
  await page.reload() // reconnects by itself
  await page.locator('table .fname-btn', { hasText: 'scan.png' }).waitFor({ timeout: 5 * 60_000 })
  await page.waitForTimeout(3000) // let thumbnails settle
}
try {
  await page.goto(base)
  await page.evaluate(() => localStorage.setItem('0gdrive:layout', 'list'))
  await connectExtension(page)
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 120_000 })
  const b64 = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 1200; c.height = 900
    const x = c.getContext('2d'); const d = x.createImageData(1200, 900)
    for (let k = 0; k < d.data.length; k++) d.data[k] = (k % 4 === 3) ? 255 : Math.random() * 255
    x.putImageData(d, 0, 0)
    const buf = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer())
    let s = ''; for (let k = 0; k < buf.length; k += 0x8000) s += String.fromCharCode(...buf.subarray(k, k + 0x8000))
    return btoa(s)
  })
  const png = Buffer.from(b64, 'base64')
  await page.setInputFiles('.dropzone input[type=file]', [{ name: 'scan.png', mimeType: 'image/png', buffer: png }])
  await page.locator('table .fname-btn', { hasText: 'scan.png' }).waitFor({ timeout: 10 * 60_000 })
  // the record's data hash, as the list shows it (title of the hash cell)
  fileHash = (await page.locator('table tr', { has: page.locator('.fname-btn', { hasText: 'scan.png' }) }).locator('span[title^="0x"]').first().getAttribute('title')).replace(/^0x/, '').toLowerCase()
  step(`uploaded scan.png (${(png.length / 1e6).toFixed(1)} MB), data hash ${fileHash.slice(0, 10)}…`)
  await reopen()
  const first = await openPreview('after reload 1')
  await reopen()
  const second = await openPreview('after reload 2 (saved copy)')
  const stored = await page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('0gdrive-files')
    req.onsuccess = () => {
      const all = req.result.transaction('files').objectStore('files').getAll()
      all.onsuccess = async () => resolve(await Promise.all(all.result.map(async (r) => ({
        size: r.size, head: [...new Uint8Array(await r.data.slice(0, 8).arrayBuffer())].map((b) => b.toString(16).padStart(2, '0')).join(''),
      }))))
    }
  }))
  const pngSig = '89504e470d0a1a0a'
  const encrypted = stored.length > 0 && stored.every((r) => r.head !== pngSig && r.head.startsWith('01'))
  step(`saved copies: ${JSON.stringify(stored)} (PNG signature would be ${pngSig})`)
  const ok = first.w === 1200 && second.w === 1200 && first.segs > 0 && second.segs === 0 && encrypted
  console.log(ok ? 'FILE CACHE TEST PASSED ✓' : 'FILE CACHE TEST FAILED')
  if (!ok) process.exitCode = 1
} catch (e) {
  console.log('ERROR', e.message)
  process.exitCode = 1
} finally {
  if (errors.length) console.log(errors)
  await deleteDriveFiles()
  await browser.close()
  await refund(wallet, funder.address)
}
