// Wallet picker (EIP-6963) and the signature safety net, in the browser
// (headless Chromium + dev server). Wallets are mocks backed by fresh,
// unfunded keys, so this spends nothing:
//   two announced wallets → "Choose a wallet" lists both; the chosen one
//   connects and the other gets no request; after a reload it's listed
//   first as "Last used"; Escape dismisses with no request; phone width
//   one wallet that only sets window.ethereum → connects with no picker
//   a wallet that signs with a random nonce → recovery setup refused
//   after 2 signatures, before any transaction
//   a wallet that returns a non-ECDSA (smart-account) signature → refused
//   after 1 signature
//
//   node scripts/test-wallet-picker.mjs [http://localhost:5173]
import { chromium } from 'playwright'
import { ethers } from 'ethers'
import { secp256k1 } from '@noble/curves/secp256k1'
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

const ICON = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#f80"/></svg>').toString('base64')

/** sign: 'ok' (RFC 6979), 'random' (random nonce), 'contract' (not ECDSA) */
function mockWallet(name, rdns, sign = 'ok') {
  // two accounts: wallet_requestPermissions stands for the user picking the other one
  const keys = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom()]
  let current = 0
  let connected = false
  const calls = []
  const personalSign = async (data) => {
    const msg = ethers.isHexString(data) ? ethers.getBytes(data) : data
    const key = keys[current]
    if (sign === 'ok') return key.signMessage(msg)
    if (sign === 'contract') return '0x' + 'ab'.repeat(300)
    const sig = secp256k1.sign(ethers.getBytes(ethers.hashMessage(msg)), ethers.getBytes(key.privateKey), { extraEntropy: true })
    return ethers.Signature.from({ r: ethers.toBeHex(sig.r, 32), s: ethers.toBeHex(sig.s, 32), v: 27 + sig.recovery }).serialized
  }
  const handle = async (method, params) => {
    calls.push(method)
    switch (method) {
      case 'eth_requestAccounts':
        connected = true
        return [keys[current].address]
      case 'eth_accounts':
        return connected ? [keys[current].address] : []
      case 'wallet_requestPermissions':
        current = connected ? 1 - current : current
        connected = true
        return [{ parentCapability: 'eth_accounts' }]
      case 'wallet_revokePermissions':
        connected = false
        return null
      case 'eth_chainId':
        return network.chainIdHex.toLowerCase()
      case 'net_version':
        return String(network.chainId)
      case 'personal_sign':
        return personalSign(params[0])
      case 'eth_sendTransaction':
        throw new Error('test wallet has no funds')
      default:
        return provider.send(method, params ?? [])
    }
  }
  return {
    name, rdns, calls, handle,
    count: (m) => calls.filter((c) => c === m).length,
    address: () => keys[current].address,
    use: (i) => { current = i; connected = true },
    drop: () => { connected = false },
  }
}

const browser = await chromium.launch()
const errors = []

/** A page with these wallets: all announced via EIP-6963, unless `announce` is false (then only window.ethereum = the first). */
async function open(wallets, { announce = true, viewport = { width: 1280, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.exposeFunction('__wallet', async (i, method, params) => {
    try {
      return { ok: await wallets[i].handle(method, params) }
    } catch (e) {
      return { err: e.shortMessage ?? e.message }
    }
  })
  const infos = wallets.map((w, i) => ({ uuid: `uuid-${i}`, name: w.name, rdns: w.rdns, icon: i === 0 ? ICON : '' }))
  await context.addInitScript(({ infos, announce }) => {
    const providers = infos.map((_, i) => ({
      async request({ method, params }) {
        const r = await window.__wallet(i, method, params)
        if (r.err) throw Object.assign(new Error(r.err), { code: -32000 })
        return r.ok
      },
      on(ev, h) {
        ;((window.__handlers ??= {})[`${i}:${ev}`] ??= []).push(h)
      },
      removeListener(ev, h) {
        const list = window.__handlers?.[`${i}:${ev}`] ?? []
        list.splice(list.indexOf(h), 1)
      },
    }))
    // the test makes a wallet fire an event, as when the user acts in it
    window.__emit = (i, ev, arg) => (window.__handlers?.[`${i}:${ev}`] ?? []).forEach((h) => h(arg))
    window.ethereum = providers[0]
    if (!announce) return
    const fire = () =>
      infos.forEach((info, i) =>
        window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider: providers[i] }) }))
      )
    window.addEventListener('eip6963:requestProvider', fire)
    fire()
  }, { infos, announce })
  return { context, page }
}

const pickerNames = (page) => page.$$eval('.wallet-picker .wallet-name', (els) => els.map((e) => e.textContent))

