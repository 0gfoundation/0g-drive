// A change interrupted between its transaction and its upload, in the
// browser (headless Chromium + dev server), with an injected wallet backed
// by a FRESH key funded from .env's test wallet:
//   upload notes.txt, move it to trash
//   restore it with the storage nodes' segment uploads blocked: the
//   transaction lands, the data doesn't; closing the page now asks first
//   another browser (same keys, none of this device's saved data) opens
//   the drive: the restore is undone (notes.txt still in trash), and the
//   empty listing is given up after one pass, not retried for seconds
//   this browser opens again: the restore shows as done at once and its
//   data is sent with no new transaction
//   the other browser, reloaded, now reads the restored listing from 0G
// On-device AI is switched off, so no model download.
//
//   node scripts/test-interrupted-change.mjs [http://localhost:5173]
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
const sentTxs = [] // hashes, every browser
let blockSegments = false
const segmentUploadsBlocked = { n: 0 }

async function openBrowser(storageState) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, storageState })
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
          sentTxs.push(sent.hash)
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
  // the page "closing" before its data is sent: segment uploads fail
  await context.route('**/*', (route) => {
    const body = route.request().postData() ?? ''
    if (blockSegments && /zgs_uploadSegment/.test(body)) {
      segmentUploadsBlocked.n++
      return route.abort()
    }
    return route.continue()
  })
  return context
}

const openPage = async (context) => {
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  const warns = []
  page.on('console', (m) => warns.push(m.text()))
  return { page, warns }
}
const row = (page, name) => page.locator('table tr', { has: page.locator('.fname-btn', { hasText: name }) })
const activity = (page) => page.$$eval('.activity li', (els) => els.map((e) => e.textContent)).catch(() => [])
const inTrash = async (page) => {
  await page.locator('[data-guide="trash"]').click()
  await page.waitForTimeout(500)
  return page.$$eval('table .fname-btn', (els) => els.map((e) => e.textContent.trim()))
}

let ctxA, ctxB, a
try {
  ctxA = await openBrowser()
  a = await openPage(ctxA)
  await a.page.goto(base)
  await connectExtension(a.page)
  await a.page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await a.page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 120_000 })
  await a.page.setInputFiles('.dropzone input[type=file]', [
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Meeting notes: interrupted restore.') },
  ])
  await row(a.page, 'notes.txt').waitFor({ timeout: 8 * 60_000 })
  await row(a.page, 'notes.txt').getByRole('button', { name: 'Move to trash' }).click()
  await a.page.locator('.activity li', { hasText: 'notes.txt moved to trash' }).waitFor({ timeout: 10 * 60_000 })
  step('notes.txt uploaded and moved to trash')

  // restore, but its data never reaches the nodes
  await a.page.locator('[data-guide="trash"]').click()
  await row(a.page, 'notes.txt').waitFor({ timeout: 2 * 60_000 })
  blockSegments = true
  const before = sentTxs.length
  await row(a.page, 'notes.txt').getByRole('button', { name: 'Restore' }).click()
  const deadline = Date.now() + 5 * 60_000
  while (sentTxs.length === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500))
  const restoreTx = sentTxs[sentTxs.length - 1]
  const receipt = await provider.waitForTransaction(restoreTx)
  step(`restore transaction mined (status ${receipt.status}); waiting for its blocked upload`)
  while (segmentUploadsBlocked.n === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500))
  let asked = null
  a.page.once('dialog', async (d) => {
    asked = d.type()
    await d.accept()
  })
  await a.page.close({ runBeforeUnload: true })
  for (let i = 0; i < 20 && !a.page.isClosed(); i++) await new Promise((r) => setTimeout(r, 250))
  check('closing while the change is unsent asks first', asked === 'beforeunload', `dialog: ${asked}; ${segmentUploadsBlocked.n} segment uploads blocked`)
  blockSegments = false

  // another browser: same keys, none of this device's saved changes
  const state = await ctxA.storageState()
  ctxB = await openBrowser(state)
  const b = await openPage(ctxB)
  let t = Date.now()
  await b.page.goto(base)
  await b.page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 5 * 60_000 })
  await b.page.waitForFunction(() => !document.body.textContent.includes('Loading drive from 0G'), null, { timeout: 5 * 60_000 })
  const loadB = (Date.now() - t) / 1000
  const trashB = await inTrash(b.page)
  check('another browser: the restore is undone (notes.txt still in trash)', trashB.includes('notes.txt'), JSON.stringify(trashB))
  const gaveUp = b.warns.filter((w) => w.includes('no data was ever uploaded'))
  check(
    'another browser: the empty listing is given up after one pass over the nodes',
    gaveUp.length > 0 && !b.warns.some((w) => /segment not found/.test(w)),
    `drive loaded in ${loadB.toFixed(1)} s; ${gaveUp[0]?.slice(0, 160) ?? b.warns.filter((w) => w.includes('[drive]')).join(' | ').slice(0, 300)}`
  )

  // this browser again: finishes the restore from its saved copy
  const txsBefore = sentTxs.length
  a = await openPage(ctxA)
  t = Date.now()
  await a.page.goto(base)
  await row(a.page, 'notes.txt').waitFor({ timeout: 5 * 60_000 })
  const shownAfter = (Date.now() - t) / 1000
  check('this browser: the restore shows as done when the drive opens', true, `notes.txt in the drive after ${shownAfter.toFixed(1)} s`)
  await a.page.locator('.activity li', { hasText: 'Interrupted change: finished' }).waitFor({ timeout: 6 * 60_000 })
  const actA = await activity(a.page)
  check(
    "this browser: the change's data is sent with no new transaction",
    sentTxs.length === txsBefore,
    actA.filter((l) => l.includes('Interrupted change')).join(' | ')
  )
  const pendingLeft = await a.page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('0gdrive-pending')
        req.onsuccess = () => {
          const all = req.result.transaction('writes').objectStore('writes').getAll()
          all.onsuccess = () => resolve(all.result.length)
        }
        req.onerror = () => resolve(-1)
      })
  )
  check('nothing is left saved on the device once stored', pendingLeft === 0, `${pendingLeft} saved`)
  // nothing unsent now: closing doesn't ask
  let askedAgain = null
  a.page.once('dialog', async (d) => {
    askedAgain = d.type()
    await d.accept()
  })
  await a.page.close({ runBeforeUnload: true })
  await new Promise((r) => setTimeout(r, 1000))
  check('closing with nothing unsent does not ask', askedAgain === null, `dialog: ${askedAgain}`)

  // the other browser reads the finished listing from 0G
  await b.page.reload()
  await b.page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 5 * 60_000 })
  await b.page.locator('.nav .nav-item', { hasText: 'My Drive' }).first().click()
  const ok = await row(b.page, 'notes.txt').waitFor({ timeout: 5 * 60_000 }).then(() => true, () => false)
  const trashB2 = await inTrash(b.page)
  check('another browser, reloaded: notes.txt is restored, read from 0G', ok && !trashB2.includes('notes.txt'), JSON.stringify(trashB2))
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
