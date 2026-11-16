// Changes shown at once, stored in the background, with Undo — in the
// browser (headless Chromium + dev server), with an injected wallet backed
// by a FRESH key funded from .env's test wallet (the V2 drive's setup
// deposit and gas, 4 small uploads; files deleted and wallet refunded at
// the end). Checks: trash asks nothing and the row goes before the change is
// stored, a toast says so with Undo, the progress line shows while it's
// stored; Undo after it's stored restores it; Undo on a change still
// waiting drops it (never stored); rename and move show at once; a change
// that fails comes back, with an error toast in plain words (Details →
// Activity); what's stored on 0G matches each time; 390 px.
//
//   node scripts/test-instant-actions.mjs [http://localhost:5173]
import { chromium } from 'playwright'
import { answerAsks } from './lib/ask.mjs'
import { connectExtension } from './lib/connect.mjs'
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getNetworkConfig, RelayerClient, V2_TESTNET, deriveStorageKey, hexToBytes, DriveStore, V2Backend } from '../core/dist/index.js'
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

// the one prompt is New folder's
const dialogs = answerAsks(page, (q) => (q.prompt ? 'Docs' : true))
const NAMES = ['a.txt', 'b.txt', 'c.txt', 'd.txt']
const names = () => page.$$eval('table .fname-btn', (els) => els.map((e) => e.textContent.trim()).sort())
const row = (name) => page.locator('table tbody tr', { has: page.locator('.fname-btn', { hasText: name }) })
const toastText = () => page.locator('.toast .toast-text').textContent({ timeout: 2000 }).catch(() => null)
const working = () => page.evaluate(() => document.querySelector('.progress-line')?.classList.contains('on') ?? false)
/** until nothing is being stored (the queue empty and the drive loaded back) */
const settled = () => page.waitForFunction(() => !document.querySelector('.progress-line.on'), null, { timeout: 3 * 60_000, polling: 200 })
/** the drive as stored on 0G, read with its key: names in My drive, Docs and trash */
let mk = null
const stored = async () => {
  const d = await new DriveStore(new V2Backend(new RelayerClient(V2_TESTNET), deriveStorageKey(mk), mk)).loadDrive()
  const of = (f) => (f?.files ?? []).map((r) => r.name).sort()
  return { root: of(d.folders.get('')), docs: of(d.folders.get('Docs')), trash: of(d.trash) }
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
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 5 * 60_000 })
  masterKeyHex = await page.evaluate((a) => localStorage.getItem('0gdrive:masterkey:' + a.toLowerCase()), wallet.address)
  mk = hexToBytes(masterKeyHex)

  await page.setInputFiles('.dropzone input[type=file]', NAMES.map((name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(`${name}\n`) })))
  await page.waitForFunction((n) => n.every((x) => [...document.querySelectorAll('table .fname-btn')].some((b) => b.textContent.includes(x))), NAMES, { timeout: 8 * 60_000, polling: 1000 })
  await settled()
  step('4 files uploaded')

  // ── trash: no question, gone at once, toast with Undo, progress line while stored
  const asked = dialogs.length
  let t = Date.now()
  await row('a.txt').getByRole('button', { name: 'Move to trash' }).click()
  await page.waitForFunction(() => ![...document.querySelectorAll('table .fname-btn')].some((b) => b.textContent.includes('a.txt')), null, { timeout: 5000, polling: 50 })
  const goneMs = Date.now() - t
  await page.waitForTimeout(400)
  const during = { working: await working(), toast: await toastText(), undo: await page.locator('.toast').getByRole('button', { name: 'Undo' }).count() }
  check('trash asks nothing and the row goes at once (before it’s stored)', dialogs.length === asked && goneMs < 1000 && during.working, `${goneMs} ms, ${JSON.stringify(during)}`)
  check('a toast says “a.txt moved to trash” with Undo', during.toast === 'a.txt moved to trash' && during.undo === 1, JSON.stringify(during))
  t = Date.now()
  await settled()
  const s1 = await stored()
  check('…and it’s stored: in trash on 0G, the progress line gone', s1.trash.includes('a.txt') && !s1.root.includes('a.txt'), `${Date.now() - t} ms more, ${JSON.stringify(s1)}`)

  // ── Undo after it's stored: restored
  await row('b.txt').getByRole('button', { name: 'Move to trash' }).click()
  await settled()
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click()
  await row('b.txt').waitFor({ timeout: 2000 })
  check('Undo after the trash was stored: the row is back at once', true)
  await settled()
  const s2 = await stored()
  check('…and on 0G it’s back in My drive, not in trash', s2.root.includes('b.txt') && !s2.trash.includes('b.txt'), JSON.stringify(s2))

  // ── Undo while it waits behind another change: dropped, never stored
  await row('b.txt').getByRole('button', { name: 'Move to trash' }).click()
  await row('c.txt').getByRole('button', { name: 'Move to trash' }).click()
  const second = await toastText()
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click()
  await row('c.txt').waitFor({ timeout: 2000 })
  await settled()
  const s3 = await stored()
  const act = await page.$$eval('.activity li', (els) => els.map((e) => e.textContent))
  check('two trashes in a row; Undo on the one still waiting: never stored',
    second === 'c.txt moved to trash' && s3.trash.includes('b.txt') && s3.root.includes('c.txt') && !act.some((a) => a.includes('c.txt moved to trash')),
    JSON.stringify({ second, s3 }))

  // ── rename: the dialog closes and the name shows at once
  await row('c.txt').getByRole('button', { name: 'Rename' }).click()
  await page.locator('.rename-modal input').fill('e.txt')
  t = Date.now()
  await page.locator('.rename-modal').getByRole('button', { name: 'Rename' }).click()
  await row('e.txt').waitFor({ timeout: 2000 })
  const renameMs = Date.now() - t
  const renamedWhile = await working()
  check('rename: closed and shown at once, toast “Renamed to e.txt”', renameMs < 1000 && renamedWhile && (await page.locator('.rename-modal').count()) === 0 && (await toastText()) === 'Renamed to e.txt',
    `${renameMs} ms`)
  await settled()

  // ── move: shown at once, stored in Docs
  await page.getByRole('button', { name: '+ New folder' }).click()
  await page.locator('.sidebar .tree-name', { hasText: /^Docs$/ }).waitFor({ timeout: 3 * 60_000 })
  await settled()
  await row('e.txt').getByRole('button', { name: 'Move to…' }).click()
  await page.locator('.move-modal').getByRole('option', { name: /^Docs/ }).click()
  t = Date.now()
  await page.locator('.move-modal').getByRole('button', { name: 'Move here' }).click()
  await page.waitForFunction(() => ![...document.querySelectorAll('table .fname-btn')].some((b) => b.textContent.includes('e.txt')), null, { timeout: 5000, polling: 50 })
  const moveMs = Date.now() - t
  check('move: the row leaves at once, toast “Moved e.txt to Docs”', moveMs < 1000 && (await toastText()) === 'Moved e.txt to Docs', `${moveMs} ms`)
  await settled()
  const s4 = await stored()
  check('…and on 0G it’s in Docs', s4.docs.includes('e.txt') && !s4.root.includes('e.txt'), JSON.stringify(s4))

  // ── a change that fails: it comes back, with an error toast
  await page.route('**/v1/uploads', (r) => (r.request().method() === 'POST' ? r.abort() : r.continue()))
  await row('d.txt').getByRole('button', { name: 'Move to trash' }).click()
  await page.locator('.toast.error').waitFor({ timeout: 2 * 60_000 })
  await row('d.txt').waitFor({ timeout: 5000 })
  const err = { text: await toastText(), details: await page.locator('.toast.error').getByRole('button', { name: 'Details' }).count() }
  check('a trash that fails: the row comes back, the toast says so in plain words with Details',
    err.text === 'Couldn’t move d.txt to trash. Please try again.' && err.details === 1, JSON.stringify(err))
  await page.unroute('**/v1/uploads')
  await page.locator('.toast.error').getByRole('button', { name: 'Details' }).click()
  await page.waitForTimeout(800)
  const details = await page.evaluate(() => {
    const r = document.querySelector('.activity').getBoundingClientRect()
    return { top: Math.round(r.top), inView: r.top < window.innerHeight && r.bottom > 0, says: document.querySelector('.activity li')?.textContent ?? '' }
  })
  check('Details shows Activity, with what went wrong', details.inView && details.says.includes('Couldn’t move d.txt to trash:'), JSON.stringify(details))
  await settled()
  const s5 = await stored()
  check('…and on 0G nothing changed', s5.root.includes('d.txt') && !s5.trash.includes('d.txt'), JSON.stringify(s5))

  // ── 390 px: the toast fits with 16 px gutters, above the assistant button
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => window.scrollTo(0, 0))
  await row('d.txt').getByRole('button', { name: 'Move to trash' }).click()
  await page.locator('.toast').waitFor()
  await page.waitForTimeout(300)
  const phone = await page.evaluate(() => {
    const r = document.querySelector('.toast').getBoundingClientRect()
    const fab = document.querySelector('.assist-fab')?.getBoundingClientRect()
    const btns = [...document.querySelectorAll('.toast button')].map((b) => Math.round(b.getBoundingClientRect().height))
    return {
      left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom),
      fabTop: fab ? Math.round(fab.top) : null, btns, scroll: document.documentElement.scrollWidth - window.innerWidth,
    }
  })
  check('390 px: the toast fits (16 px gutters), above the assistant button, ≥44 px buttons, no sideways scroll',
    phone.left === 16 && phone.right === 374 && (phone.fabTop === null || phone.bottom <= phone.fabTop) && phone.btns.every((h) => h >= 44) && phone.scroll <= 0,
    JSON.stringify(phone))
  await settled()
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
