// Foldable sidebar sections, in the browser (headless Chromium + dev server),
// with an injected wallet backed by a FRESH key funded from .env's test
// wallet (the V2 drive's setup deposit and gas; files deleted and wallet
// refunded at the end). Checks: Storage, Security and On-device AI start
// open, their headings are buttons; folded, each body is hidden and the
// heading carries a summary (the balance, what Security lacks, AI off);
// folding is remembered after a reload; the assistant pointing at a row in
// a folded section unfolds it first (a stand-in page on the assistant's
// address sends the assistant's "show" message, no Router involved);
// keyboard; 390 px in the phone drawer.
//
//   node scripts/test-foldable-sections.mjs [http://localhost:5173]
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

// a stand-in for the assistant: on its address, a page that asks the drive to show a control
const showTarget = { value: 'password' }
await context.route(
  (url) => url.searchParams.has('parent') && !url.href.startsWith(base),
  (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><script>
        setTimeout(() => parent.postMessage({ type: '0ga:show', id: 1, target: ${JSON.stringify(showTarget.value)} }, '*'), 300)
      </script>`,
    })
)

const IDS = ['storage', 'security', 'on-device-ai']
const sections = () =>
  page.$$eval('.sidebar .sidebar-sec', (els) =>
    els.map((e) => {
      const h = e.querySelector(':scope > button.sec-fold')
      const body = e.querySelector(':scope > .sec-body')
      return {
        id: e.dataset.guide,
        button: !!h,
        expanded: h?.getAttribute('aria-expanded'),
        bodyShown: !!body && body.getBoundingClientRect().height > 0,
        summary: e.querySelector('.sec-summary')?.textContent ?? null,
      }
    })
  )
const byId = (list) => Object.fromEntries(list.map((s) => [s.id, s]))

let masterKeyHex = null
try {
  await page.goto(base)
  await page.evaluate(() => localStorage.setItem('0gdrive:smart-search', 'off'))
  await page.reload()
  await connectExtension(page)
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 5 * 60_000 })
  masterKeyHex = await page.evaluate((a) => localStorage.getItem('0gdrive:masterkey:' + a.toLowerCase()), wallet.address)
  await page.waitForFunction(() => /[0-9]/.test(document.querySelector('.sec-row[data-row="storage"] .sec-status')?.textContent ?? ''), null, { timeout: 60_000 })

  let s = byId(await sections())
  check(
    'Storage, Security and On-device AI start open, their headings are buttons',
    IDS.every((id) => s[id]?.button && s[id].expanded === 'true' && s[id].bodyShown && s[id].summary === null),
    JSON.stringify(s)
  )

  for (const id of IDS) await page.locator(`[data-guide="${id}"] > button.sec-fold`).click()
  s = byId(await sections())
  check('folded: each body hidden, aria-expanded false', IDS.every((id) => s[id].expanded === 'false' && !s[id].bodyShown), JSON.stringify(s))
  check(
    'folded headings summarise: the balance, what Security lacks, AI off',
    /^0\.1\d* 0G$/.test(s.storage.summary ?? '') && s.security.summary === 'Password not set' && s['on-device-ai'].summary === 'Off',
    JSON.stringify(IDS.map((id) => s[id].summary))
  )

  await page.reload() // reconnects by itself
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 3 * 60_000 })
  await page.waitForFunction(() => /0G/.test(document.querySelector('[data-guide="storage"] .sec-summary')?.textContent ?? ''), null, { timeout: 60_000 })
  s = byId(await sections())
  check('after a reload the sections are still folded', IDS.every((id) => s[id].expanded === 'false' && !s[id].bodyShown), JSON.stringify(s))

  // the assistant points at the Password row: Security unfolds, the row pulses
  const pulsed = page.waitForFunction(() => !!document.querySelector('.sec-row[data-row="password"] > .guide-pulse'), null, { timeout: 60_000, polling: 100 })
  await page.getByRole('button', { name: 'Ask the assistant' }).click()
  const shown = await pulsed.then(() => true, () => false)
  s = byId(await sections())
  check(
    'the assistant pointing at a folded row unfolds its section (only that one) and the row pulses',
    shown && s.security.expanded === 'true' && s.security.bodyShown && s.storage.expanded === 'false' && s['on-device-ai'].expanded === 'false',
    JSON.stringify({ shown, s })
  )
  await page.keyboard.press('Escape')

  // keyboard: focus the Storage heading, Enter unfolds it
  await page.locator('[data-guide="storage"] > button.sec-fold').focus()
  await page.keyboard.press('Enter')
  s = byId(await sections())
  check('keyboard: Enter on a heading unfolds it', s.storage.expanded === 'true' && s.storage.bodyShown, JSON.stringify(s.storage))

  // 390 px: fold Storage again, open the drawer: headings and summaries inside it
  await page.locator('[data-guide="storage"] > button.sec-fold').click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.nav-toggle').click()
  await page.locator('[data-guide="storage"] > button.sec-fold').waitFor({ state: 'visible', timeout: 60_000 })
  await page.waitForTimeout(500) // the drawer slides in
  const phone = await page.evaluate(() => {
    const side = document.querySelector('.sidebar').getBoundingClientRect()
    const parts = [...document.querySelectorAll('.sidebar .sec-fold, .sidebar .sec-summary')].map((e) => e.getBoundingClientRect())
    return {
      inside: parts.every((r) => r.left >= side.left - 0.5 && r.right <= side.right + 0.5 && r.right <= 390),
      headings: document.querySelectorAll('.sidebar .sec-fold').length,
      summary: document.querySelector('[data-guide="storage"] .sec-summary')?.textContent,
      scroll: document.documentElement.scrollWidth - window.innerWidth,
    }
  })
  check('390 px: headings and summaries inside the drawer, no horizontal scroll', phone.inside && phone.headings === 3 && /0G/.test(phone.summary ?? '') && phone.scroll <= 0, JSON.stringify(phone))
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
