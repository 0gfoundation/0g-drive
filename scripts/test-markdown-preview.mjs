// Markdown preview: the text formatted, safely (web/src/MarkdownPreview.tsx),
// in headless Chromium. A .md file (uploaded with no type, as Windows
// browsers send it) with headings, lists, a checklist, a table, code, a
// quote, a link, Chinese text, an inline (data:) image, a remote image and
// raw HTML carrying a script and event handlers:
//   each element renders; the script and handlers never run (none are left
//   in the page); the remote image shows as its alt text and nothing
//   reaches the internet; the frame is sandboxed with an opaque origin and
//   the content policy first; the link doesn't navigate; Source shows the
//   original text; at 390 px the page fits, and the wide table and code
//   block scroll inside themselves.
// Makes a V2 drive on a FRESH key funded from .env's test wallet (the setup
// deposit and gas); the drive's files are deleted and the wallet refunded
// at the end. Usage: node scripts/test-markdown-preview.mjs [http://localhost:5173]
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
const md = `# Lisbon trip

Day one: **Alfama** and the *castle*. 第一天:阿尔法玛区。

## Packing

- passport
- charger
  - USB-C cable

1. Book the hotel
2. Buy tram tickets

- [x] flights booked
- [ ] museum tickets

| Day | Area | Budget (EUR) | Notes that make this table wider than a phone screen |
| --- | --- | --- | --- |
| 1 | Alfama | 120 | BOOKINGREFLIS2026ALFAMACASTLEFADOEVENING (no break points) |
| 2 | Belém | 90 | tower, monastery, a long walk along the river |

\`\`\`js
const itinerary = ['Alfama', 'Belém', 'Sintra', 'Cascais'].map((place, day) => \`Day \${day + 1}: \${place}\`).join(' → ')
\`\`\`

> Bring comfortable shoes, the hills are steep.

Run \`npm start\` first. [Hotel booking](https://tracker.invalid/link)

![inline pixel](${PIXEL})
![Hotel logo](https://tracker.invalid/logo.png)

<script>document.title = 'SCRIPT RAN'; document.body.append('SCRIPT RAN')</script>
<img src="x" alt="broken" onerror="document.body.append('HANDLER RAN')">
<p onclick="document.body.append('HANDLER RAN')" id="clicky">Raw HTML paragraph</p>
`

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
  await page.setInputFiles('.dropzone input[type=file]', [{ name: 'trip notes.md', mimeType: '', buffer: Buffer.from(md) }])
  const row = page.locator('.fname-btn', { hasText: 'trip notes.md' }).first()
  await row.waitFor({ timeout: 10 * 60_000 })
  console.log(`${at()} uploaded trip notes.md`)

  await row.click()
  const frameEl = page.locator('.preview-modal iframe.preview-md')
  await frameEl.waitFor({ timeout: 5 * 60_000 })
  const frame = await (await frameEl.elementHandle()).contentFrame()
  await frame.waitForSelector('h1')
  await page.waitForTimeout(1500) // anything it might load or run has had its chance
  const r = await frame.evaluate(() => {
    const q = (sel) => document.querySelector(sel)
    const all = (sel) => [...document.querySelectorAll(sel)]
    return {
      h1: q('h1')?.textContent,
      h2: q('h2')?.textContent,
      strong: q('strong')?.textContent,
      em: q('em')?.textContent,
      chinese: document.body.textContent.includes('第一天:阿尔法玛区。'),
      nested: q('ul li ul li')?.textContent,
      ol: all('ol li').map((li) => li.textContent),
      boxes: all('input[type=checkbox]').map((b) => b.checked),
      cells: all('table th').length + '/' + all('table td').length,
      code: q('pre code')?.textContent.includes("'Alfama', 'Belém'"),
      inlineCode: all('p code').some((c) => c.textContent === 'npm start'),
      quote: q('blockquote')?.textContent.trim(),
      link: (() => {
        const a = all('a').find((x) => x.textContent === 'Hotel booking')
        return a && { href: a.getAttribute('href'), title: a.getAttribute('title') }
      })(),
      inline: all('img').some((i) => i.src.startsWith('data:image/png') && i.complete && i.naturalWidth > 0),
      alts: all('.img-alt').map((s) => s.textContent),
      text: document.body.textContent,
      title: document.title,
      handlers: all('*').filter((el) => [...el.attributes].some((a) => /^on/i.test(a.name))).length,
      scripts: all('script').length,
      origin: location.origin,
      href: location.href,
      cspFirst: document.head.firstElementChild?.getAttribute('http-equiv') === 'Content-Security-Policy',
      bg: getComputedStyle(document.body).backgroundColor,
    }
  })
  const attrs = await frameEl.evaluate((f) => ({ sandbox: f.getAttribute('sandbox'), src: f.getAttribute('src') }))
  check(
    'headings, emphasis, nested and numbered lists, Chinese text render',
    r.h1 === 'Lisbon trip' && r.h2 === 'Packing' && r.strong === 'Alfama' && r.em === 'castle' && r.chinese &&
      r.nested === 'USB-C cable' && r.ol.join('|') === 'Book the hotel|Buy tram tickets',
    JSON.stringify({ h1: r.h1, h2: r.h2, nested: r.nested, ol: r.ol, chinese: r.chinese })
  )
  check(
    'checklist, table, code block, inline code and quote render',
    r.boxes.join() === 'true,false' && r.cells === '4/8' && r.code && r.inlineCode && r.quote === 'Bring comfortable shoes, the hills are steep.',
    JSON.stringify({ boxes: r.boxes, cells: r.cells, code: r.code, inlineCode: r.inlineCode, quote: r.quote })
  )
  check('the page uses the app’s dark background', r.bg === 'rgb(10, 10, 12)', r.bg)
  check('the inline image shows; the remote one shows as its alt text', r.inline && r.alts.includes('[image: Hotel logo]'), JSON.stringify({ inline: r.inline, alts: r.alts }))
  check(
    'raw HTML: the script and event handlers never run, and none are left in the page',
    !/SCRIPT RAN|HANDLER RAN/.test(r.text) && r.title !== 'SCRIPT RAN' && r.handlers === 0 && r.scripts === 0,
    JSON.stringify({ title: r.title, handlers: r.handlers, scripts: r.scripts })
  )
  check('the link keeps its address as a tooltip but can’t be followed', r.link && r.link.href === null && r.link.title === 'https://tracker.invalid/link', JSON.stringify(r.link))
  check('the content policy is the first thing in the page’s head (what Safari enforces)', r.cspFirst)
  check('the frame is sandboxed with no permissions and has an opaque origin', attrs.sandbox === '' && attrs.src === null && r.origin === 'null', JSON.stringify({ ...attrs, origin: r.origin }))
  await frame.click('text=Hotel booking').catch(() => {})
  await frame.click('#clicky').catch(() => {})
  await page.waitForTimeout(1500)
  const after = await frame.evaluate(() => ({ href: location.href, text: document.body.textContent })).catch(() => ({ href: 'gone', text: '' }))
  check(
    'clicking the link and the raw HTML does nothing; nothing reaches the internet',
    after.href === r.href && !/HANDLER RAN/.test(after.text) && leaked().length === 0,
    `${after.href}; ${attempts.length} attempts, leaked: ${leaked().join(', ') || 'none'}`
  )
  await page.locator('.preview-modal').getByRole('button', { name: 'Source' }).click()
  const src = await page.locator('.preview-modal .preview-text').textContent()
  check('Source shows the original text', src === md)
  await page.locator('.preview-modal').getByRole('button', { name: 'Rendered' }).click()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(500)
  const fit = await page.evaluate(() => {
    const f = document.querySelector('.preview-md').getBoundingClientRect()
    const t = document.querySelector('.md-preview .html-mode').getBoundingClientRect()
    return { frameRight: Math.round(f.right), frameW: Math.round(f.width), frameH: Math.round(f.height), toggleRight: Math.round(t.right), scroll: document.scrollingElement.scrollWidth }
  })
  const frame2 = await (await page.locator('.preview-modal iframe.preview-md').elementHandle()).contentFrame()
  const inner = await frame2.evaluate(() => {
    const wrap = document.querySelector('.table-wrap')
    const pre = document.querySelector('pre')
    return {
      pageScroll: document.scrollingElement.scrollWidth,
      width: document.documentElement.clientWidth,
      tableScrolls: wrap.scrollWidth > wrap.clientWidth && getComputedStyle(wrap).overflowX === 'auto',
      codeScrolls: pre.scrollWidth > pre.clientWidth && getComputedStyle(pre).overflowX === 'auto',
    }
  })
  check(
    'phone (390 px): the page and the Rendered/Source switch fit; the wide table and code block scroll inside themselves',
    fit.frameRight <= 390 && fit.frameW > 300 && fit.frameH > 300 && fit.toggleRight <= 390 && fit.scroll <= 390 &&
      inner.pageScroll <= inner.width && inner.tableScrolls && inner.codeScrolls,
    JSON.stringify({ ...fit, ...inner })
  )
  check('no page errors', s.errors.length === 0, s.errors.join(' | '))
} catch (e) {
  failed++
  console.log(`${at()} ERROR ${e.message.split('\n')[0]}`)
} finally {
  await browser.close()
  await deleteDriveFiles(masterKeyHex)
  await refund(wallet, funder.address)
}
console.log(failed ? `${failed} FAILED` : 'MARKDOWN PREVIEW TEST PASSED ✓')
process.exitCode = failed ? 1 : 0
