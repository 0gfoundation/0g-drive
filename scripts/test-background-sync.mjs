// Background sync: a drive open on one device shows changes made on another
// within about 30 s, with no Sync click, in the browser (headless Chromium +
// dev server), two devices on one drive, with an injected wallet backed by a
// FRESH key funded from .env's test wallet (the V2 drive's setup deposit and
// gas, folders and one small upload; files deleted and wallet refunded at the
// end).
// Asked by the user: Sync was the only way to see another device's changes.
// Device B, sitting in a folder, sees A's new folder and upload, follows its
// folder when A renames it, holds off while a dialog is open, makes no check
// while its tab is hidden and catches up on coming back, makes few requests
// when nothing changes, and at 390 px updates with nothing overflowing.
//
//   node scripts/test-background-sync.mjs [http://localhost:5173]
import { chromium } from 'playwright'
import { answerAsks } from './lib/ask.mjs'
import { connectExtension } from './lib/connect.mjs'
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getNetworkConfig, RelayerClient, V2_TESTNET, deriveStorageKey, hexToBytes } from '../core/dist/index.js'
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
/** A device: its own context (its own localStorage), the same wallet. */
async function device(width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 900 } })
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
    localStorage.setItem('0gdrive:smart-search', 'off')
    localStorage.setItem('0gdrive:layout', 'list')
    // a tab the test can hide, as a browser does when you switch tabs
    let hidden = false
    Object.defineProperty(document, 'visibilityState', { get: () => (hidden ? 'hidden' : 'visible'), configurable: true })
    Object.defineProperty(document, 'hidden', { get: () => hidden, configurable: true })
    window.__setHidden = (h) => {
      hidden = h
      document.dispatchEvent(new Event('visibilitychange'))
    }
  })
  return { context, page }
}

const treeRow = (page, name) => page.locator('.sidebar .tree-row', { has: page.locator('.tree-name', { hasText: new RegExp(`^${name}$`) }) })
const row = (page, name) => page.locator('table tr', { has: page.locator('.fname-btn', { hasText: name }) })
let folderName = ''
async function newFolder(page, name) {
  folderName = name
  await page.getByRole('button', { name: '+ New folder' }).click()
  await treeRow(page, name).waitFor({ timeout: 5 * 60_000 })
}
async function upload(page, name) {
  await page.setInputFiles('.dropzone input[type=file]', [{ name, mimeType: 'text/plain', buffer: Buffer.from(`${name}\n`) }])
  await row(page, name).waitFor({ timeout: 5 * 60_000 })
}
/** seconds until `locator` shows on device B, or null after `ms` */
async function shownWithin(locator, ms) {
  const start = Date.now()
  return locator.waitFor({ timeout: ms }).then(() => Math.round((Date.now() - start) / 1000), () => null)
}
const SYNC_WAIT = 75_000 // the 30 s check, plus 0G Storage listing the new version

