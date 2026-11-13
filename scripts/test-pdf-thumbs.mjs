// PDF thumbnails, in the browser (headless Chromium + dev server), with an
// injected wallet backed by a FRESH key funded from .env's test wallet (the
// V2 drive's setup deposit and gas; files deleted and wallet refunded at the end).
//   old-scan.pdf — uploaded while pdf.js can't load (as before PDF thumbnails
//                  existed): no stored thumbnail, so one is drawn later
//   broken.pdf   — starts like a PDF but isn't one: keeps its icon
//   report.pdf   — a red band at the top of a white page, uploaded normally
// Checks: report.pdf's thumbnail is stored with it (its first page, portrait,
// on white); old-scan.pdf gets one drawn and saved on this device; grid tiles
// show a sharp first page from its top with a PDF badge; broken.pdf keeps
// its icon; sharp tiles come back from this device after a reload; phone width.
//
//   node scripts/test-pdf-thumbs.mjs [http://localhost:5173]
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

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${el()} ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}


const wallet = ethers.Wallet.createRandom().connect(provider)
const funder = new ethers.Wallet(funderKey, provider)
await (await funder.sendTransaction({ to: wallet.address, value: ethers.parseEther('1') })).wait()
step(`fresh wallet ${wallet.address} funded`)

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
const errors = []
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
await page.exposeFunction('__eth', async (method, params) => {
  try {
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return { ok: [wallet.address] }
      case 'eth_chainId':
        return { ok: network.chainIdHex.toLowerCase() }
      case 'net_version':
        return { ok: String(network.chainId) }
      case 'wallet_switchEthereumChain':
      case 'wallet_addEthereumChain':
        return { ok: null }
      case 'personal_sign': {
        const [data] = params
        return { ok: await wallet.signMessage(ethers.isHexString(data) ? ethers.getBytes(data) : data) }
      }
      case 'eth_sendTransaction': {
        const [tx] = params
        const sent = await wallet.sendTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value ? BigInt(tx.value) : 0n,
          gasLimit: tx.gas ? BigInt(tx.gas) : undefined,
        })
        return { ok: sent.hash }
      }
      default:
        return { ok: await provider.send(method, params ?? []) }
    }
  } catch (e) {
    return { err: e.shortMessage ?? e.message }
  }
})
await context.addInitScript(() => {
  window.ethereum = {
    async request({ method, params }) {
      const r = await window.__eth(method, params)
      if (r.err) throw Object.assign(new Error(r.err), { code: -32000 })
      return r.ok
    },
    on() {},
    removeListener() {},
  }
})

/** A one-page PDF (200×283 pt, white) with a coloured band across its top. */
function pdf(rgb) {
  const content = `${rgb} rg 0 203 200 80 re f`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 283] /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  let out = '%PDF-1.4\n'
  const offsets = objs.map((o, i) => {
    const at = out.length
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
    return at
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out)
}
// the colour expected at the top centre of each first page
const TOP = { 'report.pdf': 'red', 'old-scan.pdf': 'green' }

/** For each PDF row/tile: thumbnail kind, size, colours at the top centre and the bottom corner, badge. */
const thumbs = (selector) =>
  page.evaluate(async (selector) => {
    const out = {}
    for (const img of document.querySelectorAll(selector)) {
      const row = img.closest('tr, .tile')
      const name = ['report.pdf', 'old-scan.pdf', 'broken.pdf'].find((n) => row?.textContent.includes(n))
      if (!name) continue
      await img.decode().catch(() => {})
      const c = document.createElement('canvas')
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      const x = c.getContext('2d')
      x.drawImage(img, 0, 0)
      const name4 = ([r, g, b, a]) =>
        a < 128 ? 'clear' : r > 200 && g < 80 && b < 80 ? 'red' : g > 150 && r < 80 && b < 80 ? 'green' : r > 235 && g > 235 && b > 235 ? 'white' : `rgb(${r},${g},${b})`
      const top = name4(x.getImageData(c.width >> 1, 2, 1, 1).data)
      const corner = name4(x.getImageData(1, c.height - 2, 1, 1).data)
      const badge = row.querySelector('.tile-badge-pdf')
      out[name] = {
        kind: img.src.slice(0, 5),
        w: img.naturalWidth,
        h: img.naturalHeight,
        top,
        corner,
        position: getComputedStyle(img).objectPosition,
        badge: badge?.textContent ?? null,
      }
    }
    return out
  }, selector)