try {
  // ── two wallets: picker ──
  const alpha = mockWallet('Alpha Wallet', 'com.example.alpha')
  const beta = mockWallet('Beta Wallet', 'com.example.beta')
  {
    const { context, page } = await open([alpha, beta])
    await page.goto(base)
    await page.getByRole('button', { name: 'Connect wallet' }).click()
    await page.locator('.wallet-picker').waitFor()
    const names = await pickerNames(page)
    const icons = await page.$$eval('.wallet-picker .wallet-option img', (els) => els.length)
    check('two wallets: picker lists both, with the announced icon', names.length === 2 && names.includes('Alpha Wallet') && names.includes('Beta Wallet') && icons === 1, JSON.stringify({ names, icons }))

    await page.keyboard.press('Escape')
    await page.locator('.wallet-picker').waitFor({ state: 'detached' })
    check('Escape dismisses it, no wallet asked to connect',
      alpha.count('eth_requestAccounts') === 0 && beta.count('eth_requestAccounts') === 0)

    await page.getByRole('button', { name: 'Connect wallet' }).click()
    await page.getByRole('button', { name: /Beta Wallet/ }).click()
    await page.getByRole('button', { name: 'Create my drive' }).waitFor({ timeout: 120_000 })
    check('the chosen wallet connects; the other gets no request',
      beta.count('eth_requestAccounts') === 1 && alpha.calls.length === 0, JSON.stringify({ alpha: alpha.calls.length, beta: beta.calls.length }))

    await page.reload()
    await page.getByRole('button', { name: 'Create my drive' }).waitFor({ timeout: 120_000 })
    check('after a reload, the last-used wallet reconnects by itself, without a prompt',
      beta.count('eth_requestAccounts') === 1 && alpha.count('eth_requestAccounts') === 0,
      JSON.stringify({ beta: beta.calls.slice(-4) }))
    await page.getByRole('button', { name: 'Wallet menu' }).click()
    await page.getByRole('menuitem', { name: 'Switch wallet or account' }).click()
    await page.locator('.wallet-picker').waitFor()
    const first = await page.$eval('.wallet-picker .wallet-option', (e) => e.textContent)
    check('Switch wallet: the picker opens, the last-used wallet first and marked', first === 'Beta WalletLast used', JSON.stringify(first))
    await page.keyboard.press('Escape')
    await context.close()
  }

  // ── switching accounts and disconnecting ──
  {
    const w = mockWallet('Gamma Wallet', 'com.example.gamma')
    const { context, page } = await open([w])
    const shown = () => page.locator('.address').getAttribute('title')
    const emit = (addr) => page.evaluate((a) => window.__emit(0, 'accountsChanged', a ? [a] : []), addr).catch(() => {})
    const onAccount = (addr) =>
      page.waitForFunction((a) => document.querySelector('.address')?.getAttribute('title') === a, addr, { timeout: 120_000 })
    await page.goto(base)
    await page.getByRole('button', { name: 'Connect wallet' }).click()
    await page.getByRole('button', { name: 'Create my drive' }).waitFor({ timeout: 120_000 })
    const A = w.address()

    // wallets also announce the account on connect: the same one changes nothing
    await page.evaluate(() => (window.__marker = 1))
    await emit(A)
    await page.waitForTimeout(1500)
    check('the same account announced again: nothing happens', await page.evaluate(() => window.__marker === 1))

    // the user picks another account in the wallet
    w.use(1)
    const B = w.address()
    await emit(B)
    await onAccount(B)
    await page.getByRole('button', { name: 'Create my drive' }).waitFor({ timeout: 120_000 })
    check('another account in the wallet: the app starts over in it, nothing of the first left',
      (await page.evaluate(() => window.__marker)) === undefined && (await shown()) === B)

    // the menu at phone width
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Wallet menu' }).click()
    const menu = await page.evaluate(() => {
      const m = document.querySelector('.wallet-menu').getBoundingClientRect()
      const items = [...document.querySelectorAll('.wallet-menu [role=menuitem]')].map((b) => Math.round(b.getBoundingClientRect().height))
      const btn = document.querySelector('.wallet-menu-btn').getBoundingClientRect()
      return { left: Math.round(m.left), right: Math.round(m.right), items, btn: Math.round(btn.width), overflow: document.documentElement.scrollWidth - innerWidth }
    })
    await page.keyboard.press('Escape')
    const closed = (await page.locator('.wallet-menu').count()) === 0
    check('phone: wallet menu inside the screen, ≥44 px items, Escape closes it',
      menu.left >= 0 && menu.right <= 390 && menu.overflow <= 0 && menu.items.length === 2 && menu.items.every((h) => h >= 44) && menu.btn >= 30 && closed,
      JSON.stringify({ ...menu, closed }))
    await page.setViewportSize({ width: 1280, height: 900 })

    // Switch wallet or account: the wallet shows its accounts (here: picks A)
    await page.getByRole('button', { name: 'Wallet menu' }).click()
    await page.getByRole('menuitem', { name: 'Switch wallet or account' }).click()
    await onAccount(A)
    await page.getByRole('button', { name: 'Create my drive' }).waitFor({ timeout: 120_000 })
    check('Switch wallet or account: asks the wallet, then the app reloads into the chosen account',
      w.count('wallet_requestPermissions') === 1 && (await shown()) === A)

    // Disconnect, and stay disconnected across a reload
    await page.getByRole('button', { name: 'Wallet menu' }).click()
    await page.getByRole('menuitem', { name: 'Disconnect' }).click()
    await page.getByRole('button', { name: 'Connect wallet' }).waitFor({ timeout: 60_000 })
    await page.reload()
    await page.getByRole('button', { name: 'Connect wallet' }).waitFor({ timeout: 60_000 })
    check('Disconnect: back to the start screen, and a reload stays disconnected',
      w.count('wallet_revokePermissions') === 1 && (await page.locator('.address').count()) === 0)
    await page.getByRole('button', { name: 'Connect wallet' }).click()
    await page.getByRole('button', { name: 'Create my drive' }).waitFor({ timeout: 120_000 })
    await page.reload()
    await page.getByRole('button', { name: 'Create my drive' }).waitFor({ timeout: 120_000 })
    check('connecting again: the next reload reconnects by itself', (await shown()) === A)

    // the wallet disconnects the site itself
    w.drop()
    await emit(null)
    await page.getByRole('button', { name: 'Connect wallet' }).waitFor({ timeout: 60_000 })
    check('the wallet drops the site: back to the start screen', (await page.locator('.address').count()) === 0)
    await context.close()
  }

  // ── phone width ──
  {
    const { context, page } = await open([alpha, beta], { viewport: { width: 390, height: 844 } })
    await page.goto(base)
    await page.getByRole('button', { name: 'Connect wallet' }).click()
    await page.locator('.wallet-picker').waitFor()
    await page.waitForTimeout(300)
    const m = await page.evaluate(() => {
      const sheet = document.querySelector('.wallet-picker').getBoundingClientRect()
      const opts = [...document.querySelectorAll('.wallet-picker .wallet-option')].map((b) => b.getBoundingClientRect())
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        sheet: { x: Math.round(sheet.x), width: Math.round(sheet.width), bottom: Math.round(sheet.bottom) },
        minHeight: Math.min(...opts.map((o) => Math.round(o.height))),
      }
    })
    check('phone: bottom sheet, full width, ≥44 px options, no overflow',
      m.overflow <= 0 && m.sheet.x === 0 && m.sheet.width === 390 && m.sheet.bottom === 844 && m.minHeight >= 44, JSON.stringify(m))
    await context.close()
  }

  // ── one wallet, not announced: no picker ──
  {
    const solo = mockWallet('Solo', 'com.example.solo')
    const { context, page } = await open([solo], { announce: false })
    await page.goto(base)
    await page.getByRole('button', { name: 'Connect wallet' }).click()
    await page.getByRole('button', { name: 'Create my drive' }).waitFor({ timeout: 120_000 })
    check('one wallet (window.ethereum only): connects with no picker',
      (await page.locator('.wallet-picker').count()) === 0 && solo.count('eth_requestAccounts') === 1)
    await context.close()
  }

  // ── safety net ──
  for (const [sign, name, wantSigs, pattern] of [
    ['random', 'a wallet that signs with a random nonce', 2, /different signature when asked to sign the same message twice/],
    ['contract', 'a smart-account (non-ECDSA) signature', 1, /isn’t a standard signature by your address/],
  ]) {
    const w = mockWallet('Odd Wallet', 'com.example.odd', sign)
    const { context, page } = await open([w])
    await page.goto(base)
    await page.getByRole('button', { name: 'Connect wallet' }).click()
    await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
    await page.getByRole('button', { name: 'Set up recovery' }).click({ timeout: 120_000 })
    const err = page.getByText(pattern).first()
    await err.waitFor({ timeout: 60_000 })
    const text = await err.textContent()
    check(`${name}: recovery refused before any transaction (${wantSigs} signature${wantSigs > 1 ? 's' : ''}), points to the key file`,
      w.count('personal_sign') === wantSigs && w.count('eth_sendTransaction') === 0 && /Export the key file/.test(text) &&
        (await page.locator('.sec-row[data-row=recovery] .sec-ok').count()) === 0,
      JSON.stringify({ sign: w.count('personal_sign'), tx: w.count('eth_sendTransaction'), text: text.slice(0, 120) }))
    await context.close()
  }
} catch (e) {
  check('run completed', false, e.message.split('\n').slice(0, 12).join(' | '))
} finally {
  await browser.close()
}

if (errors.length) console.log(errors.join('\n'))
const passed = results.filter((r) => r.ok).length
console.log(`${passed}/${results.length} checks passed`)
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
