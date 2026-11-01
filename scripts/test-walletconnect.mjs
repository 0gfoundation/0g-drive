// WalletConnect, end to end (headless Chromium, no wallet in the browser,
// and a scripted wallet in Node that pairs through WalletConnect's real
// relay, as a phone wallet would). A FRESH funded wallet; spends a little:
//   desktop: "Get started with a phone wallet" → QR code; the wallet pairs
//   with the code's link and the drive opens; recovery setup (2 signatures,
//   1 tx) and an upload (1 tx) are approved in the wallet, with an "approve
//   on your phone" note while it waits; no WalletConnect analytics and no
//   reads through WalletConnect's RPC
//   a reload reconnects the session without a prompt
//   the same account in a browser wallet restores the same drive (the
//   signatures over WalletConnect match the extension's)
//   Disconnect ends the session in the wallet too
//   phone (390 px): "Connect your wallet app" + the wallet-app browser
//   links; the dialog's wallet links carry the pairing link and fit; pairing
//   opens the drive; a pending request shows "Open <wallet>" linking back
//   to the wallet app
//   phone, like MetaMask: a declined pairing says why on the start page;
//   a wallet that approves another chain first, then switches when asked,
//   opens the drive; a reload brings the drive back by itself
//   the app gives wallets no link back (it would open a new tab, leaving
//   the user's tab and its uploads behind)
//
//   node scripts/test-walletconnect.mjs [http://localhost:5173]
// The page must be built with VITE_WALLETCONNECT_PROJECT_ID; the scripted
// wallet uses the same project ID (WALLETCONNECT_PROJECT_ID, else
// web/.env.local).
import { chromium } from 'playwright'
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SignClient } from '@walletconnect/sign-client'
import { getNetworkConfig } from '../core/dist/index.js'
import { refund } from './lib/refund.mjs'

const base = process.argv[2] ?? 'http://localhost:5173'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const funderKey = /^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(readFileSync(resolve(root, '.env'), 'utf8'))[1]
const projectId =
  process.env.WALLETCONNECT_PROJECT_ID ??
  (() => {
    try {
      return /^VITE_WALLETCONNECT_PROJECT_ID=(\S+)/m.exec(readFileSync(resolve(root, 'web/.env.local'), 'utf8'))?.[1]
    } catch {
      return undefined
    }
  })()
if (!projectId) throw new Error('set WALLETCONNECT_PROJECT_ID (or VITE_WALLETCONNECT_PROJECT_ID in web/.env.local)')

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
step(`fresh wallet ${wallet.address} funded with 1 0G`)

// ── the scripted phone wallet ──
const WALLET_LINK = 'https://wallet.example/app'
const memory = new Map()
const wc = await SignClient.init({
  projectId,
  telemetryEnabled: false,
  logger: 'error',
  metadata: { name: 'Test Wallet', description: '0GDrive test', url: 'https://wallet.example', icons: [], redirect: { universal: WALLET_LINK } },
  // in memory: nothing left on disk between runs
  storage: {
    getKeys: async () => [...memory.keys()],
    getEntries: async () => [...memory.entries()],
    getItem: async (k) => memory.get(k),
    setItem: async (k, v) => void memory.set(k, v),
    removeItem: async (k) => void memory.delete(k),
  },
})
const prompts = { tx: 0, sign: 0, other: [] }
let holdNext = 0 // ms to wait before answering the next request (the user reading it)
let deleted = 0
const proposers = []
let declineNext = false
let otherChainFirst = false // like MetaMask: approve the chain it's on, switch when asked
wc.on('session_delete', () => deleted++)
wc.on('session_proposal', async ({ id, params }) => {
  proposers.push(params.proposer.metadata)
  if (declineNext) {
    declineNext = false
    await wc.reject({ id, reason: { code: 5000, message: 'User rejected.' } })
    return
  }
  const chain = otherChainFirst ? 'eip155:1' : `eip155:${network.chainId}`
  const ns = params.optionalNamespaces?.eip155 ?? params.requiredNamespaces?.eip155
  await wc.approve({
    id,
    namespaces: {
      eip155: {
        chains: [chain],
        accounts: [`${chain}:${wallet.address}`],
        methods: ns.methods,
        events: ns.events,
      },
    },
  })
})
wc.on('session_request', async ({ topic, id, params }) => {
  const { method, params: p } = params.request
  const respond = (response) => wc.respond({ topic, response: { id, jsonrpc: '2.0', ...response } })
  try {
    if (holdNext) {
      await new Promise((r) => setTimeout(r, holdNext))
      holdNext = 0
    }
    let result
    switch (method) {
      case 'personal_sign':
        prompts.sign++
        result = await wallet.signMessage(ethers.isHexString(p[0]) ? ethers.getBytes(p[0]) : p[0])
        break
      case 'eth_sendTransaction': {
        prompts.tx++
        const tx = p[0]
        const sent = await wallet.sendTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value ? BigInt(tx.value) : 0n,
          gasLimit: tx.gas ? BigInt(tx.gas) : undefined,
        })
        result = sent.hash
        break
      }
      case 'wallet_switchEthereumChain': {
        // as MetaMask does: add the chain to the session, then say so
        prompts.other.push(method)
        const chain = `eip155:${Number(p[0].chainId)}`
        const ns = wc.session.get(topic).namespaces.eip155
        const chains = [...new Set([...ns.chains, chain])]
        await wc.update({ topic, namespaces: { eip155: { ...ns, chains, accounts: chains.map((c) => `${c}:${wallet.address}`) } } })
        await wc.emit({ topic, chainId: chain, event: { name: 'chainChanged', data: Number(p[0].chainId) } })
        result = null
        break
      }
      default:
        prompts.other.push(method)
        result = null
    }
    await respond({ result })
  } catch (e) {
    await respond({ error: { code: -32000, message: e.shortMessage ?? e.message } })
  }
})

