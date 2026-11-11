// PDF preview on phones: pages drawn with pdf.js (a PDF in a frame shows
// only its first page there), in headless Chromium:
//   phone (390 px, touch, 3× screen): a 12-page PDF opens with page 1 drawn
//     sharp and fitted to the width, "Page 1 of 12", far pages not drawn;
//     scrolling to the end draws page 12 and releases page 1; no sideways
//     scroll; Download still gives the whole file; a broken PDF says so
//   desktop: the browser's own viewer (a frame), as before
// Makes a V2 drive on a FRESH key funded from .env's test wallet (the setup
// deposit and gas); the drive's files are deleted and the wallet refunded
// at the end. Usage: node scripts/test-pdf-preview.mjs [http://localhost:5173]
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

/** A valid PDF of `n` Letter pages, each with its number in large type. */
function makePdf(n) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  const kids = []
  for (let i = 1; i <= n; i++) {
    const stream = `BT /F1 96 Tf 200 400 Td (${i}) Tj ET BT /F1 14 Tf 72 720 Td (Quarterly report, page ${i} of ${n}) Tj ET`
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${objs.length} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`)
    kids.push(`${objs.length} 0 R`)
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`
  let out = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
const PAGES = 12
const report = makePdf(PAGES)
const broken = Buffer.from('%PDF-1.4\nthis is not really a PDF\n'.repeat(20))

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

const wallet = ethers.Wallet.createRandom().connect(provider)
await (await funder.sendTransaction({ to: wallet.address, value: ethers.parseEther('1') })).wait()
console.log(`${at()} fresh wallet ${wallet.address}`)

let masterKeyHex = null
try {
  // ---- phone
  const phone = await openPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }, wallet)
  const page = phone.page
  await page.goto(base)
  await connectExtension(page)
  // setup: 3 signatures and the storage deposit (one transaction)
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: /New folder/ }).first().waitFor({ timeout: 5 * 60_000 })
  masterKeyHex = await page.evaluate((a) => localStorage.getItem('0gdrive:masterkey:' + a.toLowerCase()), wallet.address)
  await page.setInputFiles('.dropzone input[type=file]', [
    { name: 'report.pdf', mimeType: 'application/pdf', buffer: report },
    { name: 'broken.pdf', mimeType: 'application/pdf', buffer: broken },
  ])
  const row = (name) => page.locator('.fname-btn', { hasText: name }).first()
  await row('broken.pdf').waitFor({ timeout: 10 * 60_000 })
  console.log(`${at()} uploaded report.pdf (${PAGES} pages) and broken.pdf`)

  await row('report.pdf').click()
  await page.locator('.pdf-page[data-page="1"][data-state="drawn"]').waitFor({ timeout: 5 * 60_000 })
  const first = await page.evaluate(() => {
    const c = document.querySelector('.pdf-page[data-page="1"] canvas')
    const r = c.getBoundingClientRect()
    return {
      frames: document.querySelectorAll('.preview-body iframe').length,
      cssW: Math.round(r.width),
      pxW: c.width,
      counter: document.querySelector('.pdf-counter')?.textContent,
      drawn: [...document.querySelectorAll('.pdf-page[data-state="drawn"]')].map((p) => Number(p.dataset.page)),
      pageScroll: document.scrollingElement.scrollWidth,
    }
  })
  check('phone: drawn by the app, not a frame; "Page 1 of 12"', first.frames === 0 && first.counter === `Page 1 of ${PAGES}`, JSON.stringify(first.counter))
  check('page 1 fits the width and is drawn for the 3× screen', first.cssW > 300 && first.cssW <= 390 && first.pxW >= first.cssW * 2.5, `${first.cssW} px wide, ${first.pxW} px canvas`)
  check('only pages near the view are drawn', first.drawn.length >= 1 && first.drawn.every((n) => n <= 4), `drawn: ${first.drawn.join(',')}`)
  check('no sideways scroll at 390 px', first.pageScroll <= 390, `${first.pageScroll} px`)

  await page.locator('.pdf-pages').evaluate((el) => el.scrollTo(0, el.scrollHeight))
  await page.locator(`.pdf-page[data-page="${PAGES}"][data-state="drawn"]`).waitFor({ timeout: 60_000 })
  await page.waitForTimeout(300)
  const last = await page.evaluate(() => ({
    counter: document.querySelector('.pdf-counter')?.textContent,
    page1: document.querySelector('.pdf-page[data-page="1"]').dataset.state,
    canvases: document.querySelectorAll('.pdf-page canvas').length,
  }))
  check('scrolling to the end draws the last page and releases page 1', last.page1 === 'empty' && last.canvases <= 5, `page 1 ${last.page1}, ${last.canvases} canvases`)
  check(`the counter follows: "Page ${PAGES} of ${PAGES}"`, last.counter === `Page ${PAGES} of ${PAGES}`, JSON.stringify(last.counter))

  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.preview-modal').getByRole('button', { name: 'Download' }).click()])
  const got = readFileSync(await download.path())
  check('Download still gives the whole file', got.equals(report), `${got.length} of ${report.length} bytes`)
  await page.getByRole('button', { name: 'Close preview' }).click()

  await row('broken.pdf').click()
  const note = page.locator('.preview-note', { hasText: 'Couldn’t show this PDF here' })
  await note.waitFor({ timeout: 5 * 60_000 }).catch(() => {})
  check('a broken PDF says so, with Download', (await note.count()) === 1 && (await page.locator('.preview-modal').getByRole('button', { name: 'Download' }).isEnabled()))
  await page.getByRole('button', { name: 'Close preview' }).click()
  check('no page errors on the phone', phone.errors.length === 0, phone.errors.join(' | '))
  const saved = await phone.context.storageState() // the drive key, so the desktop opens the same drive
  await phone.context.close()

  // ---- desktop: the browser's viewer
  const desk = await openPage({ viewport: { width: 1280, height: 900 }, storageState: saved }, wallet)
  await desk.page.goto(base)
  const file = desk.page.locator('.fname-btn', { hasText: 'report.pdf' }).first()
  const connect = desk.page.getByRole('button', { name: 'Connect wallet' })
  await Promise.race([file.waitFor({ timeout: 2 * 60_000 }), connect.waitFor({ timeout: 2 * 60_000 })])
  if (await connect.isVisible()) await connectExtension(desk.page)
  await file.click({ timeout: 2 * 60_000 }).catch(async () => {
    const buttons = await desk.page.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 15))
    throw new Error(`no report.pdf row; buttons: ${buttons.join(' | ')}`)
  })
  await desk.page.locator('.preview-body iframe.preview-pdf').waitFor({ timeout: 5 * 60_000 })
  check('desktop: the browser’s own viewer, as before', (await desk.page.locator('.pdf-viewer').count()) === 0)
  await desk.context.close()
} catch (e) {
  failed++
  console.log(`${at()} ERROR ${e.message.split('\n')[0]}`)
} finally {
  await browser.close()
  await deleteDriveFiles(masterKeyHex)
  await refund(wallet, funder.address)
}
console.log(failed ? `${failed} FAILED` : 'PDF PREVIEW TEST PASSED ✓')
process.exitCode = failed ? 1 : 0
