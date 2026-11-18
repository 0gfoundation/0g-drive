// Re-indexing (D41): a file indexed the old way (a v1 search entry, its
// embedding made from its opening as read: authors and all) is indexed
// again on this device, in the background, from what it's about — and
// saved as v2 with the sidebar's Save, with no wallet prompt. The new entry
// keeps the opening as its excerpt (for results and searching an author's
// name) and the text it was embedded from, without the authors.
// In headless Chromium against the dev server or a deployment, on a drive
// made with a FRESH key funded from .env's test wallet (refunded and its
// files deleted at the end).
//   node scripts/test-reindex.mjs [http://localhost:5173]
import { chromium } from 'playwright'
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
const funder = new ethers.Wallet(funderKey, provider)
const t0 = Date.now()
const at = () => `[${((Date.now() - t0) / 1000).toFixed(0)}s]`
const step = (m) => console.log(`${at()} ${m}`)
let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${at()} ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const wallet = ethers.Wallet.createRandom().connect(provider)
await (await funder.sendTransaction({ to: wallet.address, value: ethers.parseEther('1') })).wait()
step(`fresh wallet ${wallet.address} funded`)

let txs = 0
let signs = 0
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
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
        signs++
        const [data] = params
        return { ok: await wallet.signMessage(ethers.isHexString(data) ? ethers.getBytes(data) : data) }
      }
      case 'eth_sendTransaction': {
        txs++
        const [tx] = params
        const sent = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n, gasLimit: tx.gas ? BigInt(tx.gas) : undefined })
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
  // smart search starts off here (the file goes up unindexed); the test turns it on
  if (localStorage.getItem('0gdrive:smart-search') === null) localStorage.setItem('0gdrive:smart-search', 'off')
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

// a paper's first page as pdf.js gives it: a notice, the title, the authors, the abstract
const NAME = 'skills-paper.txt'
const TEXT = 'Provided proper attribution is provided, Acme hereby grants permission to reproduce the tables and figures in this paper. ' +
  'Reusable Skills for LLM Agents Zeng Ming ∗ Acme Research zengming@acme.com Xiang Li ∗ Acme Research xli@acme.com Chen Wei † Acme Brain ' +
  'Abstract Large language model agents struggle to retain skills across tasks. We give agents a memory of reusable skills and evaluate on agent benchmarks.'
const AUTHORS = /Zeng|Xiang|Chen Wei|acme\.com/
// and an invoice under a plain name: indexed again, it's in Finance by its text (the paper's short abstract
// fits no built-in topic for sure); indexed the old way here, with a blank vector, it's in none
const BILL = 'notes.txt'
const BILL_TEXT = 'Invoice no. 2025-031. Bill to: Acme Ltd. Web design services, 24 hours at 85 EUR. Subtotal 2,040.00, VAT 469.20, total due 2,509.20 within 30 days. Payment by bank transfer.'

const status = () => page.locator('.sidebar .search-index').textContent({ timeout: 1000 }).catch(() => '')
const waitStatus = async (re, timeout = 6 * 60_000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const s = (await status()) ?? ''
    if (re.test(s)) return s
    await page.waitForTimeout(1000)
  }
  return (await status()) ?? ''
}

