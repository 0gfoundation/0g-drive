// Duplicate names, in the browser (headless Chromium + dev server), with an
// injected wallet backed by a FRESH key funded from .env's test wallet.
// Uploads a.txt, b.txt and notes.txt, then drops files whose names are taken:
//   asked first: a name field per file, filled with "name (1).ext"; Cancel /
//   Skip / Replace / Upload with these names (no Replace for a name only
//   repeated within the drop)
//   a typed name: taken, empty, with "/" or given twice is refused
//   upload with a typed name; with the suggestion; Replace → old b.txt to
//   trash, same transaction; Skip → the rest only; Cancel → nothing
//   phone width: the dialog fits, fields and buttons thumb-sized
//   restoring the replaced b.txt → "b (1).txt", with an Activity note
//   after a reload every name is there once
// On-device AI is switched off, so no model download.
//
//   node scripts/test-duplicate-names.mjs [http://localhost:5173]
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
const walletCalls = [] // method names, in order
await page.exposeFunction('__eth', async (method, params) => {
  walletCalls.push(method)
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


const names = () => page.$$eval('table .fname-btn', (els) => els.map((e) => e.textContent.trim()).sort())
const row = (name) => page.locator('table tr', { has: page.locator('.fname-btn', { hasText: new RegExp(`^${name.replace(/[.()]/g, '\\$&')}$`) }) })
const dialog = page.locator('.dup-modal')
const file = (name, text) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) })
const drop = (files) => page.setInputFiles('.dropzone input[type=file]', files)
const waitNames = (want) =>
  page.waitForFunction(
    (want) => JSON.stringify([...document.querySelectorAll('table .fname-btn')].map((e) => e.textContent.trim()).sort()) === JSON.stringify(want),
    [...want].sort(),
    { timeout: 8 * 60_000, polling: 1000 }
  )
const preview = async (name) => {
  await row(name).locator('.fname-btn').click()
  await page.locator('.preview-text').waitFor({ timeout: 5 * 60_000 })
  const t = await page.textContent('.preview-text')
  await page.keyboard.press('Escape')
  return t
}
const buttons = () => dialog.locator('.modal-actions button').allTextContents()
const field = (name) => dialog.getByRole('textbox', { name: `New name for ${name}` })
const uploadBtn = () => dialog.getByRole('button', { name: 'Upload with these names' })
const problemsShown = () => dialog.locator('.error-text').allTextContents()

