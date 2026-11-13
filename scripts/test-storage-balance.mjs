// The storage balance in the sidebar, in the browser (headless Chromium +
// dev server), with an injected wallet backed by a FRESH key funded from
// .env's test wallet (the V2 drive's setup deposit, one more deposit, gas;
// files deleted and wallet refunded at the end).
// The 0G RPC is load-balanced and a backend can lag behind the chain, so
// the test answers the vault's getUserBalance reads itself where needed:
//   - after the deposit, the first 3 reads return the old balance (a
//     lagging backend): the balance must still update, without a reload;
//   - a wide balance (12.345 0G) must stay on one line, desktop and 390 px.
// Also: Storage is its own sidebar section, above Security.
//
//   node scripts/test-storage-balance.mjs [http://localhost:5173]
import { chromium } from 'playwright'
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
        if (armStale) {
          // the next balance reads answer as a backend behind the deposit would
          staleLeft = 3
          staleValue = lastBalance
          armStale = false
        }
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

// ── the vault's balance reads, as the page makes them ──
const BALANCE_SELECTOR = ethers.id('getUserBalance(address)').slice(0, 10)
let armStale = false
let staleLeft = 0
let staleValue = null
let lastBalance = null
let fakeBalance = null
let staleServed = 0
await context.route(
  (url) => url.href.startsWith(V2_TESTNET.rpc),
  async (route) => {
    const req = route.request()
    let body
    try {
      body = JSON.parse(req.postData() ?? '')
    } catch {
      return route.continue()
    }
    const calls = Array.isArray(body) ? body : [body]
    const ids = new Set(calls.filter((c) => c.method === 'eth_call' && String(c.params?.[0]?.data ?? '').startsWith(BALANCE_SELECTOR)).map((c) => c.id))
    if (!ids.size) return route.continue()
    const res = await route.fetch()
    let out = await res.json()
    const patch = (r) => {
      if (!ids.has(r.id) || !r.result) return r
      if (fakeBalance !== null) return { ...r, result: fakeBalance }
      if (staleLeft > 0 && staleValue !== null) {
        staleLeft--
        staleServed++
        return { ...r, result: staleValue }
      }
      lastBalance = r.result
      return r
    }
    out = Array.isArray(out) ? out.map(patch) : patch(out)
    return route.fulfill({ response: res, json: out })
  }
)

const status = () => page.locator('.sec-row[data-row="storage"] .sec-status')
const amount = async () => Number(((await status().textContent()) ?? '').replace(/\s*0G\s*$/, '').replace(/[^0-9.]/g, ''))
/** The storage row's layout: the amount on one line, every cell inside the sidebar. */
const layout = () =>
  page.evaluate(() => {
    const cell = document.querySelector('.sec-row[data-row="storage"] .sec-status')
    // the lines its text sits on (the amount and "0G" are separate text nodes)
    const lines = new Set()
    const walk = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const range = document.createRange()
      range.selectNodeContents(n)
      for (const r of range.getClientRects()) if (r.width > 0) lines.add(Math.round(r.top))
    }
    const side = document.querySelector('.sidebar').getBoundingClientRect()
    const cells = [...document.querySelectorAll('.sec-row[data-row="storage"] > span')].map((c) => c.getBoundingClientRect())
    return {
      text: cell.textContent,
      lines: lines.size,
      inside: cells.every((c) => c.left >= side.left - 0.5 && c.right <= side.right + 0.5),
      scroll: document.documentElement.scrollWidth - window.innerWidth,
    }
  })

let masterKeyHex = null
try {
  await page.goto(base)
  await page.evaluate(() => localStorage.setItem('0gdrive:smart-search', 'off'))
  await page.reload()
  await connectExtension(page)
  // setup: 3 signatures and the storage deposit (one transaction)
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 5 * 60_000 })
  masterKeyHex = await page.evaluate((a) => localStorage.getItem('0gdrive:masterkey:' + a.toLowerCase()), wallet.address)
  await page.waitForFunction(() => /[0-9]/.test(document.querySelector('.sec-row[data-row="storage"] .sec-status')?.textContent ?? ''), null, { timeout: 60_000 })

  const sections = await page.$$eval('.sidebar .sidebar-sec', (els) =>
    els.map((e) => ({ heading: e.querySelector('.sec-heading')?.textContent, storageRow: !!e.querySelector('.sec-row[data-row="storage"]') }))
  )
  const si = sections.findIndex((s) => s.heading === 'Storage')
  const ei = sections.findIndex((s) => s.heading === 'Security')
  check(
    'Storage is its own section, above Security, holding the balance',
    si >= 0 && ei > si && sections[si].storageRow && !sections[ei].storageRow,
    JSON.stringify(sections)
  )

  // a deposit while the RPC lags: the balance still updates, with no reload
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? '0.05' : undefined))
  const before = await amount()
  armStale = true
  await page.locator('.sec-row[data-row="storage"] button').click()
  await page.locator('.sec-row[data-row="storage"] button', { hasText: 'Updating…' }).waitFor({ timeout: 3 * 60_000 })
  check('after the deposit the button shows “Updating…”', true)
  await page.waitForFunction((b) => {
    const t = document.querySelector('.sec-row[data-row="storage"] .sec-status')?.textContent ?? ''
    return Number(t.replace(/\s*0G\s*$/, '').replace(/[^0-9.]/g, '')) > b + 0.04
  }, before, { timeout: 2 * 60_000 })
  check(
    'lagging RPC (3 stale reads): the balance still shows the deposit, without a reload',
    staleServed === 3,
    `${before} → ${await amount()} 0G, ${staleServed} stale reads served`
  )
  await page.locator('.sec-row[data-row="storage"] button', { hasText: /^Deposit$/ }).waitFor({ timeout: 30_000 })
  check('the button is back to “Deposit”', true)

  // a wide balance on one line: desktop sidebar, then a phone's drawer
  fakeBalance = '0x' + (12345n * 10n ** 15n).toString(16).padStart(64, '0')
  await page.reload()
  await page.locator('.sec-row[data-row="storage"] .sec-status', { hasText: '12.345' }).waitFor({ timeout: 3 * 60_000 })
  const desk = await layout()
  check('desktop: “12.345 0G” on one line, inside the sidebar', desk.lines === 1 && desk.inside && desk.scroll <= 0, JSON.stringify(desk))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.nav-toggle').click()
  await page.locator('.sec-row[data-row="storage"]').waitFor({ state: 'visible', timeout: 60_000 })
  await page.waitForTimeout(500) // the drawer slides in
  const phone = await layout()
  check('390 px: on one line, inside the drawer, no horizontal scroll', phone.lines === 1 && phone.inside && phone.scroll <= 0, JSON.stringify(phone))
  fakeBalance = null
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
