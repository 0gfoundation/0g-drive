// SVG thumbnails, in the browser (headless Chromium + dev server), with an
// injected wallet backed by a FRESH key funded from .env's test wallet.
// Uploads three SVGs in one drop:
//   icon.svg  — states a 24×24 size (drawn at full thumbnail size anyway)
//   logo.svg  — viewBox only, no width/height
//   evil.svg  — a <script>, an onload handler and an external <image>
// and checks: list rows show a thumbnail of the right colour; the grid's
// sharp tiles too (transparent background kept); evil.svg's script never
// runs and its external image is never fetched; thumbnails survive a
// reload; phone width.
//
//   node scripts/test-svg-thumbs.mjs [http://localhost:5173]
import { chromium } from 'playwright'
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getNetworkConfig } from '../core/dist/index.js'
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

const EXTERNAL = 'https://example.com/svg-thumb-probe.png'
const SVGS = {
  'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="11" fill="#ff0000"/></svg>',
  'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect x="0" y="0" width="200" height="100" fill="#0000ff"/></svg>',
  'evil.svg':
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100" onload="window.top.__svgPwned=1">' +
    '<script>window.top.__svgPwned=1</script>' +
    `<image href="${EXTERNAL}" xlink:href="${EXTERNAL}" width="100" height="100"/>` +
    '<rect x="25" y="25" width="50" height="50" fill="#00ff00"/></svg>',
}
// colour expected at the centre of each thumbnail
const CENTRE = { 'icon.svg': 'red', 'logo.svg': 'blue', 'evil.svg': 'green' }

const wallet = ethers.Wallet.createRandom().connect(provider)
const funder = new ethers.Wallet(funderKey, provider)
await (await funder.sendTransaction({ to: wallet.address, value: ethers.parseEther('0.5') })).wait()
step(`fresh wallet ${wallet.address} funded`)

const browser = await chromium.launch()
const errors = []
const external = []
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('request', (r) => r.url().startsWith('https://example.com') && external.push(r.url()))
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

/** For each SVG row/tile: thumbnail kind, natural size, and the colour at its centre. */
const thumbs = (selector) =>
  page.evaluate(async (selector) => {
    const out = {}
    for (const img of document.querySelectorAll(selector)) {
      const row = img.closest('tr, .tile')
      const name = ['icon.svg', 'logo.svg', 'evil.svg'].find((n) => row?.textContent.includes(n))
      if (!name) continue
      await img.decode().catch(() => {})
      const c = document.createElement('canvas')
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      const x = c.getContext('2d')
      x.drawImage(img, 0, 0)
      const [r, g, b, a] = x.getImageData(c.width >> 1, c.height >> 1, 1, 1).data
      const corner = x.getImageData(0, 0, 1, 1).data[3]
      const colour = a < 128 ? 'clear' : r > 200 && g < 80 && b < 80 ? 'red' : b > 200 && r < 80 && g < 80 ? 'blue' : g > 200 && r < 80 && b < 80 ? 'green' : `rgb(${r},${g},${b})`
      out[name] = { kind: img.src.slice(0, 5), w: img.naturalWidth, h: img.naturalHeight, colour, cornerAlpha: corner }
    }
    return out
  }, selector)
const allCentred = (t) => Object.keys(CENTRE).every((n) => t[n]?.colour === CENTRE[n])

try {
  await page.goto(base)
  await page.evaluate(() => localStorage.setItem('0gdrive:layout', 'list'))
  await page.reload()
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 120_000 })
  await page.setInputFiles(
    '.dropzone input[type=file]',
    Object.entries(SVGS).map(([name, s]) => ({ name, mimeType: 'image/svg+xml', buffer: Buffer.from(s) }))
  )
  await page.waitForFunction(
    () => ['icon.svg', 'logo.svg', 'evil.svg'].every((n) => [...document.querySelectorAll('table .fname-btn')].some((b) => b.textContent.includes(n))),
    null,
    { timeout: 8 * 60_000, polling: 2000 }
  )
  step('3 SVGs uploaded')

  let list = await thumbs('table img.fthumb')
  check('list: every SVG has a thumbnail of the right colour', allCentred(list), JSON.stringify(list))
  check('list: a 24×24 icon is drawn at full thumbnail size (96 px)', list['icon.svg']?.w === 96 && list['icon.svg']?.h === 96, JSON.stringify(list['icon.svg']))
  check('list: viewBox-only SVG keeps its 2:1 shape', list['logo.svg']?.w === 96 && list['logo.svg']?.h === 48, JSON.stringify(list['logo.svg']))

  await page.getByTitle('Grid view').click()
  await page.waitForFunction(() => document.querySelectorAll('.grid img.tile-thumb[src^="blob:"]').length >= 3, null, { timeout: 3 * 60_000 })
  const grid = await thumbs('.grid img.tile-thumb')
  check('grid: sharp tiles drawn from the files, right colours', allCentred(grid) && Object.values(grid).every((t) => t.kind === 'blob:' && Math.min(t.w, t.h) >= 480), JSON.stringify(grid))
  check('grid: transparent background kept (no black box)', grid['icon.svg']?.cornerAlpha === 0, JSON.stringify(grid['icon.svg']))

  check('evil.svg: its script and onload never ran', (await page.evaluate(() => window.__svgPwned)) === undefined)
  check('evil.svg: its external image was never fetched', external.length === 0, JSON.stringify(external))

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(400)
  const phone = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    tiles: [...document.querySelectorAll('.grid img.tile-thumb')].map((i) => Math.round(i.getBoundingClientRect().right)),
  }))
  check('phone: SVG tiles inside the screen, no overflow', phone.overflow <= 0 && phone.tiles.length >= 3 && phone.tiles.every((r) => r <= 390), JSON.stringify(phone))
  await page.setViewportSize({ width: 1280, height: 900 })

  await page.evaluate(() => localStorage.setItem('0gdrive:layout', 'list'))
  await page.reload() // reconnects by itself
  await page.locator('table img.fthumb').nth(2).waitFor({ timeout: 3 * 60_000 })
  list = await thumbs('table img.fthumb')
  check('after reload: thumbnails come back from the folder listing', allCentred(list) && Object.values(list).every((t) => t.kind === 'data:'), JSON.stringify(list))
} catch (e) {
  check('run completed', false, e.message.split('\n').slice(0, 6).join(' | '))
} finally {
  await browser.close()
}

if (errors.length) console.log(errors.join('\n'))
const passed = results.filter((r) => r.ok).length
console.log(`${passed}/${results.length} checks passed`)
await refund(wallet, funder.address)
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
