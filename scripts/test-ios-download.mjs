// Downloads in Chrome on iPhone go to the share sheet, not a download link
// (whose "Save…" bar, once shown, stops the upload panel's file picker from
// opening) — in the browser (headless Chromium + dev server) at 390 px with
// touch and Chrome on iPhone's user agent, with an injected wallet backed by
// a FRESH key funded from .env's test wallet (the V2 drive's setup deposit
// and gas, 2 small uploads; files deleted and wallet refunded at the end).
// The share sheet is a stand-in that keeps what it's given and can refuse
// as iOS does: past the tap that asked for it (NotAllowedError), or
// cancelled (AbortError). Checks: a row's Download shares the file, with no
// download link; refused past the tap, a toast "… is ready" with Save
// shares it on that tap; cancelled, nothing is saved and no toast; the
// preview's Download shares it; the upload panel's picker still opens; a
// share link's page: refused past the tap, a Save button shares it; in
// another browser the share link's Download is the usual download.
//
//   node scripts/test-ios-download.mjs [http://localhost:5173]
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

const CRIOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1'
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true }

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

/** Chrome on iPhone: its user agent, no save-file picker, and a stand-in share sheet. */
async function chromeIOS(context) {
  await context.addInitScript(() => {
    delete window.showSaveFilePicker
    window.showSaveFilePicker = undefined
    window.__shares = []
    window.__shareMode = 'ok' // ok | abort | refuse-first (then: only on a tap)
    const share = async (data) => {
      const tapped = navigator.userActivation.isActive
      const mode = window.__shareMode
      if (mode === 'refuse-first') {
        window.__shareMode = 'tap'
        throw new DOMException('past the tap', 'NotAllowedError')
      }
      if (mode === 'tap' && !tapped) throw new DOMException('past the tap', 'NotAllowedError')
      const f = data.files[0]
      window.__shares.push({ name: f.name, type: f.type, text: await f.text(), mode })
      if (mode === 'abort') throw new DOMException('cancelled', 'AbortError')
    }
    Object.defineProperty(Navigator.prototype, 'share', { value: share, configurable: true })
    Object.defineProperty(Navigator.prototype, 'canShare', { value: (d) => Array.isArray(d?.files), configurable: true })
  })
}

const errors = []
const context = await browser.newContext({ ...PHONE, userAgent: CRIOS })
await chromeIOS(context)
const page = await context.newPage()
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
let downloads = 0
page.on('download', () => downloads++)
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
page.on('dialog', (d) => d.accept())

const A = 'a.txt'
const B = 'b.bin'
const TEXT = { [A]: 'alpha, previewed\n', [B]: 'bravo bytes' }
const row = (name) => page.locator('table tbody tr', { hasText: name }).first()
const shares = () => page.evaluate(() => window.__shares)
const setMode = (m) => page.evaluate((m) => (window.__shareMode = m), m)
const toast = async () => ({
  text: await page.locator('.toast .toast-text').textContent({ timeout: 3000 }).catch(() => null),
  save: await page.locator('.toast').getByRole('button', { name: 'Save' }).count(),
})
const centre = async (sel) =>
  page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect()
    return [r.left + r.width / 2, r.top + r.height / 2]
  }, sel)
/** a row's Download, until its read is done (the progress line off) */
async function downloadRow(name) {
  await row(name).getByRole('button', { name: 'Download' }).tap()
  await page.waitForTimeout(300)
  await page.waitForFunction(() => !document.querySelector('.progress-line.on'), null, { timeout: 2 * 60_000, polling: 200 })
  await page.waitForTimeout(300)
}

