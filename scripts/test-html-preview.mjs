// HTML preview: the page shown, safely (web/src/HtmlPreview.tsx), in
// headless Chromium. An HTML file with a script, a remote image, a remote
// stylesheet, a form, a link, a refresh and an inline (data:) image:
//   the page renders (text, its own styles, the inline image); the script
//   never runs; nothing reaches the internet (the content policy blocks
//   the remote image and stylesheet in the browser); the frame has an
//   opaque origin (no access to the app); the link doesn't navigate;
//   Source shows the original text; it fits a 390 px phone.
// Makes a V2 drive on a FRESH key funded from .env's test wallet (the setup
// deposit and gas); the drive's files are deleted and the wallet refunded
// at the end. Usage: node scripts/test-html-preview.mjs [http://localhost:5173]
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
const funder = new ethers.Wallet(funderKey, provider)
const t0 = Date.now()
const at = () => `[${((Date.now() - t0) / 1000).toFixed(0)}s]`
let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${at()} ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch()

/** Stop paying for the test drive: delete every file of its storage account. */
async function deleteDriveFiles(masterKeyHex) {
  if (!masterKeyHex) return
  const account = deriveStorageKey(hexToBytes(masterKeyHex))
  const relayer = new RelayerClient(V2_TESTNET)
  const files = (await relayer.list(account.address, { limit: 100 }).catch(() => ({ files: [] }))).files
  for (const f of files) await relayer.delete(account, f.dataHash).catch(() => undefined)
  console.log(`${at()} deleted the drive's ${files.length} files`)
}

/** A context with `wallet` injected. */
async function openPage(contextOpts, wallet) {
  const context = await browser.newContext({ ...contextOpts, acceptDownloads: true })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
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
    if (window !== window.top) return // the wallet is the app's, not a previewed page's
    localStorage.setItem('0gdrive:layout', 'list')
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
  return { context, page, errors }
}

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const html = `<!doctype html>
<html><head>
<title>Trip plan</title>
<meta http-equiv="refresh" content="0; url=https://tracker.invalid/refresh">
<link rel="stylesheet" href="https://tracker.invalid/style.css">
<style>h1 { color: rgb(200, 30, 30); }</style>
<script>document.title = 'SCRIPT RAN'; document.body && document.body.append('SCRIPT RAN')</script>
</head><body>
<h1>Lisbon trip</h1>
<p>Day one: Alfama and the castle.</p>
<img id="inline" src="${PIXEL}" width="40" height="40">
<img id="remote" src="https://tracker.invalid/pixel.png">
<form action="https://tracker.invalid/collect"><input name="q" value="x"><button>Send</button></form>
<a id="link" href="https://tracker.invalid/link">Hotel booking</a>
<script>document.body.append('SCRIPT RAN')</script>
</body></html>`

const wallet = ethers.Wallet.createRandom().connect(provider)
await (await funder.sendTransaction({ to: wallet.address, value: ethers.parseEther('1') })).wait()
console.log(`${at()} fresh wallet ${wallet.address}`)

