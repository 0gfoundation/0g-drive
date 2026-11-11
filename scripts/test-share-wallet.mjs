// "Encrypted to recipient" with the derived sharing key, in the browser
// (headless Chromium + dev server), with injected wallets backed by FRESH
// keys funded from .env's test wallet:
//   recipient creates a drive (3 signatures, 1 deposit) → its card on 0G
//   Storage V2 carries the derived share key
//   sender uploads a file and creates an encrypted link (0 prompts)
//   recipient opens the link in a fresh browser → 1 signature, 0 tx,
//   file decrypts; reopening on that device → 0 signatures
//   another wallet opening the link is refused
//   sharing to an address with no drive is refused
// Both drives' files are deleted at the end and the wallets refunded.
//
//   node scripts/test-share-wallet.mjs [http://localhost:5173]
import { chromium } from 'playwright'
import { connectExtension } from './lib/connect.mjs'
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getNetworkConfig,
  findDrive,
  RelayerClient,
  V2_TESTNET,
  deriveStorageKey,
  hexToBytes,
} from '../core/dist/index.js'
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

// ── fresh funded wallets ──
const funder = new ethers.Wallet(funderKey, provider)
const sender = ethers.Wallet.createRandom().connect(provider)
const recipient = ethers.Wallet.createRandom().connect(provider)
// never funded, never has a drive
const nobody = ethers.Wallet.createRandom()
for (const w of [sender, recipient]) {
  await (await funder.sendTransaction({ to: w.address, value: ethers.parseEther('1') })).wait()
}
step(`sender ${sender.address}, recipient ${recipient.address} funded`)
/** drive keys created, for the cleanup */
const driveKeys = []

// ── injected wallet per browser context ──
const browser = await chromium.launch()
const errors = []

