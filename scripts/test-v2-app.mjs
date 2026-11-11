// The app on 0G Storage V2, in headless Chromium with an injected wallet (a
// fresh key funded from .env's test wallet for gas): create the drive
// (3 signatures, 1 deposit), a folder and uploads with no wallet prompt,
// preview, a share link read with no account, a recovery password, a
// deposit, a second device restoring with one signature, the drive opened
// read-only with its password and no wallet, delete forever, and the new
// setup and storage UI at 390 px. Every file of the drive is deleted at
// the end and the wallet refunded.
//
//   node scripts/test-v2-app.mjs [http://localhost:5173]
import { chromium } from 'playwright'
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectExtension } from './lib/connect.mjs'
import { refund } from './lib/refund.mjs'
import { RelayerClient, V2_TESTNET, deriveStorageKey, downloadV2, hexToBytes, parseShareLink } from '../core/dist/index.js'

const base = process.argv[2] ?? 'http://localhost:5173'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const funderKey = /^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(readFileSync(resolve(root, '.env'), 'utf8'))[1]
const provider = new ethers.JsonRpcProvider(V2_TESTNET.rpc)
const t0 = Date.now()
const el = () => `[${((Date.now() - t0) / 1000).toFixed(0)}s]`
const step = (m) => console.log(`${el()} ${m}`)
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${el()} ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const FUNDING = ethers.parseEther(process.env.V2_FUNDING ?? '2')
const wallet = ethers.Wallet.createRandom().connect(provider)
const funder = new ethers.Wallet(funderKey, provider)
await (await funder.sendTransaction({ to: wallet.address, value: FUNDING })).wait()
step(`fresh wallet ${wallet.address} funded with ${ethers.formatEther(FUNDING)} 0G (gas)`)

const prompts = { tx: 0, sign: 0 }
async function rpc(method, params) {
  switch (method) {
    case 'eth_requestAccounts':
    case 'eth_accounts':
      return [wallet.address]
    case 'eth_chainId':
      return '0x' + V2_TESTNET.chainId.toString(16)
    case 'net_version':
      return String(V2_TESTNET.chainId)
    case 'wallet_switchEthereumChain':
    case 'wallet_addEthereumChain':
      return null
    case 'personal_sign': {
      prompts.sign++
      const [data] = params
      return wallet.signMessage(ethers.isHexString(data) ? ethers.getBytes(data) : data)
    }
    case 'eth_sendTransaction': {
      prompts.tx++
      const [tx] = params
      const sent = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n, gasLimit: tx.gas ? BigInt(tx.gas) : undefined })
      return sent.hash
    }
    default:
      return provider.send(method, params ?? [])
  }
}

const browser = await chromium.launch()
const errors = []
/** A page in its own context (a separate device: its own localStorage), with or without the wallet. */
async function device({ width = 1280, withWallet = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 } })
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('dialog', (d) => {
    const m = d.message()
    if (d.type() === 'prompt') return d.accept(m.startsWith('New folder') ? 'Recipes' : m.startsWith('Deposit') ? '0.05' : undefined)
    return d.accept()
  })
  if (withWallet) {
    await page.exposeFunction('__eth', async (method, params) => {
      try {
        return { ok: await rpc(method, params) }
      } catch (e) {
        return { err: e.shortMessage ?? e.message }
      }
    })
    await page.addInitScript(() => {
      const listeners = {}
      window.ethereum = {
        isMetaMask: true,
        async request({ method, params }) {
          const r = await window.__eth(method, params)
          if (r.err) throw Object.assign(new Error(r.err), { code: -32000 })
          return r.ok
        },
        on(ev, fn) {
          ;(listeners[ev] ??= []).push(fn)
        },
        removeListener() {},
      }
    })
  }
  return { context, page }
}

const storageRow = (page) => page.locator('.sec-row[data-row="storage"] .sec-status')
const balanceOf = async (page) => Number((await storageRow(page).textContent()).replace(/[^0-9.]/g, ''))
const row = (page, name) => page.locator('table tr', { has: page.locator('.fname-btn', { hasText: name }) })

async function uploadAndWait(page, files) {
  await page.setInputFiles('.dropzone input[type=file]', files)
  await page.waitForFunction(
    (names) => {
      const rows = [...document.querySelectorAll('.queue-item')]
      return names.every((n) => rows.some((r) => r.textContent.includes(n) && /in your drive|✗/.test(r.textContent)))
    },
    files.map((f) => f.name),
    { timeout: 8 * 60_000, polling: 1000 }
  )
  const failed = await page.$$eval('.queue-item', (rows) => rows.filter((r) => r.textContent.includes('✗')).map((r) => r.textContent))
  if (failed.length) throw new Error(`upload failed: ${failed.join(' | ')}`)
  for (const f of files) await row(page, f.name).waitFor({ timeout: 3 * 60_000 })
}

