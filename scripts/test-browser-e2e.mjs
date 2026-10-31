// Full in-browser test of the app (headless Chromium + dev server), with an
// injected EIP-1193 wallet backed by a FRESH key funded from .env's test
// wallet. Exercises the real UI end to end and counts wallet prompts:
//   create drive → new folder → batched uploads (1 prompt each) → smart
//   search (Chinese queries) → organize suggestion → move → reload from
//   chain → preview a file.
//
//   node scripts/test-browser-e2e.mjs [http://localhost:5173]
import { chromium } from 'playwright'
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

// ── fresh funded wallet ──
const wallet = ethers.Wallet.createRandom().connect(provider)
const funder = new ethers.Wallet(funderKey, provider)
await (await funder.sendTransaction({ to: wallet.address, value: ethers.parseEther('2') })).wait()
step(`fresh wallet ${wallet.address} funded with 2 0G`)

// ── injected wallet ──
const prompts = { tx: 0, sign: 0 }
async function rpc(method, params) {
  switch (method) {
    case 'eth_requestAccounts':
    case 'eth_accounts':
      return [wallet.address]
    case 'eth_chainId':
      return network.chainIdHex.toLowerCase()
    case 'net_version':
      return String(network.chainId)
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
      const sent = await wallet.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value ? BigInt(tx.value) : 0n,
        gasLimit: tx.gas ? BigInt(tx.gas) : undefined,
      })
      return sent.hash
    }
    default:
      return provider.send(method, params ?? [])
  }
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
const consoleTail = []
page.on('console', (m) => {
  consoleTail.push(`${m.type()}: ${m.text().slice(0, 200)}`)
  if (consoleTail.length > 40) consoleTail.shift()
})
page.on('worker', (w) => w.on('console', (m) => {
  consoleTail.push(`worker ${m.type()}: ${m.text().slice(0, 200)}`)
  if (consoleTail.length > 40) consoleTail.shift()
}))
page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Recipes' : undefined))
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

