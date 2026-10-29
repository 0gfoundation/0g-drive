// The help assistant in the browser (headless Chromium; drive dev server on
// :5173 and assistant on :3000, or a deployed drive URL), with an injected
// wallet backed by a FRESH key funded from .env's test wallet, and the real
// 0G Router using ZG_ROUTER_API_KEY from .env (5 real questions, ~0.5 0G):
//   isolation: the assistant frame can't read the drive's storage or DOM,
//              and its CSP blocks other hosts
//   key setup: bad key refused, real key accepted, kept only on the assistant's origin
//   answers: searches + cites the guide; drive_status; show_in_drive pulses a control;
//            reads 0G contract source from GitHub
//   privacy: no request to the Router contains the address, file names or keys
//   phone (390 px): full-screen panel, no overflow, 16px inputs, pointing closes the panel
//
//   node scripts/test-assistant.mjs [http://localhost:5173]
import { chromium } from 'playwright'
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getNetworkConfig } from '../core/dist/index.js'
import { refund } from './lib/refund.mjs'

const base = process.argv[2] ?? 'http://localhost:5173'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const env = readFileSync(resolve(root, '.env'), 'utf8')
const funderKey = /^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(env)[1]
const routerKey = /^ZG_ROUTER_API_KEY=(\S+)\s*$/m.exec(env)?.[1]
if (!routerKey) throw new Error('ZG_ROUTER_API_KEY missing from .env')
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

const funder = new ethers.Wallet(funderKey, provider)
const wallet = ethers.Wallet.createRandom().connect(provider)
await (await funder.sendTransaction({ to: wallet.address, value: ethers.parseEther('0.05') })).wait()
step(`wallet ${wallet.address} funded`)

const browser = await chromium.launch()
const errors = []
/** every request body sent to the Router, for the privacy check */
const routerBodies = []

async function open(viewport, label) {
  const context = await browser.newContext({ viewport, ...(viewport.width < 500 ? { isMobile: true, hasTouch: true } : {}) })
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (/Content Security Policy/.test(m.text()) && !/example\.com|evmrpc/.test(m.text())) errors.push(`${label} CSP: ${m.text()}`)
  })
  page.on('request', (r) => {
    if (r.url().startsWith('https://router-api.0g.ai/') && r.postData()) routerBodies.push(r.postData())
  })
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
  return { context, page }
}

const assistantFrame = async (page) => {
  const iframe = page.locator('.assist-panel.open iframe')
  await iframe.waitFor()
  // the assistant's own origin: :3000 in dev, its *.0g.ai host when deployed
  const origin = new URL(await iframe.getAttribute('src')).origin
  for (let i = 0; i < 50; i++) {
    const f = page.frames().find((f) => f.url().startsWith(`${origin}/`))
    if (f) return f
    await page.waitForTimeout(100)
  }
  throw new Error('assistant frame not found')
}

/** ask in the frame and wait for the answer (its cost line) */
async function ask(frame, question) {
  const before = await frame.locator('.turn').count()
  await frame.fill('textarea', question)
  await frame.press('textarea', 'Enter')
  const turn = frame.locator('.turn').nth(before)
  // attached, not visible: on a phone, pointing at a control hides the panel
  await turn.locator('.meta, .error').first().waitFor({ state: 'attached', timeout: 4 * 60_000 })
  return {
    answer: (await turn.locator('.a').textContent().catch(() => '')) ?? '',
    steps: await turn.locator('.steps li').allTextContents(),
    meta: (await turn.locator('.meta').textContent().catch(() => '')) ?? '',
    error: (await turn.locator('.error').textContent().catch(() => null)) ?? null,
    cites: await turn.locator('.cite').count(),
    turn,
  }
}

const FILE_NAME = 'divorce-settlement-draft.txt'