let masterKeyHex = null
let page
try {
  // ── device 1: create the drive ──
  ;({ page } = await device())
  await page.goto(base)
  await connectExtension(page)
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 5 * 60_000 })
  check('drive created: 3 signatures, 1 deposit transaction', prompts.sign === 3 && prompts.tx === 1, `${prompts.sign} signatures, ${prompts.tx} tx`)
  masterKeyHex = await page.evaluate((a) => localStorage.getItem('0gdrive:masterkey:' + a.toLowerCase()), wallet.address)
  await page.waitForFunction(() => /[0-9]/.test(document.querySelector('.sec-row[data-row="storage"] .sec-status')?.textContent ?? ''), null, { timeout: 60_000 })
  const firstBalance = await balanceOf(page)
  check('storage balance shown after setup', firstBalance > 0.05 && firstBalance <= 0.1, `${firstBalance} 0G`)

  let p0 = { ...prompts }
  await page.getByRole('button', { name: '+ New folder' }).click()
  await page.locator('.sidebar .tree-name', { hasText: 'Recipes' }).waitFor({ timeout: 2 * 60_000 })
  await page.locator('.sidebar .tree-name', { hasText: 'Recipes' }).click()
  await page.locator('.breadcrumb', { hasText: 'Recipes' }).waitFor()
  await uploadAndWait(page, [
    { name: 'pancakes.md', mimeType: 'text/markdown', buffer: Buffer.from('Fluffy pancakes: 200g flour, 2 eggs, 300ml milk.') },
    { name: 'ramen.txt', mimeType: 'text/plain', buffer: Buffer.from('拉面做法:猪骨熬汤八小时。') },
  ])
  check('a folder and 2 uploads with no wallet prompt', prompts.tx === p0.tx && prompts.sign === p0.sign, `${prompts.tx - p0.tx} tx, ${prompts.sign - p0.sign} signatures`)

  await row(page, 'pancakes.md').locator('.fname-btn').click()
  await page.locator('.preview-text').waitFor({ timeout: 2 * 60_000 })
  check('preview downloads and decrypts', (await page.textContent('.preview-text')).startsWith('Fluffy pancakes'))
  await page.keyboard.press('Escape')

  // a share link, opened with nothing but the link
  await row(page, 'ramen.txt').getByRole('button', { name: 'Share' }).click()
  await page.getByRole('button', { name: 'Create link' }).click()
  const link = await page.locator('.share-link-box input').inputValue({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Close' }).click()
  const payload = parseShareLink(new URL(link).hash)?.payload
  const sharedBytes = await downloadV2(new RelayerClient(V2_TESTNET), payload.r, { decryption: { symmetricKey: payload.k } })
  check('a share link reads with no account', new TextDecoder().decode(sharedBytes.data) === '拉面做法:猪骨熬汤八小时。', payload?.r?.[0])

  // a recovery password: saved with the drive, no prompt
  p0 = { ...prompts }
  await page.locator('.sec-row[data-row="password"] button').click()
  const pw = page.locator('.modal input[type="password"]')
  await pw.nth(0).fill('correct horse battery staple')
  await pw.nth(1).fill('correct horse battery staple')
  await page.locator('.modal button[type="submit"]').click()
  await page.locator('.sec-row[data-row="password"] .sec-status', { hasText: 'Set' }).waitFor({ timeout: 2 * 60_000 })
  check('recovery password set with no wallet prompt', prompts.tx === p0.tx && prompts.sign === p0.sign)

  // a deposit: one transaction
  p0 = { ...prompts }
  const before = await balanceOf(page)
  await page.locator('.sec-row[data-row="storage"] button').click()
  await page.waitForFunction((b) => {
    const n = Number((document.querySelector('.sec-row[data-row="storage"] .sec-status')?.textContent ?? '').replace(/[^0-9.]/g, ''))
    return n > b + 0.04
  }, before, { timeout: 3 * 60_000 })
  check('deposit: 1 transaction, balance up by 0.05', prompts.tx === p0.tx + 1, `${before} → ${await balanceOf(page)} 0G`)

  // ── device 2: the same wallet, nothing on the device ──
  const d2 = await device()
  await d2.page.goto(base)
  await connectExtension(d2.page)
  p0 = { ...prompts }
  await d2.page.getByRole('button', { name: 'Restore my drive' }).click({ timeout: 2 * 60_000 })
  await d2.page.locator('.sidebar .tree-name', { hasText: 'Recipes' }).waitFor({ timeout: 3 * 60_000 })
  check('a second device restores with one signature', prompts.sign === p0.sign + 1 && prompts.tx === p0.tx, `${prompts.sign - p0.sign} signature(s)`)
  await d2.page.locator('.sidebar .tree-name', { hasText: 'Recipes' }).click()
  await row(d2.page, 'ramen.txt').waitFor({ timeout: 2 * 60_000 })
  check('…and sees the files', true)
  await d2.context.close()

  // ── device 3: no wallet, the address and the password ──
  const d3 = await device({ withWallet: false })
  await d3.page.goto(base)
  await d3.page.getByRole('button', { name: 'Open your drive with its recovery password' }).click()
  await d3.page.fill('input[placeholder^="drive\'s wallet address"]', wallet.address)
  await d3.page.fill('input[placeholder="recovery password"]', 'correct horse battery staple')
  await d3.page.getByRole('button', { name: 'Open drive' }).click()
  await d3.page.locator('.sidebar .tree-name', { hasText: 'Recipes' }).waitFor({ timeout: 3 * 60_000 })
  check('no wallet: opened read-only with the password', (await d3.page.textContent('body')).includes('Read-only.'))
  await d3.context.close()

  // ── delete forever: the file is deleted from 0G ──
  const ref = payload.r[0].replace(/^0x/, '')
  await row(page, 'ramen.txt').getByRole('button', { name: 'Move to trash' }).click()
  await page.locator('.activity li', { hasText: 'ramen.txt moved to trash' }).waitFor({ timeout: 2 * 60_000 })
  await page.locator('[data-guide="trash"]').click()
  await row(page, 'ramen.txt').getByRole('button', { name: 'Delete forever' }).click()
  await page.locator('.activity li', { hasText: 'ramen.txt deleted forever' }).waitFor({ timeout: 2 * 60_000 })
  await page.waitForTimeout(8000)
  const account = deriveStorageKey(hexToBytes(masterKeyHex))
  const left = (await new RelayerClient(V2_TESTNET).list(account.address, { limit: 100 })).files.map((f) => f.dataHash.replace(/^0x/, ''))
  check('delete forever deletes the file from 0G', !left.includes(ref), `${left.length} files left`)

  // ── 390 px: the new setup banner and storage row fit a phone ──
  const phone = await device({ width: 390 })
  await phone.page.goto(base)
  await connectExtension(phone.page)
  await phone.page.getByRole('button', { name: 'Restore my drive' }).waitFor({ timeout: 2 * 60_000 })
  const bannerFits = await phone.page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth)
  await phone.page.getByRole('button', { name: 'Restore my drive' }).click()
  await phone.page.locator('.sidebar .tree-name', { hasText: 'Recipes' }).waitFor({ state: 'attached', timeout: 3 * 60_000 })
  // the sidebar is a drawer on phones: open it, then the storage row must be on screen
  await phone.page.locator('.nav-toggle').click()
  await phone.page.locator('.sec-row[data-row="storage"]').waitFor({ state: 'visible', timeout: 60_000 })
  await phone.page.waitForTimeout(500) // the drawer slides in
  const storage = await phone.page.evaluate(() => {
    // the row is display: contents (its cells sit in the Security grid): measure the cells
    const cells = [...document.querySelectorAll('.sec-row[data-row="storage"] > span')].map((c) => c.getBoundingClientRect())
    const btn = document.querySelector('.sec-row[data-row="storage"] button').getBoundingClientRect()
    return {
      left: Math.min(...cells.map((c) => c.left)),
      right: Math.max(...cells.map((c) => c.right)),
      rowWidth: Math.max(...cells.map((c) => c.right)) - Math.min(...cells.map((c) => c.left)),
      button: btn.right,
      width: window.innerWidth,
      scroll: document.scrollingElement.scrollWidth,
    }
  })
  check(
    '390 px: the restore banner and the storage row (with Deposit) fit, no horizontal scroll',
    bannerFits && storage.rowWidth > 0 && storage.left >= 0 && storage.right <= storage.width && storage.button <= storage.width && storage.scroll <= storage.width,
    JSON.stringify(storage)
  )
  await phone.context.close()
} catch (err) {
  check('run completed', false, err.message.split('\n')[0])
  const a = await page?.$$eval('.activity li', (els) => els.slice(0, 15).map((e) => e.textContent)).catch(() => [])
  console.log('activity:\n  ' + (a ?? []).join('\n  '))
} finally {
  if (masterKeyHex) {
    const account = deriveStorageKey(hexToBytes(masterKeyHex))
    const r = new RelayerClient(V2_TESTNET)
    const files = (await r.list(account.address, { limit: 100 }).catch(() => ({ files: [] }))).files
    for (const f of files) await r.delete(account, f.dataHash).catch(() => undefined)
    step(`deleted the drive's ${files.length} files`)
  }
  await browser.close()
  await refund(wallet, funder.address)
}

if (errors.length) console.log('page errors:\n  ' + errors.join('\n  '))
const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} checks passed`)
process.exit(passed === results.length && results.length > 0 ? 0 : 1)
