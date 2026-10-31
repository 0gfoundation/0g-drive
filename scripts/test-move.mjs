// Moving folders and files with the "Move to…" picker, in the browser
// (headless Chromium + dev server), with an injected wallet backed by a
// FRESH key funded from .env's test wallet. Makes Docs, Docs/reports and
// Work/Reports (with a.txt, b.txt), plus A.TXT in My drive, then:
//   folder: the current place and the folder itself are greyed out; a
//     same-named folder (any case) in the destination is refused; a new
//     destination folder is made in the picker; ONE transaction; the open
//     folder follows
//   files: two selected files can't go where A.TXT is (any case); moved to
//     Docs in ONE transaction; a row's Move opens the picker for that file
//   phone width: the picker, file rows (5 actions) and tree rows fit
//   after a reload everything is where it was moved to, and opens
// On-device AI is switched off, so no model download.
//
//   node scripts/test-move.mjs [http://localhost:5173]
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

const wallet = ethers.Wallet.createRandom().connect(provider)
const funder = new ethers.Wallet(funderKey, provider)
await (await funder.sendTransaction({ to: wallet.address, value: ethers.parseEther('0.5') })).wait()
step(`fresh wallet ${wallet.address} funded`)

const browser = await chromium.launch()
const errors = []
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
let txs = 0
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
        txs++
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
  localStorage.setItem('0gdrive:smart-search', 'off')
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

const crumbs = () => page.$$eval('.breadcrumb .crumb', (els) => els.map((e) => e.textContent.trim()).join('/'))
const treeNames = () => page.$$eval('.sidebar .tree-name', (els) => els.map((e) => e.textContent.trim()))
const treeRow = (name) => page.locator('.sidebar .tree-row', { has: page.locator('.tree-name', { hasText: new RegExp(`^${name}$`) }) })
const names = () => page.$$eval('table .fname-btn', (els) => els.map((e) => e.textContent.trim()).sort())
const fileRow = (name) => page.locator('table tr', { has: page.locator('.fname-btn', { hasText: name }) })
const picker = page.locator('.move-modal')
const opt = (label) => picker.getByRole('option', { name: new RegExp(`^${label}\\s*(current|new)?$`) })
const moveHere = picker.getByRole('button', { name: 'Move here' })
const pickerError = () => picker.locator('.error-text').allTextContents().then((t) => t.join(' | '))
let promptAnswer = ''
page.on('dialog', (d) => d.accept(promptAnswer))
const newFolder = async (name) => {
  promptAnswer = name
  await page.getByRole('button', { name: '+ New folder' }).click()
  await treeRow(name).first().waitFor({ timeout: 5 * 60_000 })
}
const openFolder = async (name) => {
  await treeRow(name).first().locator('.tree-label').click()
}
const upload = async (files) => {
  await page.setInputFiles('.dropzone input[type=file]', files.map(([name, text]) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) })))
  for (const [name] of files) await fileRow(name).waitFor({ timeout: 8 * 60_000 })
}

