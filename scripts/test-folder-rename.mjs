// Folder rename, in the browser (headless Chromium + dev server), with an
// injected wallet backed by a FRESH key funded from .env's test wallet.
// Makes Work/2025 (with a file) and Docs, opens Work/2025, then renames
// Work from the sidebar:
//   the whole name is pre-selected
//   a sibling's name (any case), "/" and the reserved trash name are refused
//   the rename takes ONE transaction; the open folder follows to the new path
//   the subfolder and its file survive a reload, and the file still opens
//   phone width: the tree's buttons fit the drawer, the dialog fits the screen
// On-device AI is switched off, so no model download.
//
//   node scripts/test-folder-rename.mjs [http://localhost:5173]
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
const dialog = page.locator('.rename-modal')
const input = dialog.getByRole('textbox', { name: 'New name' })
const submit = dialog.getByRole('button', { name: 'Rename' })
let promptAnswer = ''
page.on('dialog', (d) => d.accept(promptAnswer))
const newFolder = async (name) => {
  promptAnswer = name
  await page.getByRole('button', { name: '+ New folder' }).click()
  await treeRow(name).waitFor({ timeout: 5 * 60_000 })
}

try {
  await page.goto(base)
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 120_000 })
  await newFolder('Docs')
  await newFolder('Work')
  await treeRow('Work').locator('.tree-label').click()
  await newFolder('2025')
  await treeRow('2025').locator('.tree-label').click()
  await page.setInputFiles('.dropzone input[type=file]', [
    { name: 'report.txt', mimeType: 'text/plain', buffer: Buffer.from('Annual report: folders renamed.') },
  ])
  await page.locator('table .fname-btn', { hasText: 'report.txt' }).waitFor({ timeout: 8 * 60_000 })
  step(`folders made, report.txt uploaded; open: ${await crumbs()}`)

  await treeRow('Work').getByRole('button', { name: 'Rename folder' }).click()
  await input.waitFor()
  const sel = await input.evaluate((i) => [i.selectionStart, i.selectionEnd, i.value])
  check('dialog opens with the whole name selected', sel[0] === 0 && sel[1] === 4 && sel[2] === 'Work', JSON.stringify(sel))

  const refused = {}
  for (const bad of ['docs', 'a/b', '__trash__']) {
    await input.fill(bad)
    refused[bad] = {
      disabled: await submit.isDisabled(),
      error: (await dialog.locator('.error-text').textContent().catch(() => '')).trim(),
    }
  }
  check('a sibling folder’s name (other case) is refused',
    refused.docs.disabled && /already a folder named “Docs”/.test(refused.docs.error), JSON.stringify(refused.docs))
  check('"/" and the reserved trash name are refused',
    refused['a/b'].disabled && /“\/”/.test(refused['a/b'].error) && refused.__trash__.disabled && /reserved/.test(refused.__trash__.error),
    JSON.stringify([refused['a/b'], refused.__trash__]))

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  const phoneDialog = await page.evaluate(() => {
    const m = document.querySelector('.rename-modal').getBoundingClientRect()
    const btns = [...document.querySelectorAll('.rename-modal .modal-actions .btn')].map((b) => Math.round(b.getBoundingClientRect().height))
    return { overflow: document.documentElement.scrollWidth - window.innerWidth, left: Math.round(m.left), right: Math.round(m.right), btns }
  })
  check('phone: dialog inside the screen, ≥44 px buttons, no overflow',
    phoneDialog.overflow <= 0 && phoneDialog.left >= 0 && phoneDialog.right <= 390 && phoneDialog.btns.every((h) => h >= 44), JSON.stringify(phoneDialog))
  await page.setViewportSize({ width: 1280, height: 900 })

  await input.fill('Projects')
  const before = txs
  await submit.click()
  await page.locator('.activity li', { hasText: 'Renamed folder Work → Projects' }).waitFor({ timeout: 10 * 60_000 })
  await dialog.waitFor({ state: 'detached' })
  await treeRow('Projects').waitFor({ timeout: 2 * 60_000 })
  await page.locator('table .fname-btn', { hasText: 'report.txt' }).waitFor({ timeout: 2 * 60_000 })
  const after = { txs: txs - before, tree: await treeNames(), crumbs: await crumbs() }
  check('rename takes one transaction; the open folder follows to Projects/2025',
    after.txs === 1 && JSON.stringify(after.tree.sort()) === '["2025","Docs","Projects"]' && after.crumbs === 'My drive/Projects/2025',
    JSON.stringify(after))

  // phone: the drawer's tree rows fit, with touch-sized buttons
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Folders and settings' }).click()
  await page.waitForTimeout(400)
  const drawer = await page.evaluate(() => {
    const side = document.querySelector('.sidebar').getBoundingClientRect()
    const acts = [...document.querySelectorAll('.sidebar .tree-row .tree-act')].map((b) => {
      const r = b.getBoundingClientRect()
      return { right: Math.round(r.right), w: Math.round(r.width) }
    })
    return { overflow: document.documentElement.scrollWidth - window.innerWidth, side: Math.round(side.right), acts }
  })
  check('phone: tree rows and their buttons fit the drawer',
    drawer.overflow <= 0 && drawer.acts.length > 0 && drawer.acts.every((a) => a.right <= drawer.side && a.right <= 390), JSON.stringify(drawer))
  await page.getByRole('button', { name: 'Folders and settings' }).click({ force: true }).catch(() => {})
  await page.setViewportSize({ width: 1280, height: 900 })

  await page.reload()
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  await treeRow('Projects').waitFor({ timeout: 5 * 60_000 })
  await treeRow('Projects').locator('.tree-label').click()
  await treeRow('2025').locator('.tree-label').click()
  await page.locator('table .fname-btn', { hasText: 'report.txt' }).click({ timeout: 5 * 60_000 })
  await page.locator('.preview-text').waitFor({ timeout: 5 * 60_000 })
  check('after reload: Projects/2025 holds the file, and it opens',
    !(await treeNames()).includes('Work') && (await page.textContent('.preview-text')).startsWith('Annual report'),
    JSON.stringify(await treeNames()))
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
