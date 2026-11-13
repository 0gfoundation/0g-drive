// Trash and real deletion, in the browser (headless Chromium + dev server),
// with an injected wallet backed by a FRESH key funded from .env's test
// wallet (the V2 drive's setup deposit and gas, 3 small uploads; files
// deleted and wallet refunded at the end). Checks: Trash says files go
// after 30 days and each shows its days left; "Delete forever" on a
// selection and "Empty trash" warn first, empty the trash, and delete the
// files' bytes from 0G; the daily leftover sweep runs after the drive opens;
// 390 px.
//
//   node scripts/test-trash.mjs [http://localhost:5173]
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

const strip = (h) => h.replace(/^0x/i, '').toLowerCase()
let account = null
const storedHashes = async () => {
  const out = new Set()
  for (let before; ; ) {
    const page = await new RelayerClient(V2_TESTNET).list(account.address, { limit: 100, before })
    page.files.forEach((f) => out.add(strip(f.dataHash)))
    if (!page.next || page.files.length === 0) return out
    before = page.next
  }
}
/** Until none of `hashes` is stored (deletes run in the background), or 60 s; those left. */
async function goneSoon(hashes) {
  const end = Date.now() + 60_000
  for (;;) {
    const now = await storedHashes()
    const left = hashes.filter((h) => now.has(h))
    if (!left.length || Date.now() > end) return left
    await page.waitForTimeout(3000)
  }
}
const dialogs = []
page.on('dialog', (d) => {
  dialogs.push(d.message())
  d.accept()
})
const NAMES = ['one.txt', 'two.txt', 'three.txt']

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
  account = deriveStorageKey(hexToBytes(masterKeyHex))

  await page.setInputFiles('.dropzone input[type=file]', NAMES.map((name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(`${name}\n`) })))
  await page.waitForFunction((names) => names.every((n) => [...document.querySelectorAll('table .fname-btn')].some((b) => b.textContent.includes(n))), NAMES, { timeout: 8 * 60_000, polling: 2000 })
  // the uploads' data hashes, from the drive's own listing on 0G (read here with its key)
  const mk = hexToBytes(masterKeyHex)
  const nodeDrive = await new DriveStore(new V2Backend(new RelayerClient(V2_TESTNET), deriveStorageKey(mk), mk)).loadDrive()
  const hashOf = Object.fromEntries((nodeDrive.folders.get('')?.files ?? []).map((f) => [f.name, strip(f.rootHashes[0])]))
  const stored = await storedHashes()
  check('3 files uploaded and stored', NAMES.every((n) => hashOf[n] && stored.has(hashOf[n])), JSON.stringify(hashOf))
  // all three to trash
  await page.locator('table thead input[type=checkbox]').check()
  await page.getByRole('button', { name: 'Trash selected' }).click()
  await page.locator('.empty, .hero').first().waitFor({ timeout: 3 * 60_000 })
  await page.locator('[data-guide="trash"]').click()
  await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 3, null, { timeout: 60_000 })

  const view = await page.evaluate(() => ({
    note: document.querySelector('.trash-note')?.textContent ?? null,
    rows: [...document.querySelectorAll('table tbody tr')].map((r) => r.textContent),
    empty: !!document.querySelector('.toolbar-actions .btn.danger') && [...document.querySelectorAll('.toolbar-actions button')].some((b) => b.textContent.trim() === 'Empty trash'),
  }))
  check('Trash says files are deleted forever after 30 days', view.note === 'Files in trash are deleted forever after 30 days.', JSON.stringify(view.note))
  check('each trashed file shows “30 days left”', view.rows.length === 3 && view.rows.every((t) => t.includes('30 days left')), JSON.stringify(view.rows))
  check('an “Empty trash” button', view.empty)

  // delete forever: one selected file
  await page.locator('table tbody tr', { hasText: 'one.txt' }).locator('input[type=checkbox]').check()
  await page.locator('.sel-bar').getByRole('button', { name: 'Delete forever' }).click()
  await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 2, null, { timeout: 3 * 60_000 })
  check('“Delete forever” on a selection warns first, then removes it', /Delete 1 file forever\? It is deleted from 0G Storage/.test(dialogs.at(-1) ?? ''), JSON.stringify(dialogs.at(-1)))
  check('…and its bytes are deleted from 0G', (await goneSoon([hashOf['one.txt']])).length === 0)

  // empty trash
  await page.getByRole('button', { name: 'Empty trash' }).click()
  await page.locator('.empty', { hasText: 'Trash is empty.' }).waitFor({ timeout: 3 * 60_000 })
  check('“Empty trash” warns first, then empties it', /Empty trash: delete 2 files forever\?/.test(dialogs.at(-1) ?? ''), JSON.stringify(dialogs.at(-1)))

  const left = await goneSoon([hashOf['two.txt'], hashOf['three.txt']])
  check('…and their bytes are deleted from 0G', left.length === 0, `${left.length} still stored`)

  // the daily leftover sweep ran after the drive opened (nothing to delete here)
  await page.waitForFunction((a) => !!localStorage.getItem('0gdrive:swept:' + a.toLowerCase()), wallet.address, { timeout: 90_000 })
  check('the leftover sweep ran after the drive opened', true)

  // 390 px: the trash note fits
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(400)
  const phone = await page.evaluate(() => ({
    note: (() => {
      const r = document.querySelector('.trash-note')?.getBoundingClientRect()
      return r ? r.right <= 390 && r.left >= 0 : false
    })(),
    scroll: document.documentElement.scrollWidth - window.innerWidth,
  }))
  check('390 px: the trash note fits, no horizontal scroll', phone.note && phone.scroll <= 0, JSON.stringify(phone))
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
