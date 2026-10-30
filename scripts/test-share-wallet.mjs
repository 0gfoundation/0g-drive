// "Encrypted to recipient" with the derived sharing key, in the browser
// (headless Chromium + dev server), with injected wallets backed by FRESH
// keys funded from .env's test wallet:
//   recipient sets up security (2 signatures, 1 tx) → share key published
//   sender uploads a file and creates an encrypted link (0 prompts)
//   recipient opens the link in a fresh browser → 1 signature, 0 tx,
//   file decrypts; reopening on that device → 0 signatures
//   another wallet opening the link is refused
// plus, in Node: adding the share key to a pre-existing backup keeps its
// recovery password.
//
//   node scripts/test-share-wallet.mjs [http://localhost:5173]
import { chromium } from 'playwright'
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getNetworkConfig,
  getProfile,
  deriveRecoveryKey,
  RECOVERY_SIGN_MESSAGE,
  publishDriveKeyBackup,
  enableShareKey,
  restoreDriveKeyByPassword,
} from '../core/dist/index.js'

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
const legacy = ethers.Wallet.createRandom().connect(provider)
for (const w of [sender, recipient, legacy]) {
  await (await funder.sendTransaction({ to: w.address, value: ethers.parseEther('0.5') })).wait()
}
step(`sender ${sender.address}, recipient ${recipient.address}, legacy ${legacy.address} funded`)

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

async function createDrive(page) {
  await page.goto(base)
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 120_000 })
}

const CONTENT = 'Quarterly numbers — for the recipient only. ' + Date.now()

try {
  // ── recipient: set up security → derived share key published ──
  const R = await openAs(recipient, 'recipient')
  await createDrive(R.page)
  await R.page.getByRole('button', { name: 'Set up recovery' }).click({ timeout: 120_000 })
  await R.page.locator('.sec-row[data-row=share-key] .sec-ok').waitFor({ timeout: 5 * 60_000 })
  check('recipient setup: 2 signatures (stability check), 1 tx', R.prompts.sign === 2 && R.prompts.tx === 1, JSON.stringify(R.prompts))
  const profile = await getProfile(recipient.address, network)
  check('published key is the derived sharing key, not the wallet key',
    profile?.kind === 'share' && profile.pubKey !== ethers.SigningKey.computePublicKey(recipient.signingKey.publicKey, true),
    JSON.stringify(profile))
  await R.context.close()

  // ── sender: upload, then share encrypted to the recipient ──
  const S = await openAs(sender, 'sender')
  await createDrive(S.page)
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
  check('link is marked as wrapped to the derived key', payload.d === 1 && payload.p === profile?.pubKey)
  await S.context.close()

  // ── recipient opens the link in a fresh browser ──
  const R2 = await openAs(recipient, 'recipient-2')
  const openAndDownload = async (page) => {
    await page.goto(link)
    const button = page.getByRole('button', { name: 'Unlock with wallet & download' })
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 5 * 60_000 }), button.click()])
    return readFileSync(await download.path(), 'utf8')
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
  await X.page.getByRole('button', { name: 'Unlock with wallet & download' }).click()
  const err = await X.page.locator('.error-text').textContent({ timeout: 60_000 })
  check('another wallet is refused (before signing)', /was shared with/.test(err) && X.prompts.sign === 0, JSON.stringify(err))
  await X.context.close()

  // ── Node: legacy backup (password, no share key) → add the share key ──
  const masterKey = crypto.getRandomValues(new Uint8Array(32))
  const recoveryKey = deriveRecoveryKey(await legacy.signMessage(RECOVERY_SIGN_MESSAGE))
  await publishDriveKeyBackup(network, legacy, legacy.address, masterKey, recoveryKey, { password: 'hunter2 hunter2' })
  check('legacy backup has no share key', (await getProfile(legacy.address, network)) === null)
  await enableShareKey(network, legacy, legacy.address, masterKey)
  const upgraded = await getProfile(legacy.address, network)
  check('enableShareKey publishes the derived key', upgraded?.kind === 'share')
  const byPw = await restoreDriveKeyByPassword(legacy.address, network, 'hunter2 hunter2')
  check('…and keeps the recovery password', byPw !== null && Buffer.from(byPw.masterKey).equals(Buffer.from(masterKey)))
} catch (err) {
  check('run completed', false, err.message.split('\n')[0])
} finally {
  if (errors.length) console.log('page errors:\n  ' + errors.join('\n  '))
  const pass = results.filter((r) => r.ok).length
  console.log(`${pass}/${results.length} checks passed`)
  process.exitCode = pass === results.length && errors.length === 0 ? 0 : 1
  await browser.close()
}
