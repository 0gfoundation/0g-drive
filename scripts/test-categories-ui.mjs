// Categories in the browser (D35): headless Chromium + the dev server (or a
// deployment), smart search on, with an injected wallet backed by a FRESH
// key funded from .env's test wallet (the drive's setup deposit and gas, 6
// small uploads; files deleted and wallet refunded at the end). Checks:
// the Categories view groups the files by topic (found by the on-device
// model) and by type; a chip lists its files with their folder; files
// selected in a folder go into a new category of the user's (Add to
// category), shown at once and stored in the drive; a file taken out of a
// category, a category renamed and deleted, all with no wallet prompt; a
// second device (a 390 px phone with touch) sees the user's category, with
// chips that fit and scroll sideways; a folder's "Group by category" puts
// its files in sections (list and grid), each file once, kept after a
// reload.
//
//   node scripts/test-categories-ui.mjs [http://localhost:5173]
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
const prompts = { tx: 0, sign: 0 }

async function deleteDriveFiles(masterKeyHex) {
  if (!masterKeyHex) return
  const account = deriveStorageKey(hexToBytes(masterKeyHex))
  const relayer = new RelayerClient(V2_TESTNET)
  const files = (await relayer.list(account.address, { limit: 100 }).catch(() => ({ files: [] }))).files
  for (const f of files) await relayer.delete(account, f.dataHash).catch(() => undefined)
  console.log(`${el()} deleted the drive's ${files.length} files`)
}

/** A browser context with the test wallet injected. */
async function walletContext(opts) {
  const context = await browser.newContext(opts)
  await context.exposeFunction('__eth', async (method, params) => {
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
          prompts.sign++
          const [data] = params
          return { ok: await wallet.signMessage(ethers.isHexString(data) ? ethers.getBytes(data) : data) }
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
    if (localStorage.getItem('0gdrive:layout') === null) localStorage.setItem('0gdrive:layout', 'list')
  })
  return context
}