const browser = await chromium.launch()
const errors = []
const requests = []
async function open(opts) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(base).origin })
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('request', (r) => requests.push(r.url()))
  page.on('websocket', (ws) => requests.push(ws.url()))
  page.on('dialog', (d) => d.accept())
  await page.goto(base)
  await page.evaluate(() => localStorage.setItem('0gdrive:layout', 'list'))
  return { context, page }
}
/** The pairing link, via the dialog's "Copy the connection link". */
async function pairingLink(page) {
  await page.getByRole('button', { name: 'Copy the connection link' }).click()
  await page.getByRole('button', { name: 'Link copied' }).waitFor()
  return page.evaluate(() => navigator.clipboard.readText())
}

let desktop
try {
  // ── desktop, no extension ──
  desktop = await open()
  let { page } = desktop
  const cta = page.getByRole('button', { name: 'Get started with a phone wallet' })
  await cta.waitFor({ timeout: 30_000 })
  check(
    'desktop, no extension: the start button offers a phone wallet; the banner mentions WalletConnect',
    (await page.locator('.banner.warn', { hasText: 'WalletConnect' }).count()) === 1
  )
  await cta.click()
  await page.locator('.wc-dialog .wc-qr').waitFor({ timeout: 30_000 })
  const qr = await page.$eval('.wc-qr', (s) => {
    const r = s.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height), path: s.querySelector('path')?.getAttribute('d')?.length ?? 0 }
  })
  const uri = await pairingLink(page)
  check('the QR dialog opens with a WalletConnect pairing link (no wallet list to pick from first)',
    uri.startsWith('wc:') && qr.w >= 200 && qr.w === qr.h && qr.path > 1000, JSON.stringify({ uri: uri.slice(0, 20), qr }))

  await wc.pair({ uri })
  await page.getByRole('button', { name: 'Create my drive' }).waitFor({ timeout: 120_000 })
  check('the app gives the wallet no link back (it would open a new tab, away from the user’s)',
    proposers.length === 1 && !proposers[0].redirect, JSON.stringify(proposers[0].redirect ?? null))
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 120_000 })
  check('the wallet approves; the dialog closes and the drive is created',
    (await page.locator('.wc-dialog').count()) === 0 && (await page.locator('.address').getAttribute('title')) === wallet.address)

  holdNext = 3000
  await page.getByRole('button', { name: 'Set up recovery' }).click({ timeout: 120_000 })
  const bar = await page.locator('.wc-approve').textContent({ timeout: 10_000 }).catch(() => null)
  await page.locator('.sec-row[data-row=share-key] .sec-ok').waitFor({ timeout: 5 * 60_000 })
  check('recovery setup over WalletConnect: 2 signatures, 1 transaction',
    prompts.sign === 2 && prompts.tx === 1, JSON.stringify(prompts))
  check('while the wallet has a request: "Approve on your phone, in Test Wallet", no app link on a desktop',
    bar === 'Approve on your phone, in Test Wallet.' && (await page.locator('.wc-approve').count()) === 0, JSON.stringify(bar))

  const NAME = `wc-${Date.now()}.txt`
  await page.setInputFiles('.dropzone input[type=file]', [{ name: NAME, mimeType: 'text/plain', buffer: Buffer.from('sent through WalletConnect') }])
  await page.locator('table .fname-btn', { hasText: NAME }).waitFor({ timeout: 10 * 60_000 })
  check('an upload approved over WalletConnect', prompts.tx === 2, JSON.stringify(prompts))

  const wcHosts = [...new Set(requests.filter((u) => /walletconnect\.(org|com)|reown\.com/.test(u)).map((u) => new URL(u).host))]
  check('WalletConnect traffic is the relay only: no analytics (pulse), no reads through its RPC',
    wcHosts.every((h) => !/^(pulse|rpc)\./.test(h)) && wcHosts.some((h) => h.startsWith('relay.')), JSON.stringify(wcHosts))

  await page.reload()
  await page.locator('table .fname-btn', { hasText: NAME }).waitFor({ timeout: 5 * 60_000 })
  check('after a reload the session reconnects by itself, no QR code',
    (await page.locator('.wc-dialog').count()) === 0 && prompts.sign === 2, JSON.stringify(prompts))

  // ── the same account in a browser wallet: the same drive ──
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const p2 = await context.newPage()
    p2.on('pageerror', (e) => errors.push(`extension pageerror: ${e.message}`))
    await p2.exposeFunction('__eth', async (method, params) => {
      try {
        switch (method) {
          case 'eth_requestAccounts':
          case 'eth_accounts':
            return { ok: [wallet.address] }
          case 'eth_chainId':
            return { ok: network.chainIdHex.toLowerCase() }
          case 'personal_sign':
            return { ok: await wallet.signMessage(ethers.isHexString(params[0]) ? ethers.getBytes(params[0]) : params[0]) }
          default:
            return { ok: await provider.send(method, params ?? []) }
        }
      } catch (e) {
        return { err: e.message }
      }
    })
    await p2.addInitScript(() => {
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
    await p2.goto(base)
    await p2.evaluate(() => localStorage.setItem('0gdrive:layout', 'list'))
    await p2.getByRole('button', { name: 'Connect wallet' }).click()
    await p2.locator('.wallet-picker').waitFor()
    const names = await p2.$$eval('.wallet-picker .wallet-name', (els) => els.map((e) => e.textContent))
    check('with an extension, the picker lists it first and WalletConnect after it',
      names.length === 2 && names[1].startsWith('WalletConnect'), JSON.stringify(names))
    await p2.locator('.wallet-picker .wallet-option').first().click()
    await p2.getByRole('button', { name: 'Restore my drive' }).click({ timeout: 5 * 60_000 })
    await p2.locator('table .fname-btn', { hasText: NAME }).waitFor({ timeout: 5 * 60_000 })
    check('the same account in a browser wallet restores the same drive (same signatures)', true)
    await context.close()
  }

  await page.getByRole('button', { name: 'Wallet menu' }).click()
  await page.getByRole('menuitem', { name: 'Disconnect' }).click()
  await page.getByRole('button', { name: 'Get started with a phone wallet' }).waitFor({ timeout: 60_000 })
  await new Promise((r) => setTimeout(r, 3000))
  check('Disconnect ends the session in the wallet too', deleted === 1 && wc.session.getAll().length === 0,
    JSON.stringify({ deleted, sessions: wc.session.getAll().length }))
  await desktop.context.close()

  // ── phone ──
  const phone = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  page = phone.page
  const start = page.getByRole('button', { name: 'Connect your wallet app' })
  await start.waitFor({ timeout: 30_000 })
  check('phone, no wallet: "Connect your wallet app", and the wallet-browser links as the other way in',
    (await page.locator('.open-in-wallet', { hasText: 'Or open 0GDrive in your wallet app’s browser' }).count()) === 1 &&
      (await page.locator('.open-in-wallet .wallet-apps a').count()) === 4)
  await start.click()
  await page.locator('.wc-dialog .wallet-apps').waitFor({ timeout: 30_000 })
  const puri = await pairingLink(page)
  const links = await page.$$eval('.wc-dialog .wallet-apps a', (els) =>
    els.map((a) => {
      const r = a.getBoundingClientRect()
      return { name: a.textContent.trim(), href: a.getAttribute('href'), left: r.left, right: r.right, h: Math.round(r.height) }
    })
  )
  const want = {
    MetaMask: 'https://metamask.app.link',
    'Trust Wallet': 'https://link.trustwallet.com',
    'Binance Wallet': 'https://app.binance.com/cedefi',
    'Bitget Wallet': 'https://bkapp.vip',
  }
  check('phone dialog: MetaMask, Trust, Binance and Bitget links (WalletConnect registry) carrying the pairing link',
    links.length === 4 && links.every((l) => l.href === `${want[l.name]}/wc?uri=${encodeURIComponent(puri)}`),
    JSON.stringify(links.map((l) => [l.name, l.href.slice(0, 60)])))
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  check('phone dialog fits 390 px, links thumb-sized, no QR code until asked',
    overflow <= 0 && links.every((l) => l.left >= 0 && l.right <= 390 && l.h >= 44) && (await page.locator('.wc-qr').count()) === 0,
    JSON.stringify({ overflow, h: links.map((l) => l.h) }))

  // tapping a link would open the wallet app; here the wallet pairs directly
  await page.evaluate(() => document.querySelectorAll('.wc-dialog .wallet-apps a').forEach((a) => a.addEventListener('click', (e) => e.preventDefault())))
  await page.locator('.wc-dialog .wallet-apps a', { hasText: 'MetaMask' }).click()
  const waiting = await page.locator('.wc-waiting').textContent()
  check('after tapping a wallet: "Approve the connection in MetaMask, then come back"', /Approve the connection in MetaMask/.test(waiting ?? ''), waiting)
  declineNext = true
  await wc.pair({ uri: puri })
  const declined = await page.locator('.welcome-error').textContent({ timeout: 30_000 }).catch(() => null)
  const errBox = await page.locator('.welcome-error').boundingBox().catch(() => null)
  const errOverflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  check('phone, the wallet declines: the start page says so (within 390 px), and the button works again',
    /Couldn’t connect: User rejected/.test(declined ?? '') && (await page.locator('.wc-dialog').count()) === 0 && (await start.isEnabled()) &&
      errOverflow <= 0 && errBox && errBox.x >= 0 && errBox.x + errBox.width <= 390,
    JSON.stringify({ declined, errOverflow }))

  await start.click()
  await page.locator('.wc-dialog .wallet-apps').waitFor({ timeout: 30_000 })
  const puri2 = await pairingLink(page)
  otherChainFirst = true
  const switches = prompts.other.filter((m) => m === 'wallet_switchEthereumChain').length
  await wc.pair({ uri: puri2 })
  const restore = page.getByRole('button', { name: 'Restore my drive' })
  await restore.waitFor({ timeout: 5 * 60_000 })
  holdNext = 3000 // the restore's signature, not the chain switch before it
  await restore.click()
  const openApp = page.locator('.wc-approve a')
  await openApp.waitFor({ timeout: 10_000 })
  const bar2 = { text: await page.locator('.wc-approve').textContent(), href: await openApp.getAttribute('href'), box: await page.locator('.wc-approve').boundingBox() }
  check('phone, a request waiting: "Open Test Wallet" links back to the wallet app, within 390 px',
    bar2.href === WALLET_LINK && /Approve in Test Wallet/.test(bar2.text) && bar2.box.x >= 0 && bar2.box.x + bar2.box.width <= 390,
    JSON.stringify(bar2))
  await page.locator('table .fname-btn', { hasText: NAME }).waitFor({ timeout: 5 * 60_000 })
  check('phone, a wallet on another chain (like MetaMask): asked to switch once, and the drive opens',
    prompts.other.filter((m) => m === 'wallet_switchEthereumChain').length === switches + 1)

  await page.reload()
  const back = await page.locator('table .fname-btn', { hasText: NAME }).waitFor({ timeout: 60_000 }).then(() => true, () => false)
  check('phone, a reload: the drive comes back by itself, no prompt',
    back && (await page.locator('.welcome').count()) === 0 && (await page.locator('.wc-dialog').count()) === 0)
  await phone.context.close()

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
} catch (e) {
  check('run completed', false, e.message.split('\n').slice(0, 3).join(' | '))
} finally {
  await browser.close()
  for (const s of wc.session.getAll()) await wc.disconnect({ topic: s.topic, reason: { code: 6000, message: 'test done' } }).catch(() => {})
  await refund(wallet, funder.address)
}
const passed = results.filter((r) => r.ok).length
console.log(`${passed}/${results.length} checks passed`)
process.exit(passed === results.length ? 0 : 1)