let mk = null
const store = () => new DriveStore(new V2Backend(new RelayerClient(V2_TESTNET), deriveStorageKey(mk), mk))
try {
  await page.goto(base)
  await connectExtension(page)
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: 'New folder', exact: true }).waitFor({ timeout: 5 * 60_000 })
  mk = hexToBytes(await page.evaluate((a) => localStorage.getItem('0gdrive:masterkey:' + a.toLowerCase()), wallet.address))
  await page.setInputFiles('.dropzone input[type=file]', [NAME, BILL].map((name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name === NAME ? TEXT : BILL_TEXT) })))
  await page.locator('table tbody tr', { hasText: NAME }).waitFor({ timeout: 8 * 60_000 })
  await page.locator('table tbody tr', { hasText: BILL }).waitFor({ timeout: 8 * 60_000 })
  await page.waitForFunction(() => !document.querySelector('.progress-line.on'), null, { timeout: 3 * 60_000, polling: 500 })
  step('uploaded with smart search off')

  // the record as a drive indexed before D41 has it: a v1 entry, made from the opening as read
  const s = store()
  const drive = await s.loadDrive()
  const meta = drive.folders.get('').files.find((f) => f.name === NAME)
  const v1 = { v: 1, t: TEXT.slice(0, 280), e: Buffer.alloc(384).toString('base64') }
  const bill = drive.folders.get('').files.find((f) => f.name === BILL)
  await s.putFileRecords('', [{ ...meta, search: v1 }, { ...bill, search: { v: 1, t: BILL_TEXT.slice(0, 280), e: Buffer.alloc(384).toString('base64') } }])
  await s.backend.settled()
  const v1Stored = (await store().loadDrive()).folders.get('').files.find((f) => f.name === NAME).search
  check('the file’s record has an old-style entry (v1)', v1Stored?.v === 1 && !v1Stored.s, JSON.stringify({ v: v1Stored?.v }))

  // smart search on: the old entry is indexed again on this device, in the background
  const before = { txs, signs }
  await page.reload()
  await page.getByRole('button', { name: 'New folder', exact: true }).waitFor({ timeout: 5 * 60_000 })
  await page.locator('.sidebar .sec-toggle input').check()
  const s1 = await waitStatus(/2 indexed on this device/)
  check('the old entries are indexed again on this device, no wallet prompt', /2 indexed on this device/.test(s1) && txs === before.txs && signs === before.signs, JSON.stringify(s1))

  // categories use them before they're saved (D42): the invoice's old entry gave it no topic (a blank vector), the new one Finance
  await page.locator('.sidebar .nav-item', { hasText: 'Categories' }).click()
  const topics = await page
    .waitForFunction(() => {
      const g = [...document.querySelectorAll('.categories .cat-group')].find((x) => x.querySelector('.cat-group-title')?.textContent === 'Topics')
      const names = g ? [...g.querySelectorAll('.chip:not(.chip-new) .chip-name')].map((c) => c.textContent) : []
      return names.length ? names : null
    }, null, { timeout: 30_000, polling: 500 })
    .then((h) => h.jsonValue())
    .catch(() => [])
  check('…and categories regroup with them before they’re saved: the invoice is in Finance now', topics.includes('Finance') && /indexed on this device/.test((await status()) ?? ''), JSON.stringify(topics))

  await page.locator('.sidebar .search-index button', { hasText: 'Save' }).click()
  const s2 = await waitStatus(/^(?![\s\S]*indexed on this device)/, 5 * 60_000)
  const e = (await store().loadDrive()).folders.get('').files.find((f) => f.name === NAME).search
  check('Save stores it as v2, no wallet prompt', e?.v === 2 && txs === before.txs && signs === before.signs && !/indexed on this device/.test(s2), JSON.stringify({ v: e?.v, s2 }))
  // (a text file's opening on one line, notice + title + authors: no font sizes to find its title by — a PDF's comes from its largest text)
  check('…embedded from its abstract: no authors or notice in what it was made from', !!e?.s && e.s.startsWith('Large language model agents') && !AUTHORS.test(e.s) && !/permission/.test(e.s), JSON.stringify(e?.s))
  check('…its opening kept as the excerpt (results, an author’s name searched)', e?.t === TEXT.slice(0, 280).replace(/\s+/g, ' ').trim() || e?.t?.startsWith('Provided proper attribution'), JSON.stringify(e?.t?.slice(0, 60)))
  await page.reload()
  await page.getByRole('button', { name: 'New folder', exact: true }).waitFor({ timeout: 5 * 60_000 })
  await page.waitForTimeout(8000)
  check('…and it isn’t indexed again after a reload', !/to index|indexed on this device/.test((await status()) ?? ''), JSON.stringify(await status()))
} catch (err) {
  check('run completed', false, err.message.split('\n').slice(0, 4).join(' | '))
} finally {
  await browser.close()
  if (mk) {
    const account = deriveStorageKey(mk)
    const relayer = new RelayerClient(V2_TESTNET)
    const files = (await relayer.list(account.address, { limit: 100 }).catch(() => ({ files: [] }))).files
    for (const f of files) await relayer.delete(account, f.dataHash).catch(() => undefined)
    step(`deleted the drive's ${files.length} files`)
  }
  await refund(wallet, funder.address)
}
if (errors.length) console.log(errors.join('\n'))
console.log(failed || errors.length ? `${failed} FAILED` : 'REINDEX TEST PASSED ✓')
process.exit(failed || errors.length ? 1 : 0)