try {
  // ── desktop: drive with a file in it ──
  const D = await open({ width: 1280, height: 900 }, 'desktop')
  const page = D.page
  await page.goto(base)
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 120_000 })
  await page.setInputFiles('.dropzone input[type=file]', [
    { name: FILE_NAME, mimeType: 'text/plain', buffer: Buffer.from('private notes ' + Date.now()) },
  ])
  await page.locator('table .fname-btn', { hasText: FILE_NAME }).waitFor({ timeout: 8 * 60_000 })
  step('drive created, file uploaded')
  const driveStorage = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)))
  const secrets = Object.values(driveStorage).filter((v) => /^(0x)?[0-9a-f]{64}$/i.test(v))

  // ── open the panel; isolation ──
  await page.getByRole('button', { name: 'Ask the assistant' }).click()
  const frame = await assistantFrame(page)
  await frame.getByText('Ask about 0GDrive and 0G').waitFor({ timeout: 30_000 })
  const keyLink = await frame.getByRole('link', { name: /Get a key/ }).getAttribute('href')
  check('panel opens on key setup with a link to pc.0g.ai API keys', keyLink === 'https://pc.0g.ai/dashboard/api-keys', keyLink)

  const iso = await frame.evaluate(async () => {
    const tryIt = (f) => {
      try {
        f()
        return 'readable'
      } catch {
        return 'blocked'
      }
    }
    const blockedFetch = async (url) => {
      try {
        await fetch(url, { mode: 'no-cors' })
        return 'allowed'
      } catch {
        return 'blocked'
      }
    }
    return {
      parentStorage: tryIt(() => window.parent.localStorage.length),
      parentDom: tryIt(() => window.parent.document.body.innerHTML),
      ownKeys: Object.keys(localStorage),
      example: await blockedFetch('https://example.com/'),
      rpc: await blockedFetch('https://evmrpc-testnet.0g.ai/'),
    }
  })
  check(
    "assistant can't read the drive's storage or page",
    iso.parentStorage === 'blocked' && iso.parentDom === 'blocked' && !iso.ownKeys.some((k) => k.startsWith('0gdrive')),
    JSON.stringify(iso)
  )
  check('its CSP blocks other hosts (exfiltration, chain RPC)', iso.example === 'blocked' && iso.rpc === 'blocked')
  const sandbox = await page.locator('.assist-panel iframe').getAttribute('sandbox')
  check('iframe is sandboxed (no top navigation)', !!sandbox && !sandbox.includes('allow-top-navigation'), sandbox)

  // ── key setup ──
  await frame.fill('input[type=password]', 'sk-thisisnotarealkey000000')
  await frame.getByRole('button', { name: 'Save key' }).click()
  const bad = await frame.locator('.error').textContent({ timeout: 30_000 })
  check('a wrong key is refused', /refused|key/i.test(bad), bad)
  await frame.fill('input[type=password]', routerKey)
  await frame.getByRole('button', { name: 'Save key' }).click()
  await frame.locator('textarea').waitFor({ timeout: 60_000 })
  const keyInDrive = await page.evaluate((k) => Object.values(localStorage).some((v) => v.includes(k)), routerKey)
  const keyInFrame = await frame.evaluate(() => localStorage.getItem('0gassist:key')?.startsWith('sk-'))
  check('key accepted; stored on the assistant origin only', keyInFrame === true && !keyInDrive)

  // ── Q1: how-to, from the guide, with a citation ──
  let r = await ask(frame, 'How do I recover my drive if I lose my wallet?')
  check(
    'how-to answer: searched, mentions the recovery password + read-only, cites a source',
    !r.error && r.steps.some((s) => s.startsWith('✓Searched')) && /recovery password/i.test(r.answer) && /read-only/i.test(r.answer) && r.cites > 0,
    `${r.meta} | ${r.cites} citations | steps: ${r.steps.join(' / ')} | ${r.answer.slice(0, 300).replace(/\s+/g, ' ')}`
  )
  await r.turn.locator('.cite').first().click()
  await frame.locator('.viewer .vline').first().waitFor({ timeout: 30_000 })
  const hit = await frame.locator('.viewer .vline.hit').count()
  check('citation opens the source viewer at the cited lines', hit > 0, `${hit} highlighted lines`)
  await frame.getByRole('button', { name: 'Close source' }).click()

  // ── Q2: the user's own setup ──
  r = await ask(frame, 'Is my drive backed up? Check my setup.')
  check(
    "own-setup answer uses drive_status (recovery is off here) and says it isn't set up",
    !r.error && r.steps.some((s) => /drive’s status/.test(s)) && /(not|isn’t|isn't).{0,40}(set up|backed|enabled|on\b)|\bset up\b/i.test(r.answer),
    r.answer.slice(0, 160).replace(/\s+/g, ' ')
  )

  // ── Q3: where is it → highlight in the drive ──
  const pulsed = page.waitForFunction(
    () => !!document.querySelector('.sec-row[data-row="password"] > .guide-pulse'),
    null,
    { timeout: 4 * 60_000, polling: 100 }
  )
  r = await ask(frame, 'Where do I set a recovery password?')
  const shown = await pulsed.then(() => true, () => false)
  check('"where" question highlights the Password row in the drive', !r.error && shown && r.steps.some((s) => /Pointed at/.test(s)), `${r.steps.join(' / ')} | ${r.answer.slice(0, 160).replace(/\s+/g, ' ')}`)

  // ── Q4: 0G internals from GitHub source ──
  r = await ask(frame, 'In the 0G storage contracts (Solidity), which function does an upload call to register a file, and which event does it emit? Check the source.')
  check(
    'protocol answer reads 0G contract source and names submit + the Submit event',
    !r.error && r.steps.some((s) => /Read .*(Flow|flow)|Looked for files/.test(s)) && /submit/i.test(r.answer) && /Submit\b/.test(r.answer),
    `${r.meta} | ${r.steps.join(' / ')}`
  )

  // ── privacy: what reached the Router ──
  const all = routerBodies.join('\n')
  const leaks = [
    all.toLowerCase().includes(wallet.address.toLowerCase().slice(2)) && 'address',
    all.includes(FILE_NAME) && 'file name',
    secrets.some((s) => all.toLowerCase().includes(s.toLowerCase().replace(/^0x/, ''))) && 'drive key',
  ].filter(Boolean)
  check('no address, file name or key in any of the Router requests', leaks.length === 0 && routerBodies.length > 0, `${routerBodies.length} requests${leaks.length ? '; LEAKED: ' + leaks.join(', ') : ''}`)

  // Escape closes; reopening keeps the conversation
  await page.keyboard.press('Escape')
  await page.locator('.assist-panel.open').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  const closed = !(await page.locator('.assist-panel.open').count())
  await page.getByRole('button', { name: 'Ask the assistant' }).click()
  const kept = await (await assistantFrame(page)).locator('.turn').count()
  check('Escape closes the panel; reopening keeps the conversation', closed && kept === 4, `${kept} turns`)
  await D.context.close()

  // ── phone ──
  const M = await open({ width: 390, height: 844 }, 'phone')
  await M.page.goto(base)
  const fab = await M.page.getByRole('button', { name: 'Ask the assistant' }).boundingBox()
  check('phone: Ask button is a ≥44 px touch target inside the screen', fab && fab.width >= 44 && fab.height >= 44 && fab.x + fab.width <= 390, JSON.stringify(fab))
  await M.page.getByRole('button', { name: 'Ask the assistant' }).click()
  const mf = await assistantFrame(M.page)
  await mf.getByText('Ask about 0GDrive and 0G').waitFor({ timeout: 30_000 })
  const panel = await M.page.locator('.assist-panel.open').boundingBox()
  const setupLayout = await mf.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    inputFont: getComputedStyle(document.querySelector('input[type=password]')).fontSize,
  }))
  check(
    'phone: panel is full-screen, no horizontal overflow, 16px key input',
    panel && Math.round(panel.width) === 390 && Math.round(panel.height) === 844 && setupLayout.overflow === 0 && setupLayout.inputFont === '16px',
    JSON.stringify({ panel, ...setupLayout })
  )
  await mf.fill('input[type=password]', routerKey)
  await mf.getByRole('button', { name: 'Save key' }).click()
  await mf.locator('textarea').waitFor({ timeout: 60_000 })
  const pulse = M.page.waitForFunction(() => !!document.querySelector('.lost-wallet.guide-pulse'), null, { timeout: 4 * 60_000, polling: 100 })
  r = await ask(mf, 'I lost my wallet. Where on this screen do I open my drive with the recovery password?')
  const pointed = await pulse.then(() => true, () => false)
  const panelGone = !(await M.page.locator('.assist-panel.open').count())
  const formOpen = await M.page.locator('input[placeholder="drive\'s wallet address 0x…"]').isVisible()
  check('phone: pointing at a control closes the panel, opens the lost-wallet form and pulses it', pointed && panelGone && formOpen, r.steps.join(' / '))
  await M.page.getByRole('button', { name: 'Ask the assistant' }).click()
  const mf2 = await assistantFrame(M.page)
  const chatLayout = await mf2.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    textareaFont: getComputedStyle(document.querySelector('textarea')).fontSize,
    closeBtn: document.querySelector('[aria-label="Close assistant"]').getBoundingClientRect().width,
  }))
  check(
    'phone: chat with an answer has no overflow, 16px composer, 40px close button',
    chatLayout.overflow === 0 && chatLayout.textareaFont === '16px' && chatLayout.closeBtn >= 40,
    JSON.stringify(chatLayout)
  )
  await mf2.getByRole('button', { name: 'Close assistant' }).click()
  // closing is a message to the drive page: give it a moment
  const xClosed = await M.page.locator('.assist-panel.open').waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false)
  check('phone: × closes the panel', xClosed)
  await M.context.close()
} catch (err) {
  check('run completed', false, err.message.split('\n')[0])
} finally {
  if (errors.length) console.log('page errors:\n  ' + errors.join('\n  '))
  const pass = results.filter((r) => r.ok).length
  console.log(`${pass}/${results.length} checks passed`)
  process.exitCode = pass === results.length && errors.length === 0 ? 0 : 1
  await browser.close()
  await refund(wallet, funder.address)
}
