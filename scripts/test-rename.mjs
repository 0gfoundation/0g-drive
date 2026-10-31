// File rename, in the browser (headless Chromium + dev server), with an
// injected wallet backed by a FRESH key funded from .env's test wallet.
// Uploads notes.txt and todo.txt, then through the Rename dialog:
//   the name without its extension is pre-selected
//   a name already in the folder (any case), "/" and an empty name are refused
//   changing the extension shows a warning
//   the rename takes ONE transaction and survives a reload
//   phone width: the dialog and the row fit the screen
// On-device AI is switched off, so no model download.
//
//   node scripts/test-rename.mjs [http://localhost:5173]
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

const names = () => page.$$eval('table .fname-btn', (els) => els.map((e) => e.textContent.trim()).sort())
const row = (name) => page.locator('table tr', { has: page.locator('.fname-btn', { hasText: name }) })
const LONG = 'quarterly-planning-notes-for-the-whole-team-2026-final-v2.txt'
const dialog = page.locator('.rename-modal')
const input = dialog.getByRole('textbox', { name: 'New name' })
const submit = dialog.getByRole('button', { name: 'Rename' })

try {
  await page.goto(base)
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 120_000 })
  await page.setInputFiles('.dropzone input[type=file]', [
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Meeting notes: ship rename.') },
    { name: 'todo.txt', mimeType: 'text/plain', buffer: Buffer.from('1. test rename') },
    { name: LONG, mimeType: 'text/plain', buffer: Buffer.from('long name') },
  ])
  await page.waitForFunction(
    (names) => names.every((n) => [...document.querySelectorAll('table .fname-btn')].some((b) => b.textContent.includes(n))),
    ['notes.txt', 'todo.txt', LONG],
    { timeout: 8 * 60_000, polling: 2000 }
  )
  step('3 files uploaded')

  // file actions are icon-only: no text, named for tooltips and screen readers, one square size
  const rowButtons = () => page.evaluate(() =>
    [...document.querySelector('table tbody tr .row-actions').querySelectorAll('button')].map((b) => {
      const r = b.getBoundingClientRect()
      return { name: b.getAttribute('aria-label'), title: b.title, text: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height) }
    }))
  const iconOnly = (btns) =>
    btns.length === 5 && btns.every((b) => b.text === '' && b.name && b.title && b.w === btns[0].w && b.h === btns[0].h)
  const desk = await rowButtons()
  check('desktop: file actions are icons only, each named, all one size', iconOnly(desk), JSON.stringify(desk))

  await row('notes.txt').getByRole('button', { name: 'Rename' }).click()
  await input.waitFor()
  const sel = await input.evaluate((i) => [i.selectionStart, i.selectionEnd, i.value])
  check('dialog opens with "notes" selected, not ".txt"', sel[0] === 0 && sel[1] === 5 && sel[2] === 'notes.txt', JSON.stringify(sel))

  const refused = {}
  for (const bad of ['TODO.txt', 'a/b.txt', '   ']) {
    await input.fill(bad)
    refused[bad] = {
      disabled: await submit.isDisabled(),
      error: (await dialog.locator('.error-text').textContent().catch(() => '')).trim(),
    }
  }
  check('a name already in the folder (other case) is refused',
    refused['TODO.txt'].disabled && /already a file named/.test(refused['TODO.txt'].error), JSON.stringify(refused['TODO.txt']))
  check('"/" and an empty name are refused',
    refused['a/b.txt'].disabled && /“\/”/.test(refused['a/b.txt'].error) && refused['   '].disabled && /empty/.test(refused['   '].error),
    JSON.stringify([refused['a/b.txt'], refused['   ']]))

  await input.fill('notes.md')
  const warn = await dialog.textContent()
  check('changing the extension shows a warning', /extension changes from “\.txt” to “\.md”/.test(warn), warn.slice(0, 160))

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  const phone = await page.evaluate(() => {
    const m = document.querySelector('.rename-modal').getBoundingClientRect()
    const btns = [...document.querySelectorAll('.rename-modal .modal-actions .btn')].map((b) => Math.round(b.getBoundingClientRect().height))
    return { overflow: document.documentElement.scrollWidth - window.innerWidth, left: Math.round(m.left), right: Math.round(m.right), btns }
  })
  check('phone: dialog inside the screen, ≥44 px buttons, no overflow',
    phone.overflow <= 0 && phone.left >= 0 && phone.right <= 390 && phone.btns.every((h) => h >= 44), JSON.stringify(phone))
  await page.setViewportSize({ width: 1280, height: 900 })

  await input.fill('meeting notes.txt')
  const before = txs
  await submit.click()
  await page.locator('.activity li', { hasText: 'Renamed notes.txt → meeting notes.txt' }).waitFor({ timeout: 10 * 60_000 })
  await dialog.waitFor({ state: 'detached' })
  await row('meeting notes.txt').waitFor({ timeout: 2 * 60_000 })
  const asked = (await page.locator('.activity li', { hasText: 'Asked your wallet to approve' }).first().textContent()) ?? ''
  const askedSecs = Number(/approve, ([\d.]+) s after your click/.exec(asked)?.[1] ?? NaN)
  check('Activity says when the wallet was asked (under 3 s after the click)', askedSecs >= 0 && askedSecs < 3, asked.trim())
  check('rename takes one transaction; the list shows the new name',
    txs - before === 1 && JSON.stringify(await names()) === JSON.stringify(['meeting notes.txt', LONG, 'todo.txt']), `${txs - before} tx, ${JSON.stringify(await names())}`)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  const rowFit = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    rename: Math.max(...[...document.querySelectorAll('table button[aria-label="Rename"]')].map((b) => Math.round(b.getBoundingClientRect().right))),
    cells: [...document.querySelector('table tbody tr').children].map((c) => `${c.className}:${Math.round(c.getBoundingClientRect().width)}`),
    table: Math.round(document.querySelector('table').getBoundingClientRect().width),
    wide: [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 8).map((e) => `${e.tagName}.${e.className}:${Math.round(e.getBoundingClientRect().right)}`),
  }))
  check('phone: every row fits, long names truncated', rowFit.overflow <= 0 && rowFit.rename <= 390, JSON.stringify(rowFit))
  const phoneBtns = await rowButtons()
  check('phone: file actions are icons only, ≥34 px', iconOnly(phoneBtns) && phoneBtns[0].w >= 34 && phoneBtns[0].h >= 34, JSON.stringify(phoneBtns))
  await page.setViewportSize({ width: 1280, height: 900 })

  await page.reload()
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  await row('meeting notes.txt').waitFor({ timeout: 5 * 60_000 })
  check('after reload, the new name comes back from the chain', JSON.stringify(await names()) === JSON.stringify(['meeting notes.txt', LONG, 'todo.txt']), JSON.stringify(await names()))

  await row('meeting notes.txt').locator('.fname-btn').click()
  await page.locator('.preview-text').waitFor({ timeout: 5 * 60_000 })
  check('the renamed file still opens (same content, nothing re-uploaded)',
    (await page.textContent('.preview-text')).startsWith('Meeting notes'))
  await page.keyboard.press('Escape')
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