const IMG = 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/'
const fetchBuf = async (u) => Buffer.from(await (await fetch(u)).arrayBuffer())
function makePdf(text) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const off = []
  objs.forEach((o, i) => {
    off.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const x = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`
  return Buffer.from(out)
}

async function uploadAndWait(files) {
  const before = prompts.tx
  const queued = await page.$$eval('.queue-item', (els) => els.length)
  const inputState = await page.$eval('.dropzone input[type=file]', (el) => ({ disabled: el.disabled, cls: el.closest('.dropzone').className }))
  step(`upload ${files.map((f) => f.name).join(', ')} — input ${JSON.stringify(inputState)}`)
  await page.setInputFiles('.dropzone input[type=file]', files)
  await page.waitForTimeout(3000)
  step(`queue items: ${queued} → ${await page.$$eval('.queue-item', (els) => els.length)}`)
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
  // "in your drive" shows before the list reloads from chain — wait for it
  for (const f of files) await page.locator('table .fname-btn', { hasText: f.name }).waitFor({ timeout: 3 * 60_000 })
  return prompts.tx - before
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${el()} ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

try {
  await page.goto(base)
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 120_000 })
  step('drive created')

  let tx = prompts.tx
  await page.getByRole('button', { name: '+ New folder' }).click()
  await page.locator('.sidebar .tree-name', { hasText: 'Recipes' }).waitFor({ timeout: 10 * 60_000 })
  step(`folder created (${prompts.tx - tx} tx)`)

  await page.locator('.sidebar .tree-name', { hasText: 'Recipes' }).click()
  await page.locator('.breadcrumb', { hasText: 'Recipes' }).waitFor()
  const n1 = await uploadAndWait([
    { name: 'pancakes.md', mimeType: 'text/markdown', buffer: Buffer.from('Fluffy pancakes: 200g flour, 2 eggs, 300ml milk, butter for the pan. Whisk and rest 20 minutes before cooking.') },
    { name: 'ramen.txt', mimeType: 'text/plain', buffer: Buffer.from('拉面做法:猪骨熬汤八小时,加入酱油和味醂调味,面条煮两分钟,配叉烧和溏心蛋。') },
  ])
  check('2 files into Recipes with ONE wallet prompt', n1 === 1, `${n1} tx`)

  await page.locator('.sidebar .nav-item', { hasText: 'My Drive' }).click()
  const n2 = await uploadAndWait([
    { name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: await fetchBuf(IMG + 'cats.jpg') },
    { name: 'lease-2026.pdf', mimeType: 'application/pdf', buffer: makePdf('Residential Lease Agreement between Landlord and Tenant. Monthly rent 1450 EUR. Notice period sixty days.') },
    { name: 'carbonara.md', mimeType: 'text/markdown', buffer: Buffer.from('Spaghetti carbonara: 200g spaghetti, guanciale, 2 eggs, pecorino romano, black pepper. Boil the pasta in salted water.') },
  ])
  check('3 files (photo, PDF, text) with ONE wallet prompt', n2 === 1, `${n2} tx`)
  const thumbs = await page.$$eval('table .fthumb', (els) => els.length)
  check('photo thumbnail shown in list', thumbs >= 1, `${thumbs} thumbnail(s)`)
  const indexed = await page.evaluate(() => document.querySelector('.ai-bar')?.textContent ?? '')
  check('every upload got a search entry (no "Index older files" prompt)', !/older file/.test(indexed), JSON.stringify(indexed))

  const search = async (q) => {
    await page.fill('input[aria-label="Search your drive"]', q)
    await page.waitForFunction(
      (q) => document.querySelector('.files h2')?.textContent?.includes(`“${q}”`) && !document.querySelector('.searchbox-status'),
      q,
      { timeout: 5 * 60_000 }
    )
    return page.$$eval('.result .fname-btn', (els) => els.map((e) => e.textContent))
  }
  let r = await search('猫')
  check('search "猫" finds the cat photo (named IMG_0001.jpg)', r[0] === 'IMG_0001.jpg', JSON.stringify(r))
  r = await search('租房合同')
  check('search "租房合同" finds the English lease PDF', r[0] === 'lease-2026.pdf', JSON.stringify(r))
  r = await search('noodle soup')
  check('search "noodle soup" finds the Chinese ramen note in Recipes', r[0] === 'ramen.txt', JSON.stringify(r))
  await page.fill('input[aria-label="Search your drive"]', '')
  await page.locator('.files h2', { hasText: 'My drive' }).waitFor()

  await page.getByRole('button', { name: '✨ Suggest organization' }).click()
  await page.locator('.suggest').waitFor({ timeout: 120_000 })
  const sugg = await page.$$eval('.suggest-list li', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
  const want = sugg.some((s) => s.includes('carbonara.md') && s.includes('Recipes'))
  const noise = sugg.filter((s) => !s.includes('carbonara.md'))
  check('suggests carbonara.md → Recipes, nothing else', want && noise.length === 0, JSON.stringify(sugg))

  if (want) {
    tx = prompts.tx
    // apply only the expected suggestion
    for (const li of await page.$$('.suggest-list li')) {
      if (!(await li.textContent()).includes('carbonara.md')) await (await li.$('input')).uncheck()
    }
    await page.locator('.suggest-actions button').click()
    await page.locator('.activity li', { hasText: 'Moved 1 file' }).waitFor({ timeout: 10 * 60_000 })
    check('move applied in one transaction', prompts.tx - tx === 1, `${prompts.tx - tx} tx (destination + source manifests)`)
  }

  // fresh load from chain: records written in batch must have txSeqs backfilled
  await page.reload() // reconnects by itself
  await page.locator('.sidebar .tree-name', { hasText: 'Recipes' }).waitFor({ timeout: 5 * 60_000 })
  await page.locator('.sidebar .tree-name', { hasText: 'Recipes' }).click()
  await page.locator('table .fname-btn', { hasText: 'carbonara.md' }).waitFor({ timeout: 5 * 60_000 })
  const inRecipes = await page.$$eval('table .fname-btn', (els) => els.map((e) => e.textContent).sort())
  const recipesBar = await page.evaluate(() => document.querySelector('.ai-bar')?.textContent ?? '')
  check('Recipes files (first upload, during model download) got search entries', !/older file/.test(recipesBar), JSON.stringify(recipesBar))
  check('after reload, Recipes holds pancakes + ramen + carbonara', JSON.stringify(inRecipes) === JSON.stringify(['carbonara.md', 'pancakes.md', 'ramen.txt']), JSON.stringify(inRecipes))

  await page.locator('table .fname-btn', { hasText: 'carbonara.md' }).click()
  await page.locator('.preview-text').waitFor({ timeout: 5 * 60_000 })
  const text = await page.textContent('.preview-text')
  check('preview downloads + decrypts the moved file', text.startsWith('Spaghetti carbonara'), JSON.stringify(text.slice(0, 40)))
  await page.keyboard.press('Escape')

  // trash and restore through the UI, one transaction each
  const row = (name) => page.locator('table tr', { has: page.locator('.fname-btn', { hasText: name }) })
  tx = prompts.tx
  await row('carbonara.md').getByRole('button', { name: 'Move to trash' }).click()
  await page.locator('.activity li', { hasText: 'carbonara.md moved to trash' }).waitFor({ timeout: 10 * 60_000 })
  const trashTx = prompts.tx - tx
  await page.locator('[data-guide="trash"]').click()
  await row('carbonara.md').waitFor({ timeout: 2 * 60_000 })
  tx = prompts.tx
  await row('carbonara.md').getByRole('button', { name: 'Restore' }).click()
  await page.locator('.activity li', { hasText: 'carbonara.md restored' }).waitFor({ timeout: 10 * 60_000 })
  check('move to trash and restore: one transaction each', trashTx === 1 && prompts.tx - tx === 1, `${trashTx} + ${prompts.tx - tx} tx`)
} catch (err) {
  check('run completed', false, err.message.split('\n')[0])
  const q = await page.$$eval('.queue-item', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' '))).catch(() => [])
  const a = await page.$$eval('.activity li', (els) => els.slice(0, 15).map((e) => e.textContent)).catch(() => [])
  console.log('queue:\n  ' + q.join('\n  '))
  console.log('activity:\n  ' + a.join('\n  '))
  console.log('console tail:\n  ' + consoleTail.join('\n  '))
} finally {
  const act = await page.$$eval('.activity li', (els) => els.map((e) => e.textContent).reverse()).catch(() => [])
  console.log('\nactivity log:\n  ' + act.join('\n  '))
  const spent = ethers.formatEther(ethers.parseEther('2') - (await provider.getBalance(wallet.address)))
  console.log(`\nwallet prompts: ${prompts.tx} transactions, ${prompts.sign} signatures; spent ${spent} 0G`)
  if (errors.length) console.log('page errors:\n  ' + errors.join('\n  '))
  const pass = results.filter((r) => r.ok).length
  console.log(`${pass}/${results.length} checks passed`)
  process.exitCode = pass === results.length && errors.length === 0 ? 0 : 1
  await browser.close()
  await refund(wallet, funder.address)
}
