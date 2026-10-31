// Browser timing: from a click to the wallet's eth_sendTransaction, with
// every request in between (page network + injected-wallet calls).
// Usage: node scripts/time-wallet-prompt-browser.mjs [url]
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
const inner = async (method, params) => {
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
        mark('WALLET eth_sendTransaction  <== prompt')
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
}
await page.exposeFunction('__eth', async (method, params) => {
  const s = performance.now()
  const r = await inner(method, params)
  if (method !== 'eth_sendTransaction') mark(`wallet ${method}`, s)
  return r
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

const dialog = page.locator('.rename-modal')
let T = null, events = []
function mark(what, start) {
  if (T === null) return
  const now = performance.now()
  events.push(start === undefined ? `${String(Math.round(now - T)).padStart(6)}ms  ${what}` :
    `${String(Math.round(start - T)).padStart(6)}ms +${String(Math.round(now - start)).padStart(5)}ms  ${what}`)
}
page.on('requestfinished', (req) => {
  if (T === null) return
  const t = req.timing()
  let what = req.url().replace(/^https?:\/\//, '').slice(0, 50)
  try { const b = JSON.parse(req.postData() ?? 'null'); const m = (Array.isArray(b) ? b : [b]).map((x) => x?.method).filter(Boolean); if (m.length) what += ' ' + m.join(',') } catch {}
  events.push(`  page ${what}  (${Math.round(t.responseEnd)}ms)`)
})
async function timed(label, act) {
  const before = txs
  events = []; T = performance.now()
  await act()
  const deadline = Date.now() + 5 * 60_000
  while (txs === before && Date.now() < deadline) await page.waitForTimeout(50)
  const first = events.findIndex((e) => e.includes('<== prompt'))
  console.log(`\n== ${label}`)
  console.log(events.slice(0, first + 1).join('\n'))
  T = null
}

try {
  await page.goto(base)
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 120_000 })
  await newFolder('Docs')
  await upload([['a.txt', 'alpha']])
  step('set up')
  await page.waitForTimeout(3000)

  await timed('new folder', async () => {
    promptAnswer = 'Work'
    await page.getByRole('button', { name: '+ New folder' }).click()
  })
  await treeRow('Work').first().waitFor({ timeout: 5 * 60_000 })
  await page.waitForFunction(() => !document.querySelector('.busy, [aria-busy="true"]'), null, { timeout: 5 * 60_000 }).catch(() => {})
  await page.waitForTimeout(8000)

  await treeRow('Work').getByRole('button', { name: 'Rename folder' }).click()
  await dialog.getByRole('textbox', { name: 'New name' }).fill('Work2')
  await timed('rename folder', () => dialog.getByRole('button', { name: 'Rename' }).click())
  await treeRow('Work2').first().waitFor({ timeout: 5 * 60_000 })
  await page.waitForTimeout(8000)

  await timed('upload a small file', () => upload([['b.txt', 'beta']]).catch(() => {}))
} finally {
  await browser.close()
  await refund(wallet, funder.address)
}
