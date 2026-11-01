// "Open in wallet app" on phones (headless Chromium + dev server; no wallet
// funds, nothing sent):
//   a phone with no wallet: four wallet-app links with the wallets'
//   documented formats for this page, thumb-sized, fitting 390 px, and a
//   "copy link" for other wallets; no desktop "install an extension" banner
//   the same phone inside a wallet app (a wallet injected): "Get started"
//   a desktop with no wallet: the install hint, no wallet-app links
//
//   node scripts/test-open-in-wallet.mjs [http://localhost:5173]
import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://localhost:5173'
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const browser = await chromium.launch()
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
const errors = []
const open = async (opts, wallet = false) => {
  const context = await browser.newContext(opts)
  if (wallet) {
    await context.addInitScript(() => {
      window.ethereum = { request: async () => [], on() {}, removeListener() {} }
    })
  }
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(base)
  await page.locator('#welcome-title').waitFor({ timeout: 30_000 })
  return page
}

try {
  let page = await open(phone)
  const url = await page.evaluate(() => location.href)
  const links = await page.$$eval('.wallet-apps a', (els) =>
    els.map((a) => {
      const r = a.getBoundingClientRect()
      return { name: a.textContent.trim(), href: a.getAttribute('href'), left: r.left, right: r.right, h: Math.round(r.height) }
    })
  )
  const enc = encodeURIComponent(url)
  const want = {
    MetaMask: `https://link.metamask.io/dapp/${url.replace(/^https?:\/\//, '')}`,
    'Trust Wallet': `https://link.trustwallet.com/open_url?coin_id=60&url=${enc}`,
    'OKX Wallet': `https://web3.okx.com/download?deeplink=${encodeURIComponent(`okx://wallet/dapp/url?dappUrl=${enc}`)}`,
    'Coinbase Wallet': `https://go.cb-w.com/dapp?cb_url=${enc}`,
  }
  check(
    'phone, no wallet: MetaMask, Trust, OKX and Coinbase links in their documented formats for this page',
    links.length === 4 && links.every((l) => want[l.name] === l.href),
    JSON.stringify(links.map((l) => [l.name, l.href]))
  )
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  check(
    'phone: the links fit 390 px and are thumb-sized',
    overflow <= 0 && links.every((l) => l.left >= 0 && l.right <= 390 && l.h >= 44),
    JSON.stringify({ overflow, heights: links.map((l) => l.h) })
  )
  check(
    'phone: "copy link" for other wallets, no desktop "install an extension" banner',
    (await page.getByRole('button', { name: /copy this page/i }).count()) === 1 &&
      (await page.locator('.banner.warn', { hasText: 'No Ethereum wallet detected' }).count()) === 0
  )
  await page.context().close()

  page = await open(phone, true)
  check(
    'phone inside a wallet app (wallet injected): "Get started", no wallet-app links',
    (await page.getByRole('button', { name: 'Get started' }).count()) === 1 && (await page.locator('.wallet-apps').count()) === 0
  )
  await page.context().close()

  page = await open({ viewport: { width: 1280, height: 900 } })
  check(
    'desktop, no wallet: the install hint, no wallet-app links',
    (await page.getByText('Install a wallet extension').count()) > 0 && (await page.locator('.wallet-apps').count()) === 0
  )
  check('no page errors', errors.length === 0, errors.join('; '))
} catch (err) {
  check('run completed', false, err.message.split('\n')[0])
} finally {
  await browser.close()
}
const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} checks passed`)
process.exit(passed === results.length ? 0 : 1)