let masterKeyHex = null
try {
  const s = await openPage({ viewport: { width: 1280, height: 900 } }, wallet)
  const page = s.page
  // the page's attempts: the browser reports one blocked by the content
  // policy as a request that failed with "csp" — it never left the browser
  const attempts = []
  page.on('request', (r) => {
    if (r.url().includes('tracker.invalid')) attempts.push(r)
  })
  const blocked = new Set()
  page.on('requestfailed', (r) => {
    if (r.failure()?.errorText === 'csp') blocked.add(r)
  })
  const leaked = () => attempts.filter((r) => !blocked.has(r)).map((r) => r.url())
  await page.goto(base)
  await connectExtension(page)
  // setup: 3 signatures and the storage deposit (one transaction)
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: /New folder/ }).first().waitFor({ timeout: 5 * 60_000 })
  masterKeyHex = await page.evaluate((a) => localStorage.getItem('0gdrive:masterkey:' + a.toLowerCase()), wallet.address)
  await page.setInputFiles('.dropzone input[type=file]', [{ name: 'trip.html', mimeType: 'text/html', buffer: Buffer.from(html) }])
  const row = page.locator('.fname-btn', { hasText: 'trip.html' }).first()
  await row.waitFor({ timeout: 10 * 60_000 })
  console.log(`${at()} uploaded trip.html`)

  await row.click()
  const frameEl = page.locator('.preview-modal iframe.preview-html')
  await frameEl.waitFor({ timeout: 5 * 60_000 })
  const frame = await (await frameEl.elementHandle()).contentFrame()
  await frame.waitForSelector('h1')
  await page.waitForTimeout(1500) // anything it might load or run has had its chance
  const r = await frame.evaluate(() => ({
    h1: document.querySelector('h1')?.textContent,
    color: getComputedStyle(document.querySelector('h1')).color,
    inline: document.getElementById('inline')?.complete && document.getElementById('inline')?.naturalWidth > 0,
    text: document.body.textContent,
    title: document.title,
    origin: location.origin,
    href: location.href,
    // the policy inside the page is what Safari enforces (it has no iframe csp attribute)
    cspFirst: document.head.firstElementChild?.getAttribute('http-equiv') === 'Content-Security-Policy',
  }))
  const attrs = await frameEl.evaluate((f) => ({ sandbox: f.getAttribute('sandbox'), src: f.getAttribute('src') }))
  check('the page renders: text, its own style, its inline image', r.h1 === 'Lisbon trip' && r.color === 'rgb(200, 30, 30)' && r.inline, JSON.stringify({ h1: r.h1, color: r.color, inline: r.inline }))
  check('its scripts never run', !/SCRIPT RAN/.test(r.text) && r.title !== 'SCRIPT RAN', JSON.stringify(r.title))
  check(
    'nothing reaches the internet: the remote image and stylesheet are blocked in the browser',
    attempts.length >= 2 && leaked().length === 0,
    `${attempts.length} attempts, leaked: ${leaked().join(', ') || 'none'}`
  )
  check('the content policy is the first thing in the page’s head (what Safari enforces)', r.cspFirst)
  check('the frame is sandboxed with no permissions and has an opaque origin', attrs.sandbox === '' && attrs.src === null && r.origin === 'null', JSON.stringify({ ...attrs, origin: r.origin }))
  await frame.click('#link').catch(() => {})
  await frame.click('button').catch(() => {})
  await page.waitForTimeout(1500)
  const after = await frame.evaluate(() => location.href).catch(() => 'gone')
  check('the link and the form go nowhere', after === r.href && leaked().length === 0, `${after}; leaked: ${leaked().join(', ') || 'none'}`)
  await page.locator('.preview-modal').getByRole('button', { name: 'Source' }).click()
  const src = await page.locator('.preview-modal .preview-text').textContent()
  check('Source shows the original text', src === html)
  await page.locator('.preview-modal').getByRole('button', { name: 'Page' }).click()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(500)
  const fit = await page.evaluate(() => {
    const f = document.querySelector('.preview-html').getBoundingClientRect()
    const t = document.querySelector('.html-mode').getBoundingClientRect()
    return { frameRight: Math.round(f.right), frameW: Math.round(f.width), frameH: Math.round(f.height), toggleRight: Math.round(t.right), scroll: document.scrollingElement.scrollWidth }
  })
  check('phone (390 px): the page and the Page/Source switch fit', fit.frameRight <= 390 && fit.frameW > 300 && fit.frameH > 300 && fit.toggleRight <= 390 && fit.scroll <= 390, JSON.stringify(fit))
  check('no page errors', s.errors.length === 0, s.errors.join(' | '))
} catch (e) {
  failed++
  console.log(`${at()} ERROR ${e.message.split('\n')[0]}`)
} finally {
  await browser.close()
  await deleteDriveFiles(masterKeyHex)
  await refund(wallet, funder.address)
}
console.log(failed ? `${failed} FAILED` : 'HTML PREVIEW TEST PASSED ✓')
process.exitCode = failed ? 1 : 0