try {
  await page.goto(base)
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 120_000 })
  await upload([['A.TXT', 'root file']])
  await newFolder('Docs')
  await newFolder('Work')
  await openFolder('Docs')
  await newFolder('reports')
  await openFolder('Work')
  await newFolder('Reports')
  await page.locator('.sidebar .tree-row', { has: page.locator('.tree-label[title="Work/Reports"]') }).locator('.tree-label').click()
  await upload([['a.txt', 'Alpha: moved by the picker.'], ['b.txt', 'Beta']])
  step(`set up; open: ${await crumbs()}`)

  // ── grid view: "Select all" above the tiles (all, partial, none)
  await page.getByRole('button', { name: 'Grid view' }).click()
  const selectAll = page.locator('.grid-select-all input')
  const gridSel = () => page.evaluate(() => ({
    all: document.querySelector('.grid-select-all input').checked,
    partial: document.querySelector('.grid-select-all input').indeterminate,
    tiles: [...document.querySelectorAll('.tile-check')].map((c) => c.checked),
    bar: document.querySelector('.sel-count')?.textContent ?? '',
  }))
  await page.getByText('Select all', { exact: true }).click()
  const allOn = await gridSel()
  await page.locator('.tile-check').first().click()
  const partial = await gridSel()
  await selectAll.click()
  const again = await gridSel()
  await selectAll.click()
  const none = await gridSel()
  check('grid: Select all selects every tile, shows a dash when partial, clears when all',
    allOn.all && allOn.tiles.every(Boolean) && allOn.bar === '2 selected' &&
    !partial.all && partial.partial && partial.bar === '1 selected' &&
    again.all && again.tiles.every(Boolean) &&
    !none.all && !none.partial && none.tiles.every((c) => !c) && none.bar === '',
    JSON.stringify({ allOn, partial, again, none }))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  const phoneSel = await page.evaluate(() => {
    const r = document.querySelector('.grid-select-all').getBoundingClientRect()
    const box = document.querySelector('.grid-select-all input').getBoundingClientRect()
    return { overflow: document.documentElement.scrollWidth - window.innerWidth, h: Math.round(r.height), right: Math.round(r.right), box: Math.round(box.width) }
  })
  check('phone: Select all ≥44 px tall, 20 px box, inside the screen',
    phoneSel.overflow <= 0 && phoneSel.h >= 44 && phoneSel.box >= 20 && phoneSel.right <= 390, JSON.stringify(phoneSel))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.getByRole('button', { name: 'List view' }).click()

  // ── folder: Work/Reports → Docs (clash) → new Docs/2026, one transaction
  const workReports = page.locator('.sidebar .tree-row', { has: page.locator('.tree-label[title="Work/Reports"]') })
  await workReports.getByRole('button', { name: 'Move folder' }).click()
  await picker.waitFor()
  const states = {}
  for (const label of ['My drive', 'Docs', 'Work', 'Reports']) states[label] = await opt(label).first().isDisabled()
  check('picker: the current place and the folder itself are greyed out',
    !states['My drive'] && !states.Docs && states.Work && states.Reports, JSON.stringify(states))
  await opt('Docs').click()
  const clash = { error: await pickerError(), disabled: await moveHere.isDisabled() }
  check('a folder of the same name (other case) in the destination is refused',
    clash.disabled && /already a folder named “reports” in “Docs”/.test(clash.error), JSON.stringify(clash))

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  const phonePicker = await page.evaluate(() => {
    const m = document.querySelector('.move-modal').getBoundingClientRect()
    const btns = [...document.querySelectorAll('.move-modal .modal-actions .btn')].map((b) => Math.round(b.getBoundingClientRect().height))
    const opts = [...document.querySelectorAll('.move-modal .move-opt')].map((b) => Math.round(b.getBoundingClientRect().height))
    return { overflow: document.documentElement.scrollWidth - window.innerWidth, left: Math.round(m.left), right: Math.round(m.right), bottom: Math.round(m.bottom), btns, opts }
  })
  check('phone: picker inside the screen, ≥44 px buttons, ≥36 px rows',
    phonePicker.overflow <= 0 && phonePicker.left >= 0 && phonePicker.right <= 390 && phonePicker.bottom <= 844 &&
    phonePicker.btns.every((h) => h >= 44) && phonePicker.opts.every((h) => h >= 36), JSON.stringify(phonePicker))
  await page.setViewportSize({ width: 1280, height: 900 })

  await picker.getByRole('button', { name: /New folder in “Docs”/ }).click()
  await picker.getByRole('textbox', { name: 'New folder name' }).fill('2026')
  await picker.getByRole('button', { name: 'Add' }).click()
  const pending = { selected: await opt('2026').first().getAttribute('aria-selected'), error: await pickerError() }
  check('"New folder in Docs" adds Docs/2026 and selects it', pending.selected === 'true' && pending.error === '', JSON.stringify(pending))
  let before = txs
  await moveHere.click()
  await page.locator('.activity li', { hasText: 'Moved folder Work/Reports → Docs/2026/Reports' }).waitFor({ timeout: 10 * 60_000 })
  await picker.waitFor({ state: 'detached' })
  await fileRow('a.txt').waitFor({ timeout: 2 * 60_000 })
  const afterFolder = { txs: txs - before, crumbs: await crumbs(), files: await names() }
  check('folder move with a new destination: one transaction; the open folder follows',
    afterFolder.txs === 1 && afterFolder.crumbs === 'My drive/Docs/2026/Reports' && afterFolder.files.join() === 'a.txt,b.txt',
    JSON.stringify(afterFolder))

  // ── files: both selected → My drive refused (A.TXT) → Docs, one transaction
  for (const n of ['a.txt', 'b.txt']) await fileRow(n).locator('.td-check input').check()
  await page.locator('.sel-bar').getByRole('button', { name: 'Move to…' }).click()
  await picker.waitFor()
  const title = await picker.locator('h2').textContent()
  await opt('My drive').click()
  const fileClash = { title, error: await pickerError(), disabled: await moveHere.isDisabled() }
  check('files: a name already in the destination (other case) is refused',
    fileClash.title === 'Move “2 files”' && fileClash.disabled && /already a file named “a\.txt” in My drive/.test(fileClash.error),
    JSON.stringify(fileClash))
  await opt('Docs').click()
  before = txs
  await moveHere.click()
  await page.locator('.activity li', { hasText: 'Moved 2 files to Docs' }).waitFor({ timeout: 10 * 60_000 })
  await picker.waitFor({ state: 'detached' })
  await page.waitForFunction(() => document.querySelectorAll('table .fname-btn').length === 0, null, { timeout: 2 * 60_000 })
  check('2 files moved in one transaction; the folder they left is empty', txs - before === 1, `${txs - before} tx`)

  // ── the row's Move button opens the picker for that file; phone row fits
  await openFolder('Docs')
  await fileRow('b.txt').waitFor({ timeout: 2 * 60_000 })
  await fileRow('b.txt').getByRole('button', { name: 'Move to…', exact: true }).click()
  await picker.waitFor()
  const rowTitle = await picker.locator('h2').textContent()
  const docsCurrent = await opt('Docs').first().isDisabled()
  await picker.getByRole('button', { name: 'Cancel' }).click()
  check('a file row’s Move opens the picker for that file (its folder greyed out)',
    rowTitle === 'Move “b.txt”' && docsCurrent, JSON.stringify({ rowTitle, docsCurrent }))

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  const phoneRows = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    actions: Math.max(...[...document.querySelectorAll('table .row-actions .btn')].map((b) => Math.round(b.getBoundingClientRect().right))),
  }))
  await page.getByRole('button', { name: 'Folders and settings' }).click()
  await page.waitForTimeout(400)
  const drawer = await page.evaluate(() => {
    const side = Math.round(document.querySelector('.sidebar').getBoundingClientRect().right)
    const rights = [...document.querySelectorAll('.sidebar .tree-row .tree-act')].map((b) => Math.round(b.getBoundingClientRect().right))
    return { side, n: rights.length, max: Math.max(...rights) }
  })
  check('phone: file rows with 5 actions and tree rows with 3 fit the screen',
    phoneRows.overflow <= 0 && phoneRows.actions <= 390 && drawer.max <= drawer.side && drawer.n % 3 === 0 && drawer.n > 0,
    JSON.stringify({ phoneRows, drawer }))
  await page.setViewportSize({ width: 1280, height: 900 })

  // ── after a reload everything is where it was moved to
  await page.reload()
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  await treeRow('Docs').waitFor({ timeout: 5 * 60_000 })
  await openFolder('Docs')
  await fileRow('a.txt').waitFor({ timeout: 5 * 60_000 })
  const tree = await page.$$eval('.sidebar .tree-label', (els) => els.map((e) => e.getAttribute('title')).sort())
  const docsFiles = await names()
  await fileRow('a.txt').locator('.fname-btn').click()
  await page.locator('.preview-text').waitFor({ timeout: 5 * 60_000 })
  const text = await page.textContent('.preview-text')
  await page.keyboard.press('Escape')
  check('after reload: Docs/2026/Reports kept, Work empty of it, files in Docs and they open',
    tree.includes('Docs/2026') && !tree.includes('Work/Reports') && docsFiles.join() === 'a.txt,b.txt' && text.startsWith('Alpha'),
    JSON.stringify({ tree, docsFiles }))
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
