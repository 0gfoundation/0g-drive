// Welcome panel (before a wallet is connected), in the browser (headless
// Chromium + dev server). Spends nothing: the mock wallet is unfunded.
//   tagline + Get started shown, upload box and empty file list hidden
//   Get started connects the wallet → the panel gives way to the drive setup
//   no wallet installed → install hint instead of the button
//   phone width: no overflow, full-width ≥44 px button, headline fits
//
//   node scripts/test-welcome.mjs [http://localhost:5173]
import { chromium } from 'playwright'
import { ethers } from 'ethers'
import { getNetworkConfig } from '../core/dist/index.js'

const base = process.argv[2] ?? 'http://localhost:5173'
const network = getNetworkConfig('testnet', 'turbo')
const provider = new ethers.JsonRpcProvider(network.rpcUrl)
const t0 = Date.now()
const el = () => `[${((Date.now() - t0) / 1000).toFixed(0)}s]`

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${el()} ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const TAGLINE = 'Your files, for your eyes only.'
const browser = await chromium.launch()
const errors = []

async function open({ withWallet = true, viewport = { width: 1280, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  if (withWallet) {
    const key = ethers.Wallet.createRandom()
    await page.exposeFunction('__eth', async (method, params) => {
      try {
        switch (method) {
          case 'eth_requestAccounts':
          case 'eth_accounts':
            return { ok: [key.address] }
          case 'eth_chainId':
            return { ok: network.chainIdHex.toLowerCase() }
          case 'net_version':
            return { ok: String(network.chainId) }
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
  }
  await page.goto(base)
  return { context, page }
}

const state = (page) =>
  page.evaluate(() => ({
    h1: [...document.querySelectorAll('h1')].map((h) => h.textContent),
    welcome: !!document.querySelector('.welcome'),
    dropzone: !!document.querySelector('.dropzone'),
    files: !!document.querySelector('section.files'),
    cta: !!document.querySelector('.welcome-cta'),
  }))

try {
  {
    const { context, page } = await open()
    await page.locator('.welcome').waitFor()
    const s = await state(page)
    check('welcome: tagline is the page’s only h1, with Get started', s.h1.length === 1 && s.h1[0] === TAGLINE && s.cta, JSON.stringify(s))
    check('welcome: no disabled upload box or empty "My drive" before connecting', !s.dropzone && !s.files, JSON.stringify(s))
    await page.getByRole('button', { name: 'Get started' }).click()
    await page.getByRole('button', { name: 'Create my drive' }).waitFor({ timeout: 120_000 })
    const after = await state(page)
    check('Get started connects; the panel gives way to the drive', !after.welcome && after.dropzone && after.files, JSON.stringify(after))
    await context.close()
  }
  {
    const { context, page } = await open({ withWallet: false })
    await page.locator('.welcome').waitFor()
    const s = await state(page)
    const hint = await page.locator('.welcome').textContent()
    check('no wallet: install hint instead of the button', !s.cta && /Install a wallet extension/.test(hint), JSON.stringify(s))
    await context.close()
  }
  {
    const { context, page } = await open({ viewport: { width: 390, height: 844 } })
    await page.locator('.welcome').waitFor()
    const m = await page.evaluate(() => {
      const r = (sel) => document.querySelector(sel).getBoundingClientRect()
      const panel = r('.welcome'), h1 = r('.welcome h1'), cta = r('.welcome-cta')
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        panel: [Math.round(panel.left), Math.round(panel.right)],
        h1: [Math.round(h1.left), Math.round(h1.right)],
        cta: { width: Math.round(cta.width), height: Math.round(cta.height), panelInner: Math.round(panel.width) },
      }
    })
    check('phone: no overflow, headline inside the panel, full-width ≥44 px button',
      m.overflow <= 0 && m.panel[0] >= 0 && m.panel[1] <= 390 && m.h1[0] >= m.panel[0] && m.h1[1] <= m.panel[1] &&
        m.cta.height >= 44 && m.cta.width >= m.cta.panelInner - 40, JSON.stringify(m))
    await context.close()
  }
} catch (e) {
  check('run completed', false, e.message.split('\n').slice(0, 6).join(' | '))
} finally {
  await browser.close()
}

if (errors.length) console.log(errors.join('\n'))
const passed = results.filter((r) => r.ok).length
console.log(`${passed}/${results.length} checks passed`)
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