let masterKeyHex = null
try {
  // ── device A: create the drive, a folder ──
  const A = await device()
  answerAsks(A.page, (q) => (q.title === 'New folder' ? folderName : true))
  await A.page.goto(base)
  await connectExtension(A.page)
  await A.page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await A.page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 5 * 60_000 })
  masterKeyHex = await A.page.evaluate((a) => localStorage.getItem('0gdrive:masterkey:' + a.toLowerCase()), wallet.address)
  await newFolder(A.page, 'Work')
  step('device A: drive and folder Work')

  // ── device B: the same drive, sitting in Work ──
  const B = await device()
  await B.context.addInitScript(([a, k]) => localStorage.setItem('0gdrive:masterkey:' + a.toLowerCase(), k), [wallet.address, masterKeyHex])
  const account = deriveStorageKey(hexToBytes(masterKeyHex)).address.toLowerCase()
  let lists = 0
  B.page.on('request', (r) => r.url().toLowerCase().includes(`/v1/users/${account}/files`) && lists++)
  await B.page.goto(base)
  await connectExtension(B.page)
  await treeRow(B.page, 'Work').waitFor({ timeout: 5 * 60_000 })
  await treeRow(B.page, 'Work').click()
  await B.page.locator('.breadcrumb', { hasText: 'Work' }).waitFor()
  await B.page.evaluate(() => {
    window.__syncBanner = false
    new MutationObserver(() => {
      if (document.body.textContent.includes('Syncing drive from chain')) window.__syncBanner = true
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
  })
  step('device B: open in Work')

  // nothing changes: one request per check (after opening's housekeeping, which lists the account's files once)
  await B.page.waitForTimeout(30_000)
  const quiet0 = lists
  await B.page.waitForTimeout(75_000)
  check('nothing changed: B checks every 30 s, one request each', lists - quiet0 >= 2 && lists - quiet0 <= 3, `${lists - quiet0} list requests in 75 s`)

  // A: a new folder and an upload at the top
  await A.page.locator('.crumb').first().click()
  await newFolder(A.page, 'Later')
  await upload(A.page, 'fresh.txt')
  const sLater = await shownWithin(treeRow(B.page, 'Later'), SYNC_WAIT)
  const acts = await B.page.locator('.activity li', { hasText: 'Updated with changes from another device' }).count()
  check('B shows A’s new folder by itself, no Sync click', sLater !== null && acts > 0, `${sLater}s, ${acts} activity line(s)`)
  check('…still in its open folder, with no “Syncing” banner',
    (await B.page.locator('.breadcrumb').textContent()).includes('Work') && !(await B.page.evaluate(() => window.__syncBanner)))
  await B.page.locator('.crumb').first().click()
  check('…and A’s upload is there', (await shownWithin(row(B.page, 'fresh.txt'), 10_000)) !== null)
  await treeRow(B.page, 'Work').click()

  // A renames Work: B follows it
  await treeRow(A.page, 'Work').getByRole('button', { name: /Rename/ }).click()
  const renameInput = A.page.locator('.rename-modal input')
  await renameInput.fill('Work 2026')
  await A.page.locator('.rename-modal').getByRole('button', { name: 'Rename' }).click()
  await treeRow(A.page, 'Work 2026').waitFor({ timeout: 5 * 60_000 })
  const sRen = await shownWithin(B.page.locator('.breadcrumb', { hasText: 'Work 2026' }), SYNC_WAIT)
  check('A renames the folder B has open: B follows it to the new name', sRen !== null, `${sRen}s`)

  // a dialog open on B: no update under it
  await B.page.getByRole('button', { name: '+ New folder' }).click()
  await B.page.locator('.ask-modal').waitFor()
  await newFolder(A.page, 'During')
  await B.page.waitForTimeout(SYNC_WAIT)
  check('with a dialog open on B, its view doesn’t change', (await treeRow(B.page, 'During').count()) === 0 && (await B.page.locator('.ask-modal').count()) === 1)
  await B.page.keyboard.press('Escape')
  const sAfter = await shownWithin(treeRow(B.page, 'During'), 45_000)
  check('…and it catches up once the dialog is closed', sAfter !== null, `${sAfter}s`)

  // B's tab hidden: no checks; back: it catches up at once
  await B.page.evaluate(() => window.__setHidden(true))
  await B.page.waitForTimeout(2000)
  const hidden0 = lists
  await newFolder(A.page, 'Hidden')
  await B.page.waitForTimeout(65_000)
  check('B’s tab hidden: no requests, no update', lists === hidden0 && (await treeRow(B.page, 'Hidden').count()) === 0, `${lists - hidden0} requests`)
  await B.page.evaluate(() => window.__setHidden(false))
  const sBack = await shownWithin(treeRow(B.page, 'Hidden'), 20_000)
  check('…back on the tab, it checks at once and shows the change', sBack !== null, `${sBack}s`)

  // phone width
  await B.page.setViewportSize({ width: 390, height: 844 })
  await newFolder(A.page, 'Phone')
  await B.page.waitForFunction(() => [...document.querySelectorAll('.sidebar .tree-name')].some((n) => n.textContent === 'Phone'), null, { timeout: SYNC_WAIT })
  const fit = await B.page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth - innerWidth,
    crumb: document.querySelector('.breadcrumb')?.textContent,
  }))
  check('390 px: updates there too, open folder kept, no sideways scroll', fit.scroll <= 0 && fit.crumb.includes('Work 2026'), JSON.stringify(fit))
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