const errors = []
const context = await walletContext({ viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
let nextAnswer = true
answerAsks(page, () => nextAnswer)

const FILES = {
  'invoice-031.txt': 'Invoice no. 2025-031. Bill to: Acme Ltd. Web design services, 24 hours at 85 EUR. Subtotal 2,040.00, VAT 469.20, total due 2,509.20 within 30 days.',
  'lease.txt': 'Residential Lease Agreement between the Landlord and the Tenant for the apartment at 14 Rua Augusta. Monthly rent 1,450 EUR. Either party may end it with 60 days notice.',
  'carbonara.md': '# Spaghetti carbonara\n\nIngredients: 200g spaghetti, 100g guanciale, 2 eggs, pecorino romano, black pepper. Boil the pasta, fry the guanciale, mix eggs and cheese off the heat.',
  'trip-notes.txt': 'Itinerary: fly TAP to Lisbon on May 3. Hotel in Alfama for five nights. Day trip to Sintra and Cascais. Return flight May 8.',
  'consensus-whitepaper.txt': 'This whitepaper describes a Byzantine fault tolerant consensus protocol for a modular blockchain. We analyze safety and liveness and report throughput on a 100-node testnet.',
  'budget.xlsx': 'not really a spreadsheet',
}
const names = Object.keys(FILES)
const row = (p, name) => p.locator('table tbody tr', { hasText: name }).first()
const settled = (p) => p.waitForFunction(() => !document.querySelector('.progress-line.on'), null, { timeout: 3 * 60_000, polling: 200 })
const chips = (p, group) =>
  p.$$eval(`.categories .cat-group`, (gs, group) => {
    const g = gs.find((x) => x.querySelector('.cat-group-title')?.textContent === group)
    return g ? [...g.querySelectorAll('.chip:not(.chip-new)')].map((c) => `${c.querySelector('.chip-name').textContent} ${c.querySelector('.chip-count')?.textContent ?? ''}`.trim()) : []
  }, group)
const chip = (p, name) => p.locator('.categories .chip', { has: p.locator('.chip-name', { hasText: new RegExp(`^${name}$`) }) })
const listed = (p) => p.$$eval('.cat-files .result .fname-btn', (els) => els.map((e) => e.textContent.trim()).sort())
const toast = (p) => p.locator('.toast .toast-text').textContent({ timeout: 3000 }).catch(() => null)
let mk = null
let masterKeyHex = null
const stored = async () => (await new DriveStore(new V2Backend(new RelayerClient(V2_TESTNET), deriveStorageKey(mk), mk)).loadDrive()).categories

try {
  await page.goto(base)
  await connectExtension(page)
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: 'New folder', exact: true }).waitFor({ timeout: 5 * 60_000 })
  masterKeyHex = await page.evaluate((a) => localStorage.getItem('0gdrive:masterkey:' + a.toLowerCase()), wallet.address)
  mk = hexToBytes(masterKeyHex)
  await page.setInputFiles('.dropzone input[type=file]', names.map((name) => ({ name, mimeType: name.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/plain', buffer: Buffer.from(FILES[name]) })))
  await page.waitForFunction((n) => document.querySelectorAll('table tbody tr').length >= n, names.length, { timeout: 8 * 60_000, polling: 1000 })
  await settled(page)
  step('6 files uploaded')

  // ── the Categories view: topics (once the model has indexed them) and types
  await page.locator('.sidebar .nav-item', { hasText: 'Categories' }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('.categories .chip-name')].some((c) => c.textContent === 'Travel'), null, { timeout: 10 * 60_000, polling: 1000 })
  await page.waitForTimeout(3000) // the rest of the files indexed
  const topics = await chips(page, 'Topics')
  const types = await chips(page, 'Types')
  // budget.xlsx has no text read (not a real spreadsheet): its name puts it in Finance
  check('Categories: the files by topic — Finance (the invoice, budget.xlsx), Contracts & legal, Recipes, Travel, Research papers',
    ['Finance 2', 'Contracts & legal 1', 'Recipes 1', 'Travel 1', 'Research papers 1'].every((c) => topics.includes(c)), JSON.stringify(topics))
  check('…and by type: Documents 5, Spreadsheets 1', types.includes('Documents 5') && types.includes('Spreadsheets 1'), JSON.stringify(types))
  await chip(page, 'Finance').click()
  const fin = await listed(page)
  const folderLink = await page.locator('.cat-files .result-folder').first().textContent()
  check('a chip lists its files, with the folder each is in', JSON.stringify(fin) === JSON.stringify(['budget.xlsx', 'invoice-031.txt']) && folderLink === 'My drive', JSON.stringify({ fin, folderLink }))

  // ── Add to category: a new category of the user's, from a selection
  const before = { ...prompts }
  await page.locator('.sidebar .nav-item', { hasText: 'My Drive' }).click()
  await row(page, 'lease.txt').locator('input[type=checkbox]').check()
  await row(page, 'consensus-whitepaper.txt').locator('input[type=checkbox]').check()
  await page.getByRole('button', { name: 'Add to category' }).click()
  await page.locator('.categorize-modal input').fill('Blockchain')
  let t = Date.now()
  await page.locator('.categorize-modal').getByRole('button', { name: 'Create & add' }).click()
  const added = await toast(page)
  await page.locator('.sidebar .nav-item', { hasText: 'Categories' }).click()
  await chip(page, 'Blockchain').waitFor({ timeout: 2000 })
  const shownMs = Date.now() - t
  const own = await chips(page, 'Your categories')
  check('Add to category → a new category: “Added to Blockchain”, its chip shown at once with both files', added === 'Added to Blockchain' && own.includes('Blockchain 2') && shownMs < 2000, `${shownMs} ms, ${JSON.stringify({ added, own })}`)
  await settled(page)
  let s = await stored()
  check('…stored in the drive: the category and both files put in it', s?.own.length === 1 && s.own[0].name === 'Blockchain' && s.pins.filter((p) => p.in).length === 2, JSON.stringify(s))

  // ── taken out by hand (a category made from the dialog is the one shown)
  if ((await chip(page, 'Blockchain').getAttribute('aria-pressed')) !== 'true') await chip(page, 'Blockchain').click()
  await page.locator('.cat-files .result', { hasText: 'lease.txt' }).getByRole('button', { name: 'Take out of Blockchain' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.cat-files .result').length === 1, null, { timeout: 2000 })
  check('a file taken out leaves the list at once', JSON.stringify(await listed(page)) === JSON.stringify(['consensus-whitepaper.txt']))
  await chip(page, 'Finance').click()
  await page.locator('.cat-files .result', { hasText: 'invoice-031.txt' }).getByRole('button', { name: 'Take out of Finance' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.cat-files .result').length === 1, null, { timeout: 2000 }).catch(() => undefined)
  check('a file taken out of a topic leaves it', (await chips(page, 'Topics')).includes('Finance 1'), JSON.stringify(await chips(page, 'Topics')))
  await settled(page)
  s = await stored()
  const out = s?.pins.filter((p) => !p.in).map((p) => p.cat).sort()
  check('…stored: taken out of Blockchain and Finance', JSON.stringify(out) === JSON.stringify([s.own[0].id, 'topic:finance'].sort()), JSON.stringify(s?.pins))

  // ── a second device, a 390 px phone: the user's category is there
  const phone = await walletContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const pp = await phone.newPage()
  pp.on('pageerror', (e) => errors.push(`phone pageerror: ${e.message}`))
  answerAsks(pp, () => true)
  const phoneFrom = { ...prompts }
  await pp.goto(base)
  await connectExtension(pp)
  await pp.getByRole('button', { name: 'Restore my drive' }).tap({ timeout: 2 * 60_000 })
  await pp.locator('.nav-toggle').waitFor({ timeout: 5 * 60_000 })
  await pp.locator('.nav-toggle').tap()
  await pp.locator('.sidebar .nav-item', { hasText: 'Categories' }).tap()
  await chip(pp, 'Blockchain').waitFor({ timeout: 60_000 })
  const fit = await pp.evaluate(() => {
    const rows = [...document.querySelectorAll('.categories .chips')].map((c) => ({ w: c.clientWidth, sw: c.scrollWidth, wrap: getComputedStyle(c).flexWrap }))
    const hs = [...document.querySelectorAll('.categories .chip')].map((c) => Math.round(c.getBoundingClientRect().height))
    const r = document.querySelector('.categories').getBoundingClientRect()
    return { rows, minH: Math.min(...hs), left: Math.round(r.left), right: Math.round(r.right), scroll: document.documentElement.scrollWidth - window.innerWidth }
  })
  // (smart search starts off on phones: the user's category and types here, no topics)
  check('another device (390 px phone) sees the user’s category; chips ≥44 px in rows that scroll sideways within the page, no page sideways scroll',
    fit.minH >= 44 && fit.rows.every((r) => r.wrap === 'nowrap' && r.w <= fit.right - fit.left) && fit.left >= 12 && fit.right <= 378 && fit.scroll <= 0, JSON.stringify(fit))
  // Add to category on the phone: the selection bar's button and the dialog fit
  await pp.locator('.nav-toggle').tap()
  await pp.locator('.sidebar .nav-item', { hasText: 'My Drive' }).tap()
  await row(pp, 'carbonara.md').locator('input[type=checkbox]').tap()
  await pp.getByRole('button', { name: 'Add to category' }).tap()
  await pp.locator('.categorize-modal').waitFor()
  const dlg = await pp.evaluate(() => {
    const r = document.querySelector('.categorize-modal').getBoundingClientRect()
    return { left: Math.round(r.left), right: Math.round(r.right), scroll: document.documentElement.scrollWidth - window.innerWidth }
  })
  check('390 px: Add to category opens a dialog that fits', dlg.left >= 0 && dlg.right <= 390 && dlg.scroll <= 0, JSON.stringify(dlg))
  await pp.locator('.categorize-modal').getByRole('button', { name: 'Cancel' }).tap()
  await phone.close()
  // the phone's restore signature isn't a category edit's
  const phoneUsed = { tx: prompts.tx - phoneFrom.tx, sign: prompts.sign - phoneFrom.sign }

  // ── rename and delete the user's category
  await page.reload()
  await page.locator('.sidebar .nav-item', { hasText: 'Categories' }).click({ timeout: 5 * 60_000 })
  await chip(page, 'Blockchain').click()
  nextAnswer = 'Crypto papers'
  await page.locator('.cat-own-actions').getByRole('button', { name: 'Rename' }).click()
  await chip(page, 'Crypto papers').waitFor({ timeout: 5000 })
  check('rename: the chip shows the new name at once', (await toast(page)) === 'Renamed to Crypto papers')
  await settled(page)
  nextAnswer = true
  await page.locator('.cat-own-actions').getByRole('button', { name: 'Delete' }).click()
  await page.waitForFunction(() => !document.querySelector('.categories .chip-own'), null, { timeout: 5000 })
  await settled(page)
  s = await stored()
  check('delete: the category and its pins go (the topic one stays)', s.own.length === 0 && s.pins.length === 1 && s.pins[0].cat === 'topic:finance', JSON.stringify(s))
  check('none of it asked the wallet (the phone’s restore aside)', prompts.tx - phoneUsed.tx === before.tx && prompts.sign - phoneUsed.sign === before.sign, JSON.stringify({ before, after: prompts, phoneUsed }))

  // ── a folder grouped by category: sections, each file once; kept after a reload
  await page.locator('.sidebar .nav-item', { hasText: 'My Drive' }).click()
  await page.locator('.group-toggle input').check()
  const topicSections = () => page.waitForFunction(() => [...document.querySelectorAll('.group-row th, .group-title')].some((h) => h.textContent.startsWith('Recipes')), null, { timeout: 5 * 60_000, polling: 500 })
  await topicSections()
  const groups = async () => page.$$eval('tbody.group-body', (bs) => bs.map((b) => ({ name: b.querySelector('.group-row th').childNodes[0].textContent.trim(), rows: b.querySelectorAll('tr:not(.group-row)').length })))
  let g = await groups()
  const total = g.reduce((n, x) => n + x.rows, 0)
  check('Group by category: the folder in sections, each file once', g.length >= 4 && total === names.length && g.some((x) => x.name === 'Recipes'), JSON.stringify(g))
  const inDocs = await page.$$eval('tbody.group-body', (bs) => bs.filter((b) => b.querySelector('.group-row th').textContent.startsWith('Documents')).flatMap((b) => [...b.querySelectorAll('tr:not(.group-row)')].map((r) => r.textContent)))
  check('…the file taken out of Finance is under its type instead', inDocs.some((r) => r.includes('invoice-031.txt')), JSON.stringify(g))
  await page.reload()
  await page.locator('tbody.group-body').first().waitFor({ timeout: 5 * 60_000 })
  check('…kept after a reload (by type until the model is ready)', await page.locator('.group-toggle input').isChecked())
  await topicSections()
  await page.getByRole('button', { name: 'Grid view' }).click()
  const grid = await page.$$eval('.grid-sections .group-sec', (ss) => ss.map((x) => x.querySelectorAll('.tile').length))
  check('…and in the grid: sections of tiles', grid.length === g.length && grid.reduce((a, b) => a + b, 0) === names.length, JSON.stringify(grid))

  // ── 390 px with topics: their row scrolls sideways, the page doesn't
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.nav-toggle').click()
  await page.locator('.sidebar .nav-item', { hasText: 'Categories' }).click()
  await chip(page, 'Recipes').waitFor({ timeout: 60_000 })
  const row390 = await page.evaluate(() => {
    const g = [...document.querySelectorAll('.categories .cat-group')].find((x) => x.querySelector('.cat-group-title')?.textContent === 'Topics')
    const c = g.querySelector('.chips')
    return { w: c.clientWidth, sw: c.scrollWidth, scroll: document.documentElement.scrollWidth - window.innerWidth }
  })
  check('390 px: the Topics row scrolls sideways; the page doesn’t', row390.sw > row390.w && row390.scroll <= 0, JSON.stringify(row390))
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
