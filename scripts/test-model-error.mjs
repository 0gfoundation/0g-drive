// Why the search models didn't load, readable on any device (headless
// Chromium + dev server; a FRESH wallet funded from .env's test wallet only
// creates the drive). Phones show no tooltips, and a user in MetaMask's
// in-app browser saw only "Models failed to load":
//   the reason is mapped to words a user can act on (memory, storage,
//   download, WebAssembly), the raw reason kept after it
//   with the model downloads blocked: the settings line and Activity both
//   say "couldn't download the models"
//
//   node scripts/test-model-error.mjs [http://localhost:5173]
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
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  step(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const wallet = ethers.Wallet.createRandom().connect(provider)
const funder = new ethers.Wallet(funderKey, provider)
await (await funder.sendTransaction({ to: wallet.address, value: ethers.parseEther('0.3') })).wait()
step(`fresh wallet ${wallet.address} funded`)

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
let approve = false
let promptAt = null
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
        promptAt = performance.now()
        if (!approve) return { err: 'user rejected transaction' }
        const [tx] = params
        const sent = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n })
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
  localStorage.setItem('0gdrive:smart-search', 'on')
  localStorage.setItem('0gdrive:layout', 'list')
  window.ethereum = {
    async request({ method, params }) {
      const r = await window.__eth(method, params)
      if (r.err) throw Object.assign(new Error(r.err), { code: 4001 })
      return r.ok
    },
    on() {},
    removeListener() {},
  }
})


// the models can't be downloaded: every route to them fails
await context.route(/huggingface\.co|hf\.co|cdn\.jsdelivr\.net|\/_models\/|xethub|cdn-lfs/, (r) => r.abort())

try {
  // the mapping, from the page's own module (dev server only)
  if (/localhost/.test(base)) {
    await page.goto(base)
    const mapped = await page.evaluate(async () => {
      const { modelErrorReason } = await import('/src/ai/client.ts')
      return [
        'RangeError: WebAssembly.Memory(): could not allocate memory',
        'Aborted(OOM)',
        'QuotaExceededError: The quota has been exceeded.',
        'TypeError: Failed to fetch',
        'Load failed',
        'no available backend found. ERR: [wasm] RuntimeError: unreachable',
        'something else entirely',
        '',
      ].map((r) => modelErrorReason(r))
    })
    const want = [/^not enough memory/, /^not enough memory/, /^not enough storage/, /^couldn’t download/, /^couldn’t download/, /^this browser can’t run/, /^something else entirely$/, /^unknown reason$/]
    check('reasons map to memory / storage / download / WebAssembly, the raw text kept', mapped.every((m, i) => want[i].test(m)), mapped.join(' | ').slice(0, 400))
  }

  await page.goto(base)
  await connectExtension(page)
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 120_000 })
  const line = page.locator('.sec-item', { hasText: 'Models failed to load' })
  await line.waitFor({ timeout: 4 * 60_000 })
  const text = await line.textContent()
  check('settings line: "Models failed to load (couldn’t download the models — …)"', /Models failed to load \(couldn’t download the models/.test(text), text.slice(0, 200))
  const act = await page.locator('.activity li', { hasText: 'Smart search models failed to load' }).first().textContent({ timeout: 10_000 }).catch(() => '')
  check('Activity says the same (readable on phones)', /couldn’t download the models/.test(act), act.slice(0, 200))
} catch (err) {
  check('run completed', false, err.message.split('\n')[0])
} finally {
  await browser.close()
}
const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} checks passed`)
await refund(wallet, funder.address)
process.exit(passed === results.length ? 0 : 1)
