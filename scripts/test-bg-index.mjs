// Background indexing, in headless Chromium against the dev server or a
// deployment. Files uploaded with smart search off (in two folders) are
// found and indexed on this device once it's on, with no wallet prompt;
// search finds them before anything is saved; the next approved change (an
// upload in one folder) saves the other folder's entries in the same single
// transaction; they're in the drive (found again with this device's store
// cleared); the sidebar's Save saves the rest with one approval; a file
// whose content can't be read shows as "indexed by name only"; the status
// fits a 390 px phone.
// Makes a drive on a FRESH key funded from .env's test wallet, refunded at
// the end. Usage: node scripts/test-bg-index.mjs [http://localhost:5173]
import { chromium } from 'playwright'
import { connectExtension } from './lib/connect.mjs'
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
await (await funder.sendTransaction({ to: wallet.address, value: ethers.parseEther('0.5') })).wait()
step(`fresh wallet ${wallet.address}`)
let txs = 0

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
let promptAnswer = ''
page.on('dialog', (d) => d.accept(promptAnswer))
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
  localStorage.setItem('0gdrive:layout', 'list')
  // smart search starts off here (the files go up unindexed); the test turns it on
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

const treeRow = (name) => page.locator('.sidebar .tree-row', { has: page.locator('.tree-name', { hasText: new RegExp(`^${name}$`) }) })
const fileRow = (name) => page.locator('table tr', { has: page.locator('.fname-btn', { hasText: name }) })
const upload = async (files) => {
  await page.setInputFiles('.dropzone input[type=file]', files.map(([name, text, mimeType = 'text/plain']) => ({ name, mimeType, buffer: Buffer.from(text) })))
  for (const [name] of files) await fileRow(name).waitFor({ timeout: 8 * 60_000 })
  await page.locator('.sidebar').getByText(/Syncing|Loading/).waitFor({ state: 'detached', timeout: 60_000 }).catch(() => {})
}
const toggle = page.locator('.sidebar .sec-toggle input')
const status = () => page.locator('.sidebar .search-index').textContent({ timeout: 1000 }).catch(() => '')
const waitStatus = async (re, timeout = 5 * 60_000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const s = (await status()) ?? ''
    if (re.test(s)) return s
    await page.waitForTimeout(1000)
  }
  return (await status()) ?? ''
}
const topHit = async (q) => {
  await page.getByPlaceholder(/Search your drive/).fill(q)
  await page.locator('.results .result').first().waitFor({ timeout: 2 * 60_000 })
  await page.waitForTimeout(1200) // the debounced, embedded query lands
  const top = await page.locator('.results .result .fname-btn').first().textContent()
  await page.getByPlaceholder(/Search your drive/).fill('')
  return top.trim()
}
/** Reload with this device's unsaved entries gone: only what the drive saved is left. */
const reloadWithoutDeviceEntries = async () => {
  await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('0gdrive-search'); q.onsuccess = q.onerror = q.onblocked = () => r() }))
  await page.reload()
  await page.locator('table .fname-btn').first().waitFor({ timeout: 5 * 60_000 })
  await page.waitForTimeout(4000) // the indexer would have started by now
}

try {
  await page.goto(base)
  await connectExtension(page)
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 120_000 })
  promptAnswer = 'Recipes'
  await page.getByRole('button', { name: '+ New folder' }).click()
  await treeRow('Recipes').first().waitFor({ timeout: 5 * 60_000 })
  await treeRow('Recipes').first().locator('.tree-label').click()
  await upload([['carbonara.md', 'Spaghetti carbonara: guanciale, eggs, pecorino, black pepper. Boil the pasta al dente.']])
  await page.locator('.breadcrumb .crumb').first().click()
  await upload([['lease.txt', 'Residential lease agreement between landlord and tenant. Notice period sixty days.']])
  step('uploaded Recipes/carbonara.md and lease.txt with smart search off')

  // ---- discovery + indexing on this device, no prompts
  const before = txs
  await toggle.check()
  const s1 = await waitStatus(/2 indexed on this device/)
  check('turned on, both files are found (two folders) and indexed on this device', /2 indexed on this device/.test(s1) && !/to index/.test(s1), JSON.stringify(s1))
  check('indexing asked the wallet nothing', txs === before, `${txs - before} transactions`)
  check('search finds them before anything is saved', (await topHit('pasta recipe')) === 'carbonara.md' && (await topHit('rental agreement')) === 'lease.txt')

  // ---- the next approved change carries them (one transaction)
  const beforeUpload = txs
  await upload([['todo.txt', 'Buy groceries and call the plumber.']])
  const s2 = await waitStatus(/^(?![\s\S]*indexed on this device)/, 60_000)
  check('an upload in My drive saves both entries (Recipes too) in its one transaction', txs - beforeUpload === 1 && !/indexed on this device/.test(s2), `${txs - beforeUpload} transactions; status ${JSON.stringify(s2)}`)
  await reloadWithoutDeviceEntries()
  const s3 = (await status()) ?? ''
  check('they are in the drive: with this device’s store cleared nothing is left to index', !/to index|indexed on this device/.test(s3), JSON.stringify(s3))
  check('…and search still finds them', (await topHit('pasta recipe')) === 'carbonara.md')

  // ---- Save from the sidebar; a file that can't be read
  await toggle.uncheck()
  await upload([
    ['budget.txt', 'Minutes of the quarterly budget meeting: marketing cut by fifteen percent.'],
    ['scan.pdf', '%PDF-1.4\nnot really a pdf\n', 'application/pdf'],
  ])
  await toggle.check()
  const s4 = await waitStatus(/2 indexed on this device/)
  check('a file whose content can’t be read shows as indexed by name only', /1 indexed by name only/.test(s4), JSON.stringify(s4))

  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.nav-toggle').click()
  await page.locator('.sidebar .search-index').scrollIntoViewIfNeeded()
  const fit = await page.evaluate(() => {
    const box = document.querySelector('.sidebar .search-index').getBoundingClientRect()
    const save = document.querySelector('.sidebar .search-index button').getBoundingClientRect()
    return { right: Math.round(box.right), saveRight: Math.round(save.right), saveW: Math.round(save.width), scroll: document.scrollingElement.scrollWidth }
  })
  check('phone (390 px): the status and Save fit', fit.right <= 390 && fit.saveRight <= 390 && fit.saveW > 0 && fit.scroll <= 390, JSON.stringify(fit))

  const beforeSave = txs
  await page.locator('.sidebar .search-index button', { hasText: 'Save' }).click()
  const s5 = await waitStatus(/^(?![\s\S]*indexed on this device)/, 5 * 60_000)
  check('Save saves them with one approval', txs - beforeSave === 1 && !/indexed on this device/.test(s5), `${txs - beforeSave} transactions; status ${JSON.stringify(s5)}`)
  await page.setViewportSize({ width: 1280, height: 900 })
  await reloadWithoutDeviceEntries()
  check('…and they are in the drive', (await topHit('budget meeting')) === 'budget.txt' && !/to index/.test((await status()) ?? ''))
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
} catch (e) {
  failed++
  console.log(`${at()} ERROR ${e.message.split('\n')[0]}`)
} finally {
  await browser.close()
  await refund(wallet, funder.address)
}
console.log(failed ? `${failed} FAILED` : 'BACKGROUND INDEX TEST PASSED ✓')
process.exitCode = failed ? 1 : 0
