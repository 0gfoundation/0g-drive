// Upload hashing is ready before the first upload (headless Chromium + dev
// server, injected wallet backed by a FRESH key funded from .env's test
// wallet; the wallet REJECTS the uploads, so nothing is stored):
//   the hashing workers start when the drive opens, before any upload
//   a small file (1 MB) is hashed on the page: preparing ~0
//   the first large file (30 MB) waits ~0 for workers
// (A user saw "starting workers 1.8 s / 5.1 s" on a first upload when the
// workers only started then.) Smart search off.
//
//   node scripts/test-hash-workers.mjs [http://localhost:5173]
import { chromium } from 'playwright'
import { ethers } from 'ethers'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
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

const dir = mkdtempSync(join(tmpdir(), 'upload-timing-'))
const fileOf = (mb, tag) => {
  const path = join(dir, `random-${mb}MB-${tag}.bin`)
  const buf = Buffer.alloc(mb * 1024 * 1024)
  for (let i = 0; i < buf.length; i += 65536) crypto.getRandomValues(buf.subarray(i, Math.min(i + 65536, buf.length)))
  writeFileSync(path, buf)
  return path
}

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
  if (!window.__smart) localStorage.setItem('0gdrive:smart-search', 'off')
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
await context.addInitScript(() => {
  window.__long = []
  try {
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push([e.startTime, e.duration]))).observe({ type: 'longtask', buffered: true })
  } catch {}
})

const askedLines = () => page.$$eval('.activity li', (els) => els.map((e) => e.textContent).filter((t) => t.includes('Asked your wallet')))
async function toPrompt(path) {
  promptAt = null
  const before = (await askedLines()).length
  await page.setInputFiles('.dropzone input[type=file]', path)
  const deadline = Date.now() + 120_000
  while (promptAt === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  await page.waitForFunction(
    (n) => [...document.querySelectorAll('.activity li')].filter((e) => e.textContent.includes('Asked your wallet')).length > n,
    before,
    { timeout: 30_000 }
  )
  await page.waitForTimeout(2000) // the rejection settles
  return (await askedLines())[0]
}
const preparing = (line) => Number(/preparing (\d+\.\d) s/.exec(line)?.[1] ?? 0)
const starting = (line) => Number(/starting workers (\d+\.\d) s/.exec(line)?.[1] ?? 0)
const hashWorkers = () => page.workers().filter((w) => w.url().includes('hash.worker')).length

try {
  await page.goto(base)
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 120_000 })
  const deadline = Date.now() + 15_000
  while (hashWorkers() === 0 && Date.now() < deadline) await page.waitForTimeout(200)
  check('the hashing workers start when the drive opens, before any upload', hashWorkers() > 0, `${hashWorkers()} workers`)
  await page.waitForTimeout(2000)

  const small = await toPrompt(fileOf(1, 'small'))
  check('a small file (1 MB) is hashed on the page: preparing ~0', preparing(small) <= 0.1, small.replace(/^\S+ \S+ /, ''))
  const large = await toPrompt(fileOf(30, 'large'))
  check('the first large file (30 MB) waits ~0 for workers', starting(large) <= 0.2 && preparing(large) < 1.5, large.replace(/^\S+ \S+ /, ''))
} catch (err) {
  check('run completed', false, err.message.split('\n')[0])
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}
const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} checks passed`)
await refund(wallet, funder.address)
process.exit(passed === results.length ? 0 : 1)
