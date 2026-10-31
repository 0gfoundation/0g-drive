// On-device AI loading: what downloads when, on a phone and on a desktop.
//   phone (390 px, touch): smart search starts off — no model download;
//     turning it on asks first (needs ~1 GB of memory), and a "no" keeps it off
//   desktop: the warm-up loads only the text model (no CLIP files), and the
//     photo models load on the first photo upload
// Each part makes a drive on a FRESH key funded from .env's test wallet,
// refunded at the end. Needs the model CDNs (or the app's /_models route).
// Usage: node scripts/test-ai-loading.mjs [http://localhost:5173]
import { chromium } from 'playwright'
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getNetworkConfig } from '../core/dist/index.js'
import { refund } from './lib/refund.mjs'

const base = process.argv[2] ?? 'http://localhost:5173'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const funderKey = /^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(readFileSync(resolve(root, '.env'), 'utf8'))[1]
const network = getNetworkConfig('testnet', 'turbo')
const provider = new ethers.JsonRpcProvider(network.rpcUrl)
const funder = new ethers.Wallet(funderKey, provider)
const t0 = Date.now()
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const MODEL_URL = /huggingface\.co|cdn\.jsdelivr\.net|\/_models\//
const rendererMb = () => {
  try {
    return Math.round(Number(execSync("ps -eo rss,args | grep -- '--type=renderer' | grep -v grep | awk '{s+=$1} END {print s+0}'").toString()) / 1024)
  } catch {
    return -1
  }
}

const browser = await chromium.launch()

/** A context with a fresh funded wallet injected, its drive created. */
async function openDrive(contextOpts) {
  const wallet = ethers.Wallet.createRandom().connect(provider)
  await (await funder.sendTransaction({ to: wallet.address, value: ethers.parseEther('0.3') })).wait()
  const context = await browser.newContext(contextOpts)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const models = []
  page.on('request', (r) => MODEL_URL.test(r.url()) && models.push(r.url()))
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
  await page.goto(base)
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 120_000 })
  return { wallet, context, page, errors, models }
}

const aiToggle = (page) => page.locator('[data-guide="on-device-ai"] input[type=checkbox]')
const aiNote = (page) => page.locator('[data-guide="on-device-ai"] .sec-item.muted').textContent()
const wallets = []

try {
  // ── phone: off at first, and turning it on asks
  const phone = await openDrive({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  })
  wallets.push(phone.wallet)
  step('phone: drive open')
  await phone.page.waitForTimeout(15_000)
  await phone.page.locator('.nav-toggle').click()
  const before = { checked: await aiToggle(phone.page).isChecked(), note: await aiNote(phone.page), downloads: phone.models.length }
  check('phone: smart search starts off, says why, and nothing downloads',
    !before.checked && /Off on phones at first: the models need about 1 GB/.test(before.note) && before.downloads === 0,
    JSON.stringify(before))
  let asked = ''
  phone.page.once('dialog', (d) => {
    asked = d.message()
    void d.dismiss()
  })
  await aiToggle(phone.page).click()
  await phone.page.waitForTimeout(3000)
  const declined = { asked: /about 1 GB of memory/.test(asked), checked: await aiToggle(phone.page).isChecked(), downloads: phone.models.length }
  check('phone: turning it on warns about memory; "no" keeps it off',
    declined.asked && !declined.checked && declined.downloads === 0, JSON.stringify(declined))
  check('phone: no page errors', phone.errors.length === 0, phone.errors.join(' | '))
  await phone.context.close()

  // ── desktop: the text model now, the photo models on the first photo
  const desk = await openDrive({ viewport: { width: 1280, height: 900 } })
  wallets.push(desk.wallet)
  step('desktop: drive open; waiting for the text model')
  let peak = rendererMb()
  let seen = false
  const until = Date.now() + 6 * 60_000
  while (Date.now() < until) {
    const loading = await desk.page.locator('.searchbox-status .sb-long').count()
    peak = Math.max(peak, rendererMb())
    if (loading) seen = true
    else if (seen) break
    await desk.page.waitForTimeout(1000)
  }
  const warm = desk.models.map((u) => u.split('/').slice(-3).join('/'))
  check('desktop: the warm-up downloads the text model, no photo (CLIP) files',
    seen && desk.models.some((u) => /MiniLM-L12-v2.*model_quantized\.onnx/.test(u)) && !desk.models.some((u) => /clip-vit/.test(u)),
    `${warm.length} files, peak renderer ${peak} MB`)

  // a 64×64 PNG, drawn in the page
  const png = Buffer.from(
    await desk.page.evaluate(async () => {
      const c = new OffscreenCanvas(64, 64)
      const g = c.getContext('2d')
      g.fillStyle = '#3a7'
      g.fillRect(0, 0, 64, 64)
      g.fillStyle = '#fd2'
      g.beginPath()
      g.arc(32, 32, 16, 0, 7)
      g.fill()
      const b = await c.convertToBlob({ type: 'image/png' })
      return [...new Uint8Array(await b.arrayBuffer())]
    })
  )
  await desk.page.setInputFiles('.dropzone input[type=file]', [{ name: 'sun.png', mimeType: 'image/png', buffer: png }])
  await desk.page.locator('table .fname-btn', { hasText: 'sun.png' }).waitFor({ timeout: 8 * 60_000 })
  check('desktop: the first photo upload loads the photo models',
    desk.models.some((u) => /clip-vit.*vision_model_quantized\.onnx/.test(u)) &&
      desk.models.some((u) => /clip-vit.*text_model_quantized\.onnx/.test(u)),
    `${desk.models.filter((u) => /clip-vit/.test(u)).length} CLIP files`)
  check('desktop: no page errors', desk.errors.length === 0, desk.errors.join(' | '))
  await desk.context.close()
} catch (e) {
  check('run completed', false, e.message.split('\n').slice(0, 6).join(' | '))
} finally {
  await browser.close()
  for (const w of wallets) await refund(w, funder.address)
}

const passed = results.filter((r) => r.ok).length
console.log(`${passed}/${results.length} checks passed`)
process.exit(passed === results.length ? 0 : 1)