const icons = () =>
  page.evaluate(() => {
    const row = [...document.querySelectorAll('tr, .tile')].find((r) => r.textContent.includes('broken.pdf'))
    return { img: !!row?.querySelector('img'), icon: !!row?.querySelector('.ficon') }
  })
/** Kinds of the thumbnails saved on this device ("sharp", "small"). */
const savedKeys = (db = '0gdrive-thumbs', store = 'thumbs') =>
  page.evaluate(
    ([db, store]) =>
      new Promise((resolve) => {
        const req = indexedDB.open(db)
        req.onsuccess = () => {
          try {
            const all = req.result.transaction(store).objectStore(store).getAllKeys()
            all.onsuccess = () => resolve(all.result.map((k) => String(k).split(':')[0]))
            all.onerror = () => resolve([])
          } catch {
            resolve([])
          } finally {
            req.result.close()
          }
        }
        req.onerror = () => resolve([])
      }),
    [db, store]
  )
const listed = (names) =>
  page.waitForFunction(
    (names) => names.every((n) => [...document.querySelectorAll('table .fname-btn, table .fname-text')].some((b) => b.textContent.includes(n))),
    names,
    { timeout: 8 * 60_000, polling: 2000 }
  )

let masterKeyHex = null
try {
  await page.goto(base)
  await page.evaluate(() => {
    localStorage.setItem('0gdrive:layout', 'list')
    // no search indexing: only thumbnails read the PDFs (and no model download)
    localStorage.setItem('0gdrive:smart-search', 'off')
  })
  await page.reload()
  await connectExtension(page)
  // setup: 3 signatures and the storage deposit (one transaction)
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 5 * 60_000 })
  masterKeyHex = await page.evaluate((a) => localStorage.getItem('0gdrive:masterkey:' + a.toLowerCase()), wallet.address)

  // as before PDF thumbnails: pdf.js's worker can't load, so no thumbnail is stored
  await page.route('**/pdf.worker*', (r) => r.abort())
  await page.setInputFiles('.dropzone input[type=file]', [
    { name: 'old-scan.pdf', mimeType: '', buffer: pdf('0 0.8 0') },
    { name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nthis is not really a PDF\n') },
  ])
  await listed(['old-scan.pdf', 'broken.pdf'])
  step('old-scan.pdf and broken.pdf uploaded without pdf.js')
  let list = await thumbs('table img.fthumb')
  check('without pdf.js: no thumbnail stored, the upload still went through', !list['old-scan.pdf'], JSON.stringify(list))
  await page.unroute('**/pdf.worker*')
  await page.reload() // reconnects by itself; pdf.js loads afresh
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 3 * 60_000 })

  await page.setInputFiles('.dropzone input[type=file]', [{ name: 'report.pdf', mimeType: 'application/pdf', buffer: pdf('1 0 0') }])
  await listed(['report.pdf'])
  step('report.pdf uploaded')
  await page.waitForFunction(() => document.querySelectorAll('table img.fthumb').length >= 2, null, { timeout: 3 * 60_000 })
  list = await thumbs('table img.fthumb')
  const r = list['report.pdf']
  check('report.pdf: thumbnail stored with it, its first page, portrait 96 px', r?.kind === 'data:' && r.h === 96 && r.w < r.h && r.w >= 60, JSON.stringify(r))
  check('report.pdf: red band at the top, white page (not black)', r?.top === 'red' && r.corner === 'white', JSON.stringify(r))
  check('old-scan.pdf: a thumbnail drawn later from the file (its green band)', list['old-scan.pdf']?.top === 'green' && list['old-scan.pdf'].corner === 'white', JSON.stringify(list['old-scan.pdf']))
  check('list: page thumbnails shown from their top', Object.values(list).every((t) => t.position.startsWith('50% 0%')), JSON.stringify(list))
  check('broken.pdf: keeps its icon', JSON.stringify(await icons()) === '{"img":false,"icon":true}', JSON.stringify(await icons()))

  await page.getByTitle('Grid view').click()
  await page.waitForFunction(() => document.querySelectorAll('.grid img.tile-thumb[src^="blob:"]').length >= 2, null, { timeout: 3 * 60_000 })
  const grid = await thumbs('.grid img.tile-thumb')
  check(
    'grid: sharp first pages (≥ 480 px wide) with the right top colour',
    Object.keys(TOP).every((n) => grid[n]?.kind === 'blob:' && grid[n].w >= 480 && grid[n].top === TOP[n]),
    JSON.stringify(grid)
  )
  check('grid: shown from the top with a PDF badge', Object.keys(TOP).every((n) => grid[n]?.position.startsWith('50% 0%') && grid[n].badge === 'PDF'), JSON.stringify(grid))
  check('grid: broken.pdf keeps its icon', JSON.stringify(await icons()) === '{"img":false,"icon":true}')
  const keys = await savedKeys()
  check('saved on this device: 2 sharp pages and old-scan.pdf’s small one', keys.filter((k) => k === 'sharp').length === 2 && keys.filter((k) => k === 'small').length === 1, JSON.stringify(keys))

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(400)
  const phone = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    badges: [...document.querySelectorAll('.grid .tile-badge-pdf')].map((b) => {
      const r = b.getBoundingClientRect()
      const t = b.closest('.tile-media').getBoundingClientRect()
      return r.left >= t.left && r.right <= t.right && r.bottom <= t.bottom && r.right <= 390
    }),
  }))
  check('phone: no overflow, PDF badges inside their tiles', phone.overflow <= 0 && phone.badges.length === 2 && phone.badges.every(Boolean), JSON.stringify(phone))
  await page.setViewportSize({ width: 1280, height: 900 })

  // after a reload the sharp pages come from this device's thumbnails: with
  // the file cache emptied, no PDF is downloaded (it would be cached again)
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('0gdrive-files')
        req.onsuccess = () => {
          const tx = req.result.transaction('files', 'readwrite')
          tx.objectStore('files').clear()
          tx.oncomplete = tx.onerror = () => (req.result.close(), resolve())
        }
        req.onerror = () => resolve()
      })
  )
  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('.grid img.tile-thumb[src^="blob:"]').length >= 2, null, { timeout: 3 * 60_000 })
  await page.waitForTimeout(3000)
  // broken.pdf is tried again each session (a failed thumbnail isn't remembered,
  // as for images); it's the one file under 200 bytes
  const sizes = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('0gdrive-files')
        req.onsuccess = () => {
          const all = req.result.transaction('files').objectStore('files').getAll()
          all.onsuccess = () => (req.result.close(), resolve(all.result.map((r) => r.size)))
        }
        req.onerror = () => resolve(null)
      })
  )
  check('after reload: sharp pages back from this device, neither PDF downloaded', Array.isArray(sizes) && sizes.every((n) => n < 200), `downloaded sizes ${JSON.stringify(sizes)}`)
} catch (e) {
  check('run completed', false, e.message.split('\n').slice(0, 6).join(' | '))
} finally {
  await browser.close()
  await deleteDriveFiles(masterKeyHex)
}

if (errors.length) console.log(errors.join('\n'))
const passed = results.filter((r) => r.ok).length
console.log(`${passed}/${results.length} checks passed`)
await refund(wallet, funder.address)
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