try {
  await page.goto(base)
  await connectExtension(page)
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 120_000 })
  await drop([file('a.txt', 'A1'), file('b.txt', 'B1'), file('notes.txt', 'N1')])
  await waitNames(['a.txt', 'b.txt', 'notes.txt'])
  step('a.txt, b.txt, notes.txt uploaded')

  // a taken name (differing only in case counts): asked, with a name to edit
  let tx = txs
  await drop([file('A.txt', 'A2'), file('c.txt', 'C1')])
  await dialog.waitFor({ timeout: 10_000 })
  const h1 = await dialog.locator('h2').textContent()
  const b1 = await buttons()
  const suggested = await field('A.txt').inputValue()
  const selected = await field('A.txt').evaluate((i) => i.value.slice(i.selectionStart, i.selectionEnd))
  check(
    'a taken name asks first: a name field with "A (1).txt" (name part selected); Cancel / Skip / Replace / Upload with these names',
    h1.includes('A.txt') && suggested === 'A (1).txt' && selected === 'A (1)' &&
      JSON.stringify(b1) === JSON.stringify(['Cancel', 'Skip', 'Replace', 'Upload with these names']),
    `${h1} · ${suggested} [${selected}] · ${b1.join(' / ')}`
  )
  const refused = {}
  for (const bad of ['b.txt', 'NOTES.TXT', 'c.txt', '', 'x/y.txt']) {
    await field('A.txt').fill(bad)
    refused[bad || '(empty)'] = { disabled: await uploadBtn().isDisabled(), problem: (await problemsShown()).join(' ') }
  }
  check(
    'a typed name already in the folder, in this drop, empty or with "/" is refused',
    Object.values(refused).every((r) => r.disabled && r.problem),
    JSON.stringify(refused).slice(0, 300)
  )
  await field('A.txt').fill('A-v2.txt')
  await uploadBtn().click()
  await waitNames(['a.txt', 'A-v2.txt', 'b.txt', 'c.txt', 'notes.txt'])
  check('upload with a typed name: "A-v2.txt", one transaction', txs - tx === 1 && (await preview('A-v2.txt')) === 'A2', `${txs - tx} tx`)

  // Replace: the old one goes to trash in the same transaction
  tx = txs
  const registered = await page.$$eval('.activity li', (els) => els.filter((e) => e.textContent.includes('stored and registered')).length)
  await drop([file('b.txt', 'B2')])
  await dialog.getByRole('button', { name: 'Replace' }).click()
  await page.waitForFunction(
    (n) => [...document.querySelectorAll('.activity li')].filter((e) => e.textContent.includes('stored and registered')).length > n,
    registered,
    { timeout: 8 * 60_000, polling: 1000 }
  )
  // the drive re-syncs after the upload: wait for it to start and finish
  await page.waitForFunction(() => document.body.textContent.includes('Syncing drive from chain'), null, { timeout: 10_000 }).catch(() => undefined)
  await page.waitForFunction(() => !document.body.textContent.includes('Syncing drive from chain'), null, { timeout: 2 * 60_000 })
  const afterReplace = await names()
  const bText = await preview('b.txt')
  check('Replace: one b.txt, with the new content, one transaction', afterReplace.filter((n) => n === 'b.txt').length === 1 && bText === 'B2' && txs - tx === 1, `${JSON.stringify(afterReplace)} · ${bText} · ${txs - tx} tx`)

  // Skip: the clashing file is left out, the rest go up
  tx = txs
  await drop([file('notes.txt', 'N2'), file('d.txt', 'D1')])
  await dialog.getByRole('button', { name: 'Skip' }).click()
  await waitNames(['a.txt', 'A-v2.txt', 'b.txt', 'c.txt', 'd.txt', 'notes.txt'])
  check('Skip: d.txt added, notes.txt unchanged', (await preview('notes.txt')) === 'N1' && txs - tx === 1, `${txs - tx} tx`)

  // the same name twice in one drop: nothing to replace, so no Replace
  await drop([file('e.txt', 'E1'), file('e.txt', 'E2')])
  await dialog.waitFor({ timeout: 10_000 })
  const b2 = await buttons()
  check('a name repeated in one drop: asked, without Replace', !b2.includes('Replace'), b2.join(' / '))
  await uploadBtn().click()
  await waitNames(['a.txt', 'A-v2.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'e (1).txt', 'notes.txt'])
  check('…the suggested name as is: e.txt and e (1).txt', true)

  // Cancel: nothing queued, no transaction
  tx = txs
  const queued = await page.locator('.queue-item').count()
  await drop([file('a.txt', 'A3')])
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await page.waitForTimeout(4000)
  check('Cancel: nothing queued, no transaction', (await page.locator('.queue-item').count()) === queued && txs === tx && (await dialog.count()) === 0)

  // phone width: the dialog fits, fields and buttons are thumb-sized
  await page.setViewportSize({ width: 390, height: 800 })
  await drop([file('a.txt', 'A3'), file('c.txt', 'C2')])
  await dialog.waitFor({ timeout: 10_000 })
  const phone = await page.evaluate(() => {
    const m = document.querySelector('.dup-modal').getBoundingClientRect()
    const btns = [...document.querySelectorAll('.dup-modal .modal-actions button')].map((b) => b.getBoundingClientRect())
    const inputs = [...document.querySelectorAll('.dup-modal input')].map((b) => b.getBoundingClientRect())
    return {
      left: Math.round(m.left), right: Math.round(m.right), overflow: document.documentElement.scrollWidth - 390,
      minBtn: Math.round(Math.min(...btns.map((b) => b.height))), maxBtn: Math.round(Math.max(...btns.map((b) => b.height))), fields: inputs.length,
      fieldsFit: inputs.every((r) => r.left >= m.left && r.right <= m.right), minField: Math.round(Math.min(...inputs.map((r) => r.height))),
    }
  })
  check('phone: the dialog fits the screen, a field per file inside it, buttons 44–52 px (none squeezed)', phone.left >= 0 && phone.right <= 390 && phone.overflow <= 0 && phone.minBtn >= 44 && phone.maxBtn <= 52 && phone.fields === 2 && phone.fieldsFit && phone.minField >= 36, JSON.stringify(phone))
  // the same new name typed for two files
  // focusing a field selects the name part only (like Rename): focus first,
  // so fill replaces the whole value
  for (const f of ['a.txt', 'c.txt']) {
    await field(f).focus()
    await field(f).fill('same.txt')
  }
  const twice = await problemsShown()
  check(
    'the same new name for two files is refused',
    (await uploadBtn().isDisabled()) && twice.length === 2,
    `${twice.join(' | ')} · fields ${JSON.stringify(await dialog.locator('input').evaluateAll((els) => els.map((e) => [e.getAttribute('aria-label'), e.value])))}`
  )
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await page.setViewportSize({ width: 1280, height: 900 })

  // restoring the replaced b.txt: its name is taken now
  tx = txs
  await page.locator('[data-guide="trash"]').click()
  await row('b.txt').waitFor({ timeout: 2 * 60_000 })
  await row('b.txt').getByRole('button', { name: 'Restore' }).click()
  const note = page.locator('.activity li', { hasText: 'restored to' })
  await note.first().waitFor({ timeout: 10 * 60_000 })
  const noteText = await note.first().textContent()
  check('restore into a taken name: "b (1).txt", and Activity says why', noteText.includes('as “b (1).txt”') && txs - tx === 1, noteText)

  await page.reload() // reconnects by itself
  await page.locator('.nav .nav-item', { hasText: 'My Drive' }).first().click({ timeout: 5 * 60_000 })
  const final = ['a.txt', 'A-v2.txt', 'b.txt', 'b (1).txt', 'c.txt', 'd.txt', 'e.txt', 'e (1).txt', 'notes.txt']
  const ok = await waitNames(final).then(() => true, () => false)
  check('after reload: every name once, as chosen', ok && (await preview('b (1).txt')) === 'B1' && (await preview('b.txt')) === 'B2', JSON.stringify(await names()))
  check('no page errors', errors.length === 0, errors.join('; '))
} catch (err) {
  check('run completed', false, err.message.split('\n')[0])
} finally {
  await browser.close()
}

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} checks passed`)
await refund(wallet, funder.address)
process.exit(passed === results.length ? 0 : 1)