let masterKeyHex = null
try {
  await page.goto(base)
  await page.evaluate(() => {
    localStorage.setItem('0gdrive:smart-search', 'off')
    localStorage.setItem('0gdrive:layout', 'list')
  })
  await page.reload()
  await connectExtension(page)
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: 'New folder', exact: true }).waitFor({ timeout: 5 * 60_000 })
  masterKeyHex = await page.evaluate((a) => localStorage.getItem('0gdrive:masterkey:' + a.toLowerCase()), wallet.address)
  await page.setInputFiles('.dropzone input[type=file]', [
    { name: A, mimeType: 'text/plain', buffer: Buffer.from(TEXT[A]) },
    { name: B, mimeType: 'application/octet-stream', buffer: Buffer.from(TEXT[B]) },
  ])
  await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length >= 2 && !document.querySelector('.progress-line.on'), null, { timeout: 5 * 60_000, polling: 1000 })
  step('2 files uploaded')

  // ── a row's Download: to the share sheet, no download link
  await downloadRow(B)
  let s = await shares()
  check('Download in Chrome on iPhone: the file goes to the share sheet, with no download link',
    s.length === 1 && s[0].name === B && s[0].text === TEXT[B] && downloads === 0, JSON.stringify({ s, downloads }))

  // ── refused past the tap: a toast with Save, whose tap shares it
  await setMode('refuse-first')
  await downloadRow(B)
  const ready = await toast()
  check('past the tap: no share yet, a toast “b.bin is ready” with Save', (await shares()).length === 1 && ready.text === `${B} is ready` && ready.save === 1, JSON.stringify(ready))
  await page.waitForTimeout(6500) // longer than a usual toast
  check('…which stays past the usual 6 s', (await toast()).save === 1)
  const phone = await page.evaluate(() => {
    const r = document.querySelector('.toast').getBoundingClientRect()
    const btns = [...document.querySelectorAll('.toast button')].map((b) => Math.round(b.getBoundingClientRect().height))
    return { left: Math.round(r.left), right: Math.round(r.right), btns, scroll: document.documentElement.scrollWidth - window.innerWidth }
  })
  check('390 px: the toast fits (16 px gutters), ≥44 px buttons, no sideways scroll',
    phone.left === 16 && phone.right === 374 && phone.btns.every((h) => h >= 44) && phone.scroll <= 0, JSON.stringify(phone))
  await page.locator('.toast').getByRole('button', { name: 'Save' }).tap()
  await page.waitForTimeout(500)
  s = await shares()
  check('…tapping Save shares the file (on that tap), and the toast goes',
    s.length === 2 && s[1].name === B && s[1].text === TEXT[B] && s[1].mode === 'tap' && (await page.locator('.toast').count()) === 0 && downloads === 0,
    JSON.stringify({ s: s.slice(1), downloads }))

  // ── cancelled: nothing saved, no toast
  await setMode('abort')
  await downloadRow(B)
  const act = await page.$$eval('.activity li', (els) => els.map((e) => e.textContent))
  check('share sheet cancelled: no download link, no toast, Activity says not saved',
    downloads === 0 && (await page.locator('.toast').count()) === 0 && act.some((a) => a.includes(`${B}: not saved.`)), JSON.stringify(act.slice(0, 3)))

  // ── the preview's Download (on its tap): straight to the share sheet
  await setMode('tap')
  await page.locator('.fname-btn', { hasText: A }).tap()
  const dl = page.locator('.modal').getByRole('button', { name: 'Download', exact: true })
  await page.waitForFunction(() => [...document.querySelectorAll('.modal button')].some((b) => b.textContent.trim() === 'Download' && !b.disabled), null, { timeout: 2 * 60_000 })
  await dl.tap()
  await page.waitForTimeout(500)
  s = await shares()
  check('the preview’s Download: the share sheet, on its tap', s.length === 4 && s[3].name === A && s[3].text === TEXT[A] && s[3].type.startsWith('text/plain') && downloads === 0, JSON.stringify({ last: s[3], downloads }))
  await page.keyboard.press('Escape')
  await page.locator('.modal-backdrop').waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined)

  // ── the upload panel still opens the picker
  const chooser = page.waitForEvent('filechooser', { timeout: 3000 }).then(() => true, () => false)
  await page.locator('.dropzone').scrollIntoViewIfNeeded()
  await page.touchscreen.tap(...(await centre('.dropzone')))
  check('after these downloads, tapping the upload panel opens the file picker', await chooser)

  // ── a share link's page
  await row(B).getByRole('button', { name: 'Share' }).tap()
  await page.getByRole('button', { name: 'Create link' }).tap()
  const link = await page.locator('.share-link-box input').inputValue({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Close' }).tap()

  const shared = await context.newPage()
  shared.on('pageerror', (e) => errors.push(`shared pageerror: ${e.message}`))
  let sharedDownloads = 0
  shared.on('download', () => sharedDownloads++)
  await shared.goto(link)
  await shared.evaluate(() => (window.__shareMode = 'refuse-first'))
  await shared.getByRole('button', { name: 'Download file' }).tap({ timeout: 30_000 })
  const saveBtn = shared.getByRole('button', { name: `Save ${B}` })
  const shown = await saveBtn.waitFor({ timeout: 2 * 60_000 }).then(() => true, () => false)
  const fit = await shared.evaluate(() => {
    const b = [...document.querySelectorAll('.share-card button')].pop().getBoundingClientRect()
    return { left: Math.round(b.left), right: Math.round(b.right), h: Math.round(b.height), scroll: document.documentElement.scrollWidth - window.innerWidth }
  })
  check('share link page, past the tap: a “Save b.bin” button, nothing saved yet; 390 px: it fits, no sideways scroll',
    shown && (await shared.evaluate(() => window.__shares.length)) === 0 && fit.left >= 16 && fit.right <= 374 && fit.scroll <= 0, JSON.stringify(fit))
  await saveBtn.tap()
  await shared.waitForTimeout(500)
  const ss = await shared.evaluate(() => window.__shares)
  check('…tapping it shares the file', ss.length === 1 && ss[0].name === B && ss[0].text === TEXT[B] && ss[0].mode === 'tap' && sharedDownloads === 0, JSON.stringify({ ss, sharedDownloads }))

  // ── another browser (a phone's, not Chrome on iPhone): the usual download
  const other = await browser.newContext(PHONE)
  const op = await other.newPage()
  op.on('pageerror', (e) => errors.push(`other pageerror: ${e.message}`))
  await op.goto(link)
  const got = op.waitForEvent('download', { timeout: 2 * 60_000 }).catch(() => null)
  await op.getByRole('button', { name: 'Download file' }).tap({ timeout: 30_000 })
  const d = await got
  const body = d ? readFileSync(await d.path(), 'utf8') : null
  check('in another browser the share link’s Download is the usual download', body === TEXT[B], JSON.stringify({ name: d?.suggestedFilename(), body }))
  await other.close()
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