async function openAs(wallet, label) {
  const prompts = { tx: 0, sign: 0 }
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`))
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
          prompts.sign++
          const [data] = params
          return { ok: await wallet.signMessage(ethers.isHexString(data) ? ethers.getBytes(data) : data) }
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
      isMetaMask: true,
      async request({ method, params }) {
        const r = await window.__eth(method, params)
        if (r.err) throw Object.assign(new Error(r.err), { code: -32000 })
        return r.ok
      },
      on() {},
      removeListener() {},
    }
  })
  return { context, page, prompts }
}

async function createDrive(page, wallet) {
  await page.goto(base)
  await connectExtension(page)
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 5 * 60_000 })
  driveKeys.push(await page.evaluate((a) => localStorage.getItem('0gdrive:masterkey:' + a.toLowerCase()), wallet.address))
}

const CONTENT = 'Quarterly numbers — for the recipient only. ' + Date.now()

try {
  // ── recipient: create a drive → its card carries the derived share key ──
  const R = await openAs(recipient, 'recipient')
  await createDrive(R.page, recipient)
  await R.page.locator('.sec-row[data-row=share-key] .sec-ok').waitFor({ timeout: 5 * 60_000 })
  check('recipient setup: 3 signatures (stability check, binding), 1 deposit tx', R.prompts.sign === 3 && R.prompts.tx === 1, JSON.stringify(R.prompts))
  const shareKey = (await findDrive(V2_TESTNET, new RelayerClient(V2_TESTNET), recipient.address))?.card.shareKey
  check('published key is the derived sharing key, not the wallet key',
    typeof shareKey === 'string' && shareKey !== ethers.SigningKey.computePublicKey(recipient.signingKey.publicKey, true),
    String(shareKey))
  await R.context.close()

  // ── sender: upload, then share encrypted to the recipient ──
  const S = await openAs(sender, 'sender')
  await createDrive(S.page, sender)
  await S.page.setInputFiles('.dropzone input[type=file]', [
    { name: 'q3.txt', mimeType: 'text/plain', buffer: Buffer.from(CONTENT) },
  ])
  await S.page.locator('table .fname-btn', { hasText: 'q3.txt' }).waitFor({ timeout: 8 * 60_000 })
  step('sender uploaded q3.txt')
  const before = { ...S.prompts }
  const t = Date.now()
  await S.page.getByTitle('Share this file').first().click()
  await S.page.getByRole('button', { name: 'Encrypted to recipient' }).click()
  await S.page.fill('input[placeholder="recipient address 0x…"]', recipient.address)
  await S.page.getByRole('button', { name: 'Wrap & create link' }).click()
  await S.page.locator('.share-link-box input').waitFor({ timeout: 3 * 60_000 })
  const link = await S.page.inputValue('.share-link-box input')
  const warn = await S.page.locator('.modal .error-text').count()
  check('link created with 0 wallet prompts, no legacy warning',
    S.prompts.tx === before.tx && S.prompts.sign === before.sign && warn === 0,
    `${((Date.now() - t) / 1000).toFixed(1)} s`)
  const payload = JSON.parse(Buffer.from(link.split('#e=')[1], 'base64url').toString())
  check('link is marked as wrapped to the derived key, and names a V2 file', payload.d === 1 && payload.p === shareKey && payload.q.length === 0 && /^0x[0-9a-f]{64}$/.test(payload.r[0]))

  // ── sharing to an address with no drive ──
  await S.page.fill('input[placeholder="recipient address 0x…"]', nobody.address)
  await S.page.getByRole('button', { name: 'Wrap & create link' }).click()
  const noDrive = await S.page.locator('.modal .error-text').textContent({ timeout: 2 * 60_000 })
  check('sharing to an address with no drive is refused', /has no 0GDrive yet/.test(noDrive), JSON.stringify(noDrive))
  await S.context.close()

  // ── recipient opens the link in a fresh browser ──
  const R2 = await openAs(recipient, 'recipient-2')
  const openAndDownload = async (page) => {
    await page.goto(link)
    const button = page.getByRole('button', { name: 'Unlock with wallet & download' })
    const downloaded = page.waitForEvent('download', { timeout: 5 * 60_000 })
    // a build with WalletConnect asks which wallet first: the browser one
    await connectExtension(page, button)
    return readFileSync(await (await downloaded).path(), 'utf8')
  }
  let got = await openAndDownload(R2.page)
  check('recipient decrypts the file', got === CONTENT, JSON.stringify(got.slice(0, 30)))
  check('opening took 1 signature and 0 tx', R2.prompts.sign === 1 && R2.prompts.tx === 0, JSON.stringify(R2.prompts))
  got = await openAndDownload(R2.page)
  check('reopening on the same device: no signature', got === CONTENT && R2.prompts.sign === 1, JSON.stringify(R2.prompts))
  await R2.context.close()

  // ── someone else opening the link ──
  const X = await openAs(sender, 'other')
  await X.page.goto(link)
  await connectExtension(X.page, X.page.getByRole('button', { name: 'Unlock with wallet & download' }))
  const err = await X.page.locator('.error-text').textContent({ timeout: 60_000 })
  check('another wallet is refused (before signing)', /was shared with/.test(err) && X.prompts.sign === 0, JSON.stringify(err))
  await X.context.close()

} catch (err) {
  check('run completed', false, err.message.split('\n')[0])
} finally {
  if (errors.length) console.log('page errors:\n  ' + errors.join('\n  '))
  const pass = results.filter((r) => r.ok).length
  console.log(`${pass}/${results.length} checks passed`)
  process.exitCode = pass === results.length && errors.length === 0 ? 0 : 1
  await browser.close()
  // stop paying for the test drives
  const relayer = new RelayerClient(V2_TESTNET)
  for (const keyHex of driveKeys.filter(Boolean)) {
    const account = deriveStorageKey(hexToBytes(keyHex))
    const files = (await relayer.list(account.address, { limit: 100 }).catch(() => ({ files: [] }))).files
    for (const f of files) await relayer.delete(account, f.dataHash).catch(() => undefined)
  }
  for (const w of [sender, recipient]) await refund(w, funder.address)
}
