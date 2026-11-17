// The visual system (D32), in the browser (headless Chromium + dev server),
// with an injected wallet backed by a FRESH key funded from .env's test
// wallet (the V2 drive's setup deposit and gas, 3 small uploads; files
// deleted and wallet refunded at the end). Checks: style.css uses only the
// system's sizes, weights and radii, and spacing on the 4 px grid; on the
// page — drive (list and grid, a selection), trash, a dialog, a toast, and
// at 390 px — every text is one of the 6 sizes and 3 weights, every corner
// one of the radii, no emoji or symbol glyph stands in for an icon, Inter
// is the font, buttons are 32 or 36 px tall (28 on grid tiles), the main
// action is the brand purple; text keeps 4.5:1 contrast (3:1 when large);
// the theme follows the system until the header switch picks one, which a
// reload keeps; both themes pass the same checks; 390 px: no sideways
// scroll.
//
//   node scripts/test-visual-system.mjs [http://localhost:5173]
import { chromium } from 'playwright'
import { answerAsks } from './lib/ask.mjs'
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

// ── style.css: only the system's values
{
  const css = readFileSync(resolve(root, 'web/src/style.css'), 'utf8')
  const body = css.slice(css.indexOf('\n}\n') + 3) // after the :root tokens
  const values = (prop) => [...body.matchAll(new RegExp(`(?:^|[\\s;{])${prop}:\\s*([^;]+);`, 'g'))].map((m) => m[1].trim())
  const badSize = values('font-size').filter((v) => !/^var\(--fs-(xs|sm|md|lg|xl|2xl)\)$/.test(v) && !/^clamp\(var\(--fs-\w+\), [\d.]+vw, var\(--fs-\w+\)\)$/.test(v) && v !== 'inherit' && !/^\d+(\.\d+)?em$/.test(v))
  const badWeight = values('font-weight').filter((v) => !['400', '500', '600', 'inherit', 'normal'].includes(v))
  const badRadius = values('border-radius').filter((v) => !v.split(/\s+/).every((x) => /^var\(--r-(sm|md|lg|pill)\)$/.test(x) || ['0', '50%', 'inherit'].includes(x)))
  const spacing = ['padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'padding-inline', 'padding-block', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'margin-inline', 'margin-block', 'gap', 'row-gap', 'column-gap']
    .flatMap(values)
    .flatMap((v) => [...v.matchAll(/(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1])))
  const offGrid = [...new Set(spacing.filter((n) => n > 2 && n % 4 !== 0))]
  check('style.css: font sizes only from the 6-step scale', badSize.length === 0, JSON.stringify(badSize))
  check('style.css: weights only 400, 500, 600', badWeight.length === 0, JSON.stringify(badWeight))
  check('style.css: corners only 6, 10, 16 px or pill', badRadius.length === 0, JSON.stringify(badRadius))
  check('style.css: padding, margins and gaps on the 4 px grid', offGrid.length === 0, JSON.stringify(offGrid))
}

const SIZES = [12, 13, 14, 16, 20, 28]
const RADII = [0, 6, 10, 16]
/** What's on screen now that isn't from the system: sizes, weights, corners, glyphs; and the buttons' heights. */
const audit = () =>
  page.evaluate(({ SIZES, RADII }) => {
    const seen = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
    const name = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`
    const out = { size: {}, weight: {}, radius: {}, btn: {}, contrast: [] }
    const rgba = (c) => {
      const m = /rgba?\(([^)]+)\)/.exec(c)
      if (!m) return null
      const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
      return { r, g, b, a }
    }
    const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 })
    const lum = (c) => [c.r, c.g, c.b].map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0)
    /** the color behind `el`: its own and its ancestors' backgrounds, down to the first opaque one */
    const behind = (el) => {
      const layers = []
      for (let e = el; e; e = e.parentElement) {
        const c = rgba(getComputedStyle(e).backgroundColor)
        if (c && c.a > 0) layers.push(c)
        if (c && c.a >= 1) break
      }
      return layers.reverse().reduce((under, top) => over(top, under), { r: 255, g: 255, b: 255, a: 1 })
    }
    const faded = (el) => {
      for (let e = el; e; e = e.parentElement) if (Number(getComputedStyle(e).opacity) < 1 || e.disabled) return true
      return false
    }
    const add = (bucket, key, el) => ((out[bucket][key] ??= []).length < 3 && out[bucket][key].push(name(el)))
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('svg, iframe, .assist-panel, .preview-body, .md-page') || !seen(el)) continue
      const cs = getComputedStyle(el)
      const text = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
      if (text) {
        const fs = Number.parseFloat(cs.fontSize)
        if (!SIZES.includes(fs)) add('size', fs, el)
        if (!['400', '500', '600'].includes(cs.fontWeight)) add('weight', cs.fontWeight, el)
        if (!faded(el) && getComputedStyle(el).backgroundImage === 'none') {
          const bg = behind(el)
          const fg = over(rgba(cs.color), bg)
          const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a)
          const ratio = (hi + 0.05) / (lo + 0.05)
          const large = fs >= 24 || (fs >= 18.66 && Number(cs.fontWeight) >= 600)
          if (ratio < (large ? 3 : 4.5) && out.contrast.length < 6) out.contrast.push(`${name(el)} “${el.textContent.trim().slice(0, 24)}” ${ratio.toFixed(2)}`)
        }
      }
      for (const c of ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius']) {
        const v = cs[c]
        if (v.endsWith('%')) continue
        const r = Number.parseFloat(v)
        if (!RADII.includes(r) && r < 999) add('radius', v, el)
      }
      if (el.matches('.btn')) {
        const h = Math.round(el.getBoundingClientRect().height)
        add('btn', h, el)
      }
    }
    const glyphs = (document.body.innerText.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{27F0}-\u{27FF}\u{25B0}-\u{25FF}]/gu) ?? []).filter((g) => g !== '✓' && g !== '·')
    return { ...out, glyphs: [...new Set(glyphs)], scroll: document.documentElement.scrollWidth - window.innerWidth }
  }, { SIZES, RADII })
const clean = (a) => Object.keys(a.size).length === 0 && Object.keys(a.weight).length === 0 && Object.keys(a.radius).length === 0 && a.glyphs.length === 0 && a.contrast.length === 0
const brief = (a) => JSON.stringify({ size: a.size, weight: a.weight, radius: a.radius, glyphs: a.glyphs, contrast: a.contrast })
/** The header: the 0G mark's size and shape, and whether anything in it overlaps or spills. */
const header = () =>
  page.evaluate(() => {
    const box = (el) => el && el.getBoundingClientRect()
    const logo = box(document.querySelector('.logo-mark'))
    const brand = [...document.querySelectorAll('.brand > *')].map(box).filter((r) => r.width > 0)
    const right = [...document.querySelectorAll('.header-right > *')].map(box).filter((r) => r.width > 0)
    const brandEnd = Math.max(...brand.map((r) => r.right))
    const rightStart = Math.min(...right.map((r) => r.left))
    return { logoH: Math.round(logo.height), ratio: +(logo.width / logo.height).toFixed(2), gap: Math.round(rightStart - brandEnd), scroll: document.documentElement.scrollWidth - innerWidth }
  })
/** the 0G mark's own proportions (viewBox 160 × 78) */
const LOGO_RATIO = 160 / 78
const themeNow = () => page.evaluate(() => ({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor }))
const row = (n) => page.locator('table tbody tr', { has: page.locator('.fname-btn', { hasText: n }) })
const settled = () => page.waitForFunction(() => !document.querySelector('.progress-line.on'), null, { timeout: 3 * 60_000, polling: 200 })

answerAsks(page, (q) => (q.prompt ? 'Docs' : true))
let masterKeyHex = null
try {
  await page.goto(base)
  await page.evaluate(() => {
    localStorage.setItem('0gdrive:smart-search', 'off')
    localStorage.setItem('0gdrive:layout', 'list')
  })
  await page.reload()
  const welcome = await audit()
  check('welcome page: only the system’s sizes, weights and corners, readable contrast; no emoji', clean(welcome), brief(welcome))
  await connectExtension(page)
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: 'New folder', exact: true }).waitFor({ timeout: 5 * 60_000 })
  masterKeyHex = await page.evaluate((a) => localStorage.getItem('0gdrive:masterkey:' + a.toLowerCase()), wallet.address)

  const font = await page.evaluate(async () => {
    await document.fonts.ready
    // Inter comes as one file per script (Latin, Cyrillic, …): the Latin one is used here
    const faces = [...document.fonts].filter((f) => f.family.replace(/"/g, '') === 'Inter Variable')
    return { family: getComputedStyle(document.body).fontFamily, loaded: faces.some((f) => f.status === 'loaded') }
  })
  check('Inter is the font, bundled and loaded', /^"?Inter Variable"?/.test(font.family) && font.loaded, JSON.stringify(font))

  const NAMES = ['notes.txt', 'plan.md', 'photo.png']
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  await page.setInputFiles('.dropzone input[type=file]', [
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes\n') },
    { name: 'plan.md', mimeType: 'text/markdown', buffer: Buffer.from('# Plan\n') },
    { name: 'photo.png', mimeType: 'image/png', buffer: png },
  ])
  await page.waitForFunction((n) => n.every((x) => [...document.querySelectorAll('table .fname-btn')].some((b) => b.textContent.includes(x))), NAMES, { timeout: 8 * 60_000, polling: 1000 })
  await page.getByRole('button', { name: 'New folder', exact: true }).click()
  await page.locator('.sidebar .tree-name', { hasText: /^Docs$/ }).waitFor({ timeout: 3 * 60_000 })
  await settled()

  // list view, with the upload queue, a selection and a toast
  await row('notes.txt').locator('input[type=checkbox]').check()
  await page.getByRole('button', { name: 'Sync' }).click()
  await page.locator('.toast').waitFor({ timeout: 60_000 })
  const list = await audit()
  check('drive, list view (queue, selection bar, toast): only the system’s sizes, weights and corners, readable contrast; no emoji', clean(list), brief(list))
  const heights = Object.keys(list.btn).map(Number)
  check('buttons are 32 or 36 px tall', heights.length > 0 && heights.every((h) => h === 32 || h === 36), JSON.stringify(list.btn))
  const primary = await page.evaluate(() => {
    const b = document.querySelector('.btn.primary')
    return b ? getComputedStyle(b).backgroundColor : null
  })
  check('a main action is the brand purple (light: #8200d1)', primary === null || primary === 'rgb(130, 0, 209)', String(primary))
  await row('notes.txt').locator('input[type=checkbox]').uncheck()

  // nothing in the sidebar sticks out of it (its Security rows once pushed their buttons past the edge)
  const spill = () =>
    page.evaluate(() => {
      const sb = document.querySelector('.sidebar').getBoundingClientRect()
      return [...document.querySelectorAll('.sidebar *')]
        .filter((e) => e.getClientRects().length > 0 && e.getBoundingClientRect().width > 0)
        .filter((e) => { const r = e.getBoundingClientRect(); return r.right > sb.right + 0.5 || r.left < sb.left - 0.5 })
        .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')} "${e.textContent.trim().slice(0, 20)}"`)
    })
  const deskSpill = await spill()
  check('sidebar: nothing sticks out of it (1280 px)', deskSpill.length === 0, JSON.stringify(deskSpill))

  const desk = await header()
  check('header: the 0G mark is 28 px tall and keeps its shape', desk.logoH === 28 && Math.abs(desk.ratio - LOGO_RATIO) < 0.05 && desk.gap > 0, JSON.stringify(desk))

  // a dialog
  await row('plan.md').getByRole('button', { name: 'Rename' }).click()
  await page.locator('.rename-modal').waitFor()
  await page.locator('.rename-modal input').fill('a/b')
  const dialog = await audit()
  check('rename dialog (with an error): only the system’s sizes, weights and corners, readable contrast; no emoji', clean(dialog), brief(dialog))
  await page.keyboard.press('Escape')

  // grid view
  await page.getByRole('button', { name: 'Grid view' }).click()
  await page.locator('.tile').first().waitFor()
  const grid = await audit()
  check('drive, grid view: only the system’s sizes, weights and corners, readable contrast; no emoji', clean(grid), brief(grid))
  await page.getByRole('button', { name: 'List view' }).click()

  // trash
  await row('notes.txt').getByRole('button', { name: 'Move to trash' }).click()
  await settled()
  await page.locator('[data-guide="trash"]').click()
  await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 1, null, { timeout: 60_000 })
  const trash = await audit()
  check('trash: only the system’s sizes, weights and corners, readable contrast; no emoji', clean(trash), brief(trash))

  // the theme: the system's (light here), then dark as the system changes, then the switch's, kept on reload
  const sys = await themeNow()
  check('the theme follows the system: light', sys.theme === 'light' && sys.bg === 'rgb(246, 246, 248)', JSON.stringify(sys))
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark', null, { timeout: 5000 }).catch(() => undefined)
  const sysDark = await themeNow()
  check('…and dark when the system turns dark', sysDark.theme === 'dark' && sysDark.bg === 'rgb(10, 10, 12)', JSON.stringify(sysDark))
  await page.locator('.nav-item', { hasText: 'My drive' }).first().click().catch(() => undefined)
  await page.locator('table tbody tr').first().waitFor({ timeout: 60_000 })
  await page.waitForTimeout(600) // colors ease over 0.12 s
  const dark = await audit()
  check('dark theme, drive: only the system’s sizes, weights and corners, readable contrast; no emoji', clean(dark), brief(dark))
  await page.getByRole('button', { name: 'Switch to light theme' }).click()
  const picked = await themeNow()
  await page.reload()
  await page.locator('table tbody tr').first().waitFor({ timeout: 3 * 60_000 })
  const kept = await themeNow()
  check('the header switch picks light over the dark system, and a reload keeps it', picked.theme === 'light' && kept.theme === 'light' && kept.bg === 'rgb(246, 246, 248)', JSON.stringify({ picked, kept }))
  check('switch is named for what it does', (await page.getByRole('button', { name: 'Switch to dark theme' }).count()) === 1)

  // 390 px
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(400)
  const phone = await audit()
  check('390 px: only the system’s sizes, weights and corners, readable contrast; no emoji; no sideways scroll', clean(phone) && phone.scroll <= 0, `${brief(phone)} scroll ${phone.scroll}`)
  await page.getByRole('button', { name: 'Folders and settings' }).click()
  await page.waitForTimeout(400)
  const phoneSpill = await spill()
  check('sidebar drawer: nothing sticks out of it (390 px)', phoneSpill.length === 0, JSON.stringify(phoneSpill))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const p390 = await header()
  await page.setViewportSize({ width: 360, height: 780 })
  await page.waitForTimeout(300)
  const p360 = await header()
  check('phone header (menu button, 0G mark, wallet): the mark is 24 px tall, keeps its shape, nothing overlaps at 390 and 360 px',
    [p390, p360].every((h) => h.logoH === 24 && Math.abs(h.ratio - LOGO_RATIO) < 0.05 && h.gap >= 8 && h.scroll <= 0), JSON.stringify({ p390, p360 }))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Wallet menu' }).click()
  const inMenu = await page.evaluate(() => ({
    balance: document.querySelector('.wallet-menu-balance')?.textContent ?? '',
    headerSwitch: document.querySelector('.header-right .theme-switch')?.getBoundingClientRect().width ?? 0,
  }))
  await page.getByRole('menuitem', { name: 'Dark theme' }).click()
  const fromMenu = await themeNow()
  check('phone: the wallet balance and the theme switch are in the wallet menu, and the switch works',
    /^Wallet balance: [\d.]+ 0G$/.test(inMenu.balance) && inMenu.headerSwitch === 0 && fromMenu.theme === 'dark', JSON.stringify({ ...inMenu, fromMenu }))
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
