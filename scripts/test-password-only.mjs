// Password-only setup (D19), in headless Chromium with an injected wallet
// whose signatures change from one signing to the next (a valid signature
// by the address, with a random nonce; a fresh key funded from .env's test
// wallet for gas): setup stops at the signature check and offers a
// recovery password; the drive is then created with 1 more signature and
// the deposit; the card has the password wrap only and no share key; the
// key file is offered at once; an upload; a second device sees a
// password-only restore (no signature restore) and restores with no
// signature; a wrong password is refused. Every file of the drive is
// deleted at the end and the wallet refunded.
//
//   node scripts/test-password-only.mjs [http://localhost:5173]
import { chromium } from 'playwright'
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { secp256k1 } from '@noble/curves/secp256k1'
import { connectExtension } from './lib/connect.mjs'
import { refund } from './lib/refund.mjs'
import { RelayerClient, V2_TESTNET, deriveStorageKey, findDrive, hexToBytes } from '../core/dist/index.js'

const base = process.argv[2] ?? 'http://localhost:5173'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const funderKey = /^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(readFileSync(resolve(root, '.env'), 'utf8'))[1]
const provider = new ethers.JsonRpcProvider(V2_TESTNET.rpc)
const t0 = Date.now()
const el = () => `[${((Date.now() - t0) / 1000).toFixed(0)}s]`
const step = (m) => console.log(`${el()} ${m}`)
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${el()} ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const FUNDING = ethers.parseEther(process.env.V2_FUNDING ?? '2')
const wallet = ethers.Wallet.createRandom().connect(provider)
const funder = new ethers.Wallet(funderKey, provider)
await (await funder.sendTransaction({ to: wallet.address, value: FUNDING })).wait()
step(`fresh wallet ${wallet.address} funded with ${ethers.formatEther(FUNDING)} 0G (gas)`)

const prompts = { tx: 0, sign: 0 }
async function rpc(method, params) {
  switch (method) {
    case 'eth_requestAccounts':
    case 'eth_accounts':
      return [wallet.address]
    case 'eth_chainId':
      return '0x' + V2_TESTNET.chainId.toString(16)
    case 'net_version':
      return String(V2_TESTNET.chainId)
    case 'wallet_switchEthereumChain':
    case 'wallet_addEthereumChain':
      return null
    case 'personal_sign': {
      prompts.sign++
      const [data] = params
      // a valid signature by the address, with a random nonce: a different one each time
      const digest = ethers.getBytes(ethers.hashMessage(ethers.isHexString(data) ? ethers.getBytes(data) : data))
      const sig = secp256k1.sign(digest, ethers.getBytes(wallet.privateKey), { extraEntropy: true })
      return ethers.Signature.from({ r: ethers.toBeHex(sig.r, 32), s: ethers.toBeHex(sig.s, 32), v: 27 + sig.recovery }).serialized
    }
    case 'eth_sendTransaction': {
      prompts.tx++
      const [tx] = params
      const sent = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n, gasLimit: tx.gas ? BigInt(tx.gas) : undefined })
      return sent.hash
    }
    default:
      return provider.send(method, params ?? [])
  }
}

const browser = await chromium.launch()
const errors = []
/** A page in its own context (a separate device: its own localStorage), with or without the wallet. */
async function device({ width = 1280, withWallet = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 } })
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('dialog', (d) => d.accept())
  if (withWallet) {
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
  }
  return { context, page }
}

const status = (page, id) => page.locator(`.sec-row[data-row="${id}"] .sec-status`)
const row = (page, name) => page.locator('table tr', { has: page.locator('.fname-btn', { hasText: name }) })

async function uploadAndWait(page, files) {
  await page.setInputFiles('.dropzone input[type=file]', files)
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
  for (const f of files) await row(page, f.name).waitFor({ timeout: 3 * 60_000 })
}

