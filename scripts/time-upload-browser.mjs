// Browser timing for file uploads (headless Chromium + dev server, injected
// wallet backed by a FRESH key funded from .env's test wallet):
//   for each size: the time from picking the file to the wallet's
//   eth_sendTransaction (the wallet then REJECTS, so nothing is stored),
//   with the app's own Activity breakdown; also with the CPU slowed 4×
//   (a rough phone) for one size
//   one upload approved and stored: approval → segments sent → stored
// Smart search off, random .bin files (no thumbnail, no search entry) —
// or, with SMART=1 KIND=jpg|pdf, as a user with smart search on uploading
// photos (noise JPEGs of about the given size; needs Python with PIL) or
// PDFs (40 pages of text plus a noise image making up the size). Also
// reports how long the page's main thread was blocked meanwhile.
//
//   [SMART=1] [KIND=jpg|pdf] node scripts/time-upload-browser.mjs [url] [sizes in MB, e.g. 10,50,200] [stored size MB]
import { chromium } from 'playwright'
import { ethers } from 'ethers'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getNetworkConfig } from '../core/dist/index.js'
import { refund } from './lib/refund.mjs'

const base = process.argv[2] ?? 'http://localhost:5173'
const sizes = (process.argv[3] ?? '10,50,200').split(',').map(Number)
const storedMB = Number(process.argv[4] ?? 50)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const funderKey = /^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(readFileSync(resolve(root, '.env'), 'utf8'))[1]
const network = getNetworkConfig('testnet', 'turbo')
const provider = new ethers.JsonRpcProvider(network.rpcUrl)
const t0 = Date.now()
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)

const wallet = ethers.Wallet.createRandom().connect(provider)
const funder = new ethers.Wallet(funderKey, provider)
await (await funder.sendTransaction({ to: wallet.address, value: ethers.parseEther('1') })).wait()
step(`fresh wallet ${wallet.address} funded`)

const dir = mkdtempSync(join(tmpdir(), 'upload-timing-'))
const KIND = process.env.KIND ?? 'bin'
const fileOf = (mb, tag) => {
  if (KIND === 'pdf') {
    const path = join(dir, `doc-${mb}MB-${tag}.pdf`)
    writeFileSync(path, makePdf(mb * 1024 * 1024))
    return path
  }
  if (KIND === 'jpg') {
    const path = join(dir, `photo-${mb}MB-${tag}.jpg`)
    // noise compresses badly: ~0.95 MB per megapixel at quality 95
    const side = Math.round(Math.sqrt((mb / 0.95) * 1e6))
    execFileSync('python3', ['-c', `from PIL import Image; import os; Image.frombytes('RGB', (${side}, ${side}), os.urandom(${side * side * 3})).save('${path}', quality=95)`])
    return path
  }
  const path = join(dir, `random-${mb}MB-${tag}.bin`)
  const buf = Buffer.alloc(mb * 1024 * 1024)
  for (let i = 0; i < buf.length; i += 65536) crypto.getRandomValues(buf.subarray(i, Math.min(i + 65536, buf.length)))
  writeFileSync(path, buf)
  return path
}

