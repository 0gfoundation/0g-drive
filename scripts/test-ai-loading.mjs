// On-device AI loading: what downloads when, on a phone and on a desktop.
//   phone (390 px, touch): smart search starts off — no model download;
//     turning it on asks first (needs ~1 GB of memory), and a "no" keeps it off
//   desktop: drive open loads the text model and downloads the photo model
//     files (not loaded); the first photo upload builds them from the
//     cache, without downloading again, and the photo is indexed
//   reopening that drive with an empty model cache (desktop, and a phone
//     with smart search turned on): the files download at open, and the
//     first photo search builds CLIP's text half from the cache (timed)
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
  const s = await openPage(contextOpts, wallet)
  await s.page.goto(base)
  await s.page.getByRole('button', { name: 'Connect wallet' }).click()
  await s.page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await s.page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 120_000 })
  return s
}

/** A context with `wallet` injected (and `storageState`, e.g. a drive key), not yet loaded. */
async function openPage(contextOpts, wallet, extraInit = '') {
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
  if (extraInit) await context.addInitScript(extraInit)
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
  return { wallet, context, page, errors, models }
}

/** Requests for CLIP's big files (the two model halves and its tokenizer). */
const bigClip = (urls) => urls.filter((u) => /clip-vit.*(vision_model_quantized\.onnx|text_model_quantized\.onnx|\/tokenizer\.json)(\?|$)/.test(u))
const short = (u) => u.split('/').pop().split('?')[0]
/** Distinct big CLIP files requested (transformers.js may also probe a file it finds cached). */
// (by file name: Hugging Face serves some files through a redirect, logged as a second URL)
const clipNames = (urls) => [...new Set(bigClip(urls).map(short))]
const clipFiles = (urls) => clipNames(urls).length
/** Requests for the two model halves (the downloads that matter; the tokenizer also shows a redirect). */
const clipOnnx = (urls) => urls.filter((u) => /clip-vit.*_model_quantized\.onnx(\?|$)/.test(u)).length
/** Wait for the text model and the photo files' download to finish; the peak renderer memory meanwhile. */
async function settle(s) {
  let peak = rendererMb()
  const until = Date.now() + 8 * 60_000
  while (Date.now() < until) {
    peak = Math.max(peak, rendererMb())
    const loading = await s.page.locator('.searchbox-status .sb-long').count()
    if (!loading && clipFiles(s.models) >= 3) break
    await s.page.waitForTimeout(1000)
  }
  await s.page.waitForFunction(() => !document.querySelector('.searchbox-status .sb-long'), null, { timeout: 5 * 60_000 })
  return peak
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
  step('desktop: drive open; waiting for the text model, then the photo files')
  const peakDesk = await settle(desk)
  check('desktop: drive open loads the text model and downloads the photo model files',
    desk.models.some((u) => /MiniLM-L12-v2.*model_quantized\.onnx/.test(u)) && clipFiles(desk.models) === 3,
    `${JSON.stringify(clipNames(desk.models))} MiniLM=${desk.models.some((u) => /MiniLM-L12-v2.*model_quantized\.onnx/.test(u))}; peak renderer ${peakDesk} MB`)

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
  const clipBefore = clipOnnx(desk.models)
  const seenBefore = desk.models.length
  const t1 = Date.now()
  await desk.page.setInputFiles('.dropzone input[type=file]', [{ name: 'sun.png', mimeType: 'image/png', buffer: png }])
  await desk.page.locator('table .fname-btn', { hasText: 'sun.png' }).waitFor({ timeout: 8 * 60_000 })
  await desk.page.waitForTimeout(2000)
  const unindexed = await desk.page.getByRole('button', { name: /^Index 1 older file/ }).count()
  check('desktop: the first photo upload is indexed, the photo model built from the cache (no new download)',
    unindexed === 0 && clipOnnx(desk.models) === clipBefore,
    `upload + index ${((Date.now() - t1) / 1000).toFixed(1)} s; CLIP model requests ${clipBefore} → ${clipOnnx(desk.models)}; new model requests: ${desk.models.slice(seenBefore).map(short).join(', ') || 'none'}`)
  check('desktop: no page errors', desk.errors.length === 0, desk.errors.join(' | '))
  const state = await desk.context.storageState() // the drive key, the last-used wallet
  await desk.context.close()

  // ── the same drive (it has an indexed photo) reopened, empty model cache:
  // the files download at open, and the first photo search builds CLIP's
  // text half from the cache
  for (const [label, opts, init] of [
    ['desktop', { viewport: { width: 1280, height: 900 } }, ''],
    ['phone with smart search on', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
      "localStorage.setItem('0gdrive:smart-search', 'on')"],
  ]) {
    const s2 = await openPage({ ...opts, storageState: state }, desk.wallet, init)
    await s2.page.goto(base) // reconnects by itself
    await s2.page.locator('table .fname-btn', { hasText: 'sun.png' }).waitFor({ timeout: 5 * 60_000 })
    const peak2 = await settle(s2)
    const downloaded = clipFiles(s2.models)
    const requests = clipOnnx(s2.models)
    const t2 = Date.now()
    await s2.page.getByLabel('Search your drive').fill('sun')
    await s2.page.locator('.results .result', { hasText: 'sun.png' }).first().waitFor({ timeout: 3 * 60_000 })
    const searchMs = Date.now() - t2
    check(`${label}, reopened: photo files download at open; the first photo search loads from the cache`,
      downloaded === 3 && clipOnnx(s2.models) === requests && s2.errors.length === 0,
      `${JSON.stringify(clipNames(s2.models))} model requests ${requests}→${clipOnnx(s2.models)}; first search ${(searchMs / 1000).toFixed(1)} s (incl. 0.35 s typing debounce); peak renderer ${peak2} MB${s2.errors.length ? ' | ' + s2.errors.join(' | ') : ''}`)
    await s2.context.close()
  }
} catch (e) {
  check('run completed', false, e.message.split('\n').slice(0, 6).join(' | '))
} finally {
  await browser.close()
  for (const w of wallets) await refund(w, funder.address)
}

const passed = results.filter((r) => r.ok).length
console.log(`${passed}/${results.length} checks passed`)
process.exit(passed === results.length ? 0 : 1)