const PASSWORD = 'violet anchor tundra lemonade'
let masterKeyHex = null
let page
try {
  // ── device 1: setup stops at the signature check, then the password setup ──
  ;({ page } = await device())
  await page.goto(base)
  await connectExtension(page)
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByText(/different signature when asked to sign the same message twice/).first().waitFor({ timeout: 60_000 })
  const form = page.locator('form.password-setup')
  await form.waitFor({ timeout: 10_000 })
  check('an unstable signature stops setup (2 signatures, 0 tx) and offers a recovery password', prompts.sign === 2 && prompts.tx === 0, JSON.stringify(prompts))

  let p0 = { ...prompts }
  await form.locator('input').nth(0).fill(PASSWORD)
  await form.locator('input').nth(1).fill(PASSWORD + ' typo')
  await form.getByRole('button', { name: 'Create with password' }).click()
  await page.getByText('The two passwords don’t match.').waitFor({ timeout: 10_000 })
  check('mismatched passwords are refused before any prompt', prompts.sign === p0.sign && prompts.tx === p0.tx)

  await form.locator('input').nth(1).fill(PASSWORD)
  await form.getByRole('button', { name: 'Create with password' }).click()
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 5 * 60_000 })
  check('drive created with the password: 1 signature, 1 deposit transaction', prompts.sign === p0.sign + 1 && prompts.tx === p0.tx + 1, `${prompts.sign - p0.sign} signature(s), ${prompts.tx - p0.tx} tx`)
  masterKeyHex = await page.evaluate((a) => localStorage.getItem('0gdrive:masterkey:' + a.toLowerCase()), wallet.address)

  const found = await findDrive(V2_TESTNET, new RelayerClient(V2_TESTNET), wallet.address)
  const card = found?.card
  check('the card found from the wallet has the password wrap only, no share key',
    Boolean(card?.wrappedUnderPassword && card.passwordSalt) && !card.wrappedUnderSignature && !card.shareKey &&
      card.account === deriveStorageKey(hexToBytes(masterKeyHex)).address.toLowerCase(),
    JSON.stringify({ found: Boolean(found), password: Boolean(card?.wrappedUnderPassword), signature: Boolean(card?.wrappedUnderSignature), shareKey: Boolean(card?.shareKey) }))

  check('security rows: Recovery "Password only", Password "Set", Share key "Not published"',
    (await status(page, 'recovery').textContent()).includes('Password only') &&
      (await status(page, 'password').textContent()).includes('Set') &&
      (await status(page, 'share-key').textContent()).includes('Not published'))

  const nudge = page.locator('.banner', { hasText: 'Your drive is ready.' })
  await nudge.waitFor({ timeout: 10_000 })
  const [download] = await Promise.all([page.waitForEvent('download'), nudge.getByRole('button', { name: 'Export key file' }).click()])
  const keyFile = await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString())
  await nudge.waitFor({ state: 'detached', timeout: 10_000 })
  check('the key file is offered right after setup, and holds the drive key', keyFile.includes(`Key: ${masterKeyHex}`))

  await uploadAndWait(page, [{ name: 'tea.txt', mimeType: 'text/plain', buffer: Buffer.from('oolong, then sencha\n') }])
  check('an upload with no wallet prompt', prompts.sign === p0.sign + 1 && prompts.tx === p0.tx + 1)

  // ── device 2: the same wallet, nothing on the device ──
  const d2 = await device()
  await d2.page.goto(base)
  await connectExtension(d2.page)
  const banner = d2.page.locator('.banner', { hasText: 'locked with a recovery password' })
  await banner.waitFor({ timeout: 2 * 60_000 })
  check('a second device is offered a password restore only (no signature restore)',
    (await d2.page.getByRole('button', { name: 'Use password instead' }).count()) === 0)
  p0 = { ...prompts }
  await banner.locator('input[placeholder="recovery password"]').fill('not the password at all')
  await banner.getByRole('button', { name: 'Restore my drive' }).click()
  await d2.page.getByText('Wrong recovery password.').waitFor({ timeout: 60_000 })
  check('a wrong password is refused', true)
  await banner.locator('input[placeholder="recovery password"]').fill(PASSWORD)
  await banner.getByRole('button', { name: 'Restore my drive' }).click()
  await row(d2.page, 'tea.txt').waitFor({ timeout: 3 * 60_000 })
  check('…the right one restores the drive with no wallet prompt, and its files', prompts.sign === p0.sign && prompts.tx === p0.tx, JSON.stringify(prompts))
  check('…with uploads allowed (not read-only)', (await d2.page.getByRole('button', { name: '+ New folder' }).count()) === 1 && !(await d2.page.textContent('body')).includes('Read-only.'))
  await d2.context.close()
} catch (err) {
  check('run completed', false, err.message.split('\n')[0])
  const a = await page?.$$eval('.activity li', (els) => els.slice(0, 15).map((e) => e.textContent)).catch(() => [])
  console.log('activity:\n  ' + (a ?? []).join('\n  '))
} finally {
  if (masterKeyHex) {
    const account = deriveStorageKey(hexToBytes(masterKeyHex))
    const r = new RelayerClient(V2_TESTNET)
    const files = (await r.list(account.address, { limit: 100 }).catch(() => ({ files: [] }))).files
    for (const f of files) await r.delete(account, f.dataHash).catch(() => undefined)
    step(`deleted the drive's ${files.length} files`)
  }
  await browser.close()
  await refund(wallet, funder.address)
}

if (errors.length) console.log('page errors:\n  ' + errors.join('\n  '))
const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} checks passed`)
process.exit(passed === results.length && results.length > 0 ? 0 : 1)