/** A valid PDF: 40 pages of text, page 1 also shows a raw noise image of ~`bytes`. */
function makePdf(bytes) {
  const side = Math.floor(Math.sqrt(bytes / 3))
  const objs = []
  const pages = 40
  const pageIds = Array.from({ length: pages }, (_, i) => 5 + i * 2)
  objs[1] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>')
  objs[2] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages} >>`)
  objs[3] = Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const noise = Buffer.alloc(side * side * 3)
  for (let i = 0; i < noise.length; i += 65536) crypto.getRandomValues(noise.subarray(i, Math.min(i + 65536, noise.length)))
  objs[4] = Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${side} /Height ${side} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${noise.length} >>\nstream\n`), noise, Buffer.from('\nendstream')])
  pageIds.forEach((id, i) => {
    // different words in every file: no search entry can be reused
    const word = () => Math.random().toString(36).slice(2, 9)
    const lines = Array.from({ length: 40 }, (_, l) => `BT /F1 10 Tf 40 ${780 - l * 18} Td (Review ${word()} page ${i + 1} line ${l + 1}: ${word()} ${word()} costs ${word()} plan ${word()}.) Tj ET`)
    const content = (i === 0 ? 'q 200 0 0 200 300 50 cm /Im1 Do Q\n' : '') + lines.join('\n')
    objs[id] = Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 4 0 R >> >> /Contents ${id + 1} 0 R >>`)
    objs[id + 1] = Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  })
  const parts = [Buffer.from('%PDF-1.4\n')]
  const offsets = []
  let at = parts[0].length
  for (let n = 1; n < objs.length; n++) {
    const chunk = Buffer.concat([Buffer.from(`${n} 0 obj\n`), objs[n], Buffer.from('\nendobj\n')])
    offsets[n] = at
    parts.push(chunk)
    at += chunk.length
  }
  const xref = ['xref', `0 ${objs.length}`, '0000000000 65535 f ', ...offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n `)].join('\n')
  parts.push(Buffer.from(`${xref}\ntrailer << /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`))
  return Buffer.concat(parts)
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
if (process.env.SMART) await context.addInitScript(() => (window.__smart = true))
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
const cdp = await context.newCDPSession(page)
const askedLines = () => page.$$eval('.activity li', (els) => els.map((e) => e.textContent).filter((t) => t.includes('Asked your wallet')))
const queueText = () => page.$$eval('.queue-item', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ')).join(' | ')).catch(() => '')

/** pick the file, wait for the wallet request (and the upload to settle); returns seconds */
async function toPrompt(path) {
  promptAt = null
  const before = (await askedLines()).length
  await page.evaluate(() => (window.__long = []))
  const start = performance.now()
  await page.setInputFiles('.dropzone input[type=file]', path)
  while (promptAt === null) await new Promise((r) => setTimeout(r, 20))
  const secs = (promptAt - start) / 1000
  await page.waitForFunction(
    (n) => [...document.querySelectorAll('.activity li')].filter((e) => e.textContent.includes('Asked your wallet')).length > n,
    before,
    { timeout: 30_000 }
  ).catch(() => undefined)
  const lines = await askedLines()
  const long = await page.evaluate(() => window.__long)
  const blocked = long.reduce((n, [, d]) => n + d, 0) / 1000
  const worst = Math.max(0, ...long.map(([, d]) => d)) / 1000
  return { secs, line: (lines.length > before ? lines[0] : '') + ` [main thread blocked ${blocked.toFixed(1)} s, longest ${worst.toFixed(1)} s]` }
}
const settle = () => page.waitForFunction(() => !document.body.textContent.includes('transaction rejected') || true).then(() => page.waitForTimeout(2000))

const rows = []
try {
  await page.goto(base)
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 120_000 })
  step('drive created')
  if (process.env.SMART) {
    // as a returning user: the search model is already loaded when they upload
    await page.locator('.searchbox-status .spinner').waitFor({ timeout: 20_000 }).catch(() => undefined)
    await page.locator('.searchbox-status .spinner').waitFor({ state: 'detached', timeout: 10 * 60_000 })
    await page.waitForTimeout(3000)
    step('search model ready')
  }

  for (const mb of sizes) {
    const r = await toPrompt(fileOf(mb, 'a'))
    rows.push({ what: `${mb} MB`, ...r })
    step(`${mb} MB: ${r.secs.toFixed(1)} s to the wallet (${(mb / r.secs).toFixed(1)} MB/s) — ${r.line.replace(/^\S+ \S+ /, '')}`)
    await settle()
  }
  const slowMB = sizes.find((s) => s >= 50) ?? sizes[sizes.length - 1]
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  const slow = await toPrompt(fileOf(slowMB, 'slow'))
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  step(`${slowMB} MB, CPU 4× slower (workers are not slowed): ${slow.secs.toFixed(1)} s to the wallet — ${slow.line.replace(/^\S+ \S+ /, '')}`)
  await page.waitForTimeout(1500)

  if (storedMB > 0) {
    approve = true
    const path = fileOf(storedMB, 'stored')
    const r = await toPrompt(path)
    const approvedAt = performance.now()
    step(`${storedMB} MB stored run: ${r.secs.toFixed(1)} s to the wallet; approved`)
    const seen = {}
    const deadline = Date.now() + 30 * 60_000
    let last = ''
    while (Date.now() < deadline) {
      const q = await queueText()
      const s = ((performance.now() - approvedAt) / 1000).toFixed(1)
      for (const [key, re] of [['segments', /storing segments/], ['sealing', /sealing on 0G/], ['registering', /saving to your drive/], ['done', /in your drive ✓/]]) {
        if (!seen[key] && re.test(q)) seen[key] = s
      }
      if (q !== last) last = q
      if (seen.done || /failed|error/i.test(q)) break
      await page.waitForTimeout(250)
    }
    step(`after approval (s): ${JSON.stringify(seen)} ${seen.done ? '' : `— last: ${last}`}`)
  }
} catch (err) {
  step(`run failed: ${err.message.split('\n')[0]}`)
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}
await refund(wallet, funder.address)
