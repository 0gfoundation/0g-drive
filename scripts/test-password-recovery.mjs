// Recovery password, in the browser (headless Chromium + dev server), with
// an injected wallet backed by a FRESH key funded from .env's test wallet:
//   create drive + upload a file + set up security
//   set the password (dialog: mismatch / too short rejected) → status shows
//   it, also after a reload; change it
//   a browser with NO wallet opens the drive read-only with address +
//   password: wrong / old password refused, file listed and previewed,
//   no upload / new-folder / trash controls, and no thumbnails saved on
//   that device (the owner's browser does save them)
//
//   node scripts/test-password-recovery.mjs [http://localhost:5173]
import { chromium } from 'playwright'
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getNetworkConfig } from '../core/dist/index.js'

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
await (await funder.sendTransaction({ to: wallet.address, value: ethers.parseEther('0.5') })).wait()
step(`fresh wallet ${wallet.address} funded`)

const browser = await chromium.launch()
const errors = []
const prompts = { tx: 0, sign: 0 }

async function openWithWallet() {
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
  return { context, page }
}

const CAT = Buffer.from(await (await fetch('https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/cats.jpg')).arrayBuffer())

/** Grid view, wait for the photo's sharp thumbnail, count thumbnails saved in IndexedDB. */
async function gridThumbsSaved(page) {
  await page.getByTitle('Grid view').click()
  await page.locator('img.tile-thumb[src^="blob:"]').first().waitFor({ timeout: 3 * 60_000 })
  await page.waitForTimeout(1000) // the save is fire-and-forget
  const n = await page.evaluate(() => new Promise((res) => {
    const req = indexedDB.open('0gdrive-thumbs')
    req.onsuccess = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('thumbs')) return res(0)
      const c = db.transaction('thumbs').objectStore('thumbs').count()
      c.onsuccess = () => res(c.result)
      c.onerror = () => res(-1)
    }
    req.onerror = () => res(-1)
  }))
  await page.getByTitle('List view').click()
  return n
}

const CONTENT = 'Passport scan notes — recover me. ' + Date.now()
const PW1 = 'copper lantern orbit meadow'
const PW2 = 'violet harbor sixteen kites'

try {
  const { context, page } = await openWithWallet()
  await page.goto(base)
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 120_000 })
  await page.setInputFiles('.dropzone input[type=file]', [
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from(CONTENT) },
    { name: 'cat.jpg', mimeType: 'image/jpeg', buffer: CAT },
  ])
  await page.locator('table .fname-btn', { hasText: 'notes.txt' }).waitFor({ timeout: 8 * 60_000 })
  check('owner\'s browser saves thumbnails (control)', (await gridThumbsSaved(page)) > 0)
  await page.getByRole('button', { name: 'Set up recovery' }).click()
  await page.locator('.sec-row[data-row=recovery] .sec-ok').waitFor({ timeout: 5 * 60_000 })
  step('drive created, file uploaded, security set up')

  // ── set the password ──
  await page.getByRole('button', { name: 'Set recovery password' }).click()
  await page.fill('input[placeholder^="new password"]', 'short pw')
  await page.fill('input[placeholder="type it again"]', 'short pw')
  await page.getByRole('button', { name: 'Set password' }).click()
  const shortErr = await page.locator('.modal .error-text').textContent()
  await page.fill('input[placeholder^="new password"]', PW1)
  await page.fill('input[placeholder="type it again"]', PW1 + 'x')
  await page.getByRole('button', { name: 'Set password' }).click()
  const mismatchErr = await page.locator('.modal .error-text').textContent()
  check('too-short and mismatched passwords rejected before any prompt',
    /at least 12/.test(shortErr) && /don’t match/.test(mismatchErr), `${shortErr} | ${mismatchErr}`)
  const before = { ...prompts }
  await page.fill('input[placeholder="type it again"]', PW1)
  await page.getByRole('button', { name: 'Set password' }).click()
  await page.locator('.sec-row[data-row=password] .sec-ok').waitFor({ timeout: 5 * 60_000 })
  check('password set: 1 signature + 1 tx, sidebar shows "✓ Set  Change"',
    prompts.sign - before.sign === 1 && prompts.tx - before.tx === 1 &&
      (await page.getByRole('button', { name: 'Change recovery password' }).count()) === 1,
    JSON.stringify({ sign: prompts.sign - before.sign, tx: prompts.tx - before.tx }))

  const secLayout = () => page.$$eval('.sec-row', (els) => els.map((e) => {
    const r = (sel) => {
      const el = e.querySelector(sel)
      return el && el.textContent ? el.getBoundingClientRect() : null
    }
    const label = r('.sec-label'), status = r('.sec-status > *'), action = r('.sec-act > *')
    return {
      row: e.dataset.row,
      label: Math.round(label.left),
      status: status && Math.round(status.left),
      action: action && Math.round(action.right),
      text: e.textContent,
    }
  }))
  const aligned = (rows) => {
    const one = (k) => new Set(rows.map((x) => x[k]).filter((v) => v !== null)).size === 1
    return one('label') && one('status') && one('action')
  }
  let layout = await secLayout()
  check('security rows: labels, statuses and actions each in one column',
    aligned(layout), JSON.stringify(layout.map((x) => `${x.row}@${x.label}/${x.status}/${x.action}: ${x.text}`)))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Folders and settings' }).click()
  await page.waitForTimeout(400)
  layout = await secLayout()
  const overflow = await page.$eval('.sidebar', (el) => el.scrollWidth - el.clientWidth)
  check('…also at phone width, no overflow', aligned(layout) && overflow <= 0,
    JSON.stringify({ overflow, cols: layout.map((x) => `${x.label}/${x.status}/${x.action}`) }))
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1280, height: 900 })

  await page.reload()
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  await page.locator('.sec-row[data-row=password] .sec-ok').waitFor({ timeout: 3 * 60_000 })
  check('status read back from chain after reload', true)

  // ── change it ──
  await page.getByRole('button', { name: 'Change recovery password' }).click()
  const title = await page.locator('.modal h2').textContent()
  const warn = await page.locator('.modal').textContent()
  await page.fill('input[placeholder^="new password"]', PW2)
  await page.fill('input[placeholder="type it again"]', PW2)
  await page.getByRole('button', { name: 'Change password' }).click()
  await page.locator('.modal').waitFor({ state: 'detached', timeout: 5 * 60_000 })
  check('change dialog says it replaces the old password', title === 'Change recovery password' && /stops working/.test(warn))
  await context.close()

  // ── no wallet at all: open read-only ──
  const ro = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const p2 = await ro.newPage()
  p2.on('pageerror', (e) => errors.push(`ro pageerror: ${e.message}`))
  await p2.goto(base)
  await p2.getByRole('button', { name: 'Open your drive with its recovery password' }).click()
  await p2.fill('input[placeholder^="drive\'s wallet address"]', wallet.address)
  const tryPw = async (pw) => {
    await p2.fill('.lost-wallet input[type=password]', pw)
    await p2.getByRole('button', { name: 'Open drive' }).click()
    await p2.waitForTimeout(300) // the previous error clears on submit
    await p2.waitForFunction(() => document.querySelector('.lost-wallet .error-text') || document.querySelector('.ro-badge'), null, { timeout: 2 * 60_000 })
    return p2.locator('.lost-wallet .error-text').textContent({ timeout: 1000 }).catch(() => null)
  }
  const wrong = await tryPw('not the password at all')
  const old = await tryPw(PW1)
  check('wrong and old (replaced) passwords refused', /Wrong recovery password/.test(wrong ?? '') && /Wrong recovery password/.test(old ?? ''), `${wrong} | ${old}`)
  const t = Date.now()
  await tryPw(PW2)
  await p2.locator('table .fname-btn', { hasText: 'notes.txt' }).waitFor({ timeout: 3 * 60_000 })
  check('new password opens the drive read-only, file listed', (await p2.locator('.ro-badge').count()) === 1, `${((Date.now() - t) / 1000).toFixed(1)} s`)
  const controls = await p2.evaluate(() => ({
    dropzone: !!document.querySelector('.dropzone'),
    newFolder: [...document.querySelectorAll('button')].some((b) => b.textContent.includes('New folder')),
    trash: !!document.querySelector('[aria-label="Move to trash"]'),
    download: !!document.querySelector('[aria-label="Download"]'),
  }))
  check('no upload / new folder / trash controls; download kept',
    !controls.dropzone && !controls.newFolder && !controls.trash && controls.download, JSON.stringify(controls))
  await p2.locator('table .fname-btn', { hasText: 'notes.txt' }).click()
  await p2.locator('.preview-text').waitFor({ timeout: 3 * 60_000 })
  const text = await p2.textContent('.preview-text')
  check('file previews and decrypts', text === CONTENT, JSON.stringify(text.slice(0, 30)))
  const stored = await p2.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('0gdrive:masterkey:')))
  check('drive key not saved on this device', stored.length === 0, JSON.stringify(stored))
  await p2.keyboard.press('Escape')
  const roThumbs = await gridThumbsSaved(p2)
  check('read-only: photo thumbnail shown but not saved on this device', roThumbs === 0, `${roThumbs} saved`)
  const rows = await p2.$$eval('.sec-row', (els) => els.map((e) => e.dataset.row))
  check('read-only sidebar: only the key file row', JSON.stringify(rows) === '["key-file"]', JSON.stringify(rows))
  await ro.close()

  // ── an address without a drive ──
  const none = await browser.newContext()
  const p3 = await none.newPage()
  await p3.goto(base)
  await p3.getByRole('button', { name: 'Open your drive with its recovery password' }).click()
  await p3.fill('input[placeholder^="drive\'s wallet address"]', ethers.Wallet.createRandom().address)
  await p3.fill('.lost-wallet input[type=password]', PW2)
  await p3.getByRole('button', { name: 'Open drive' }).click()
  const noneErr = await p3.locator('.lost-wallet .error-text').textContent({ timeout: 2 * 60_000 })
  check('address without a drive: clear error', /No drive backup found/.test(noneErr), noneErr)
  await none.close()
} catch (err) {
  check('run completed', false, err.message.split('\n')[0])
} finally {
  console.log(`wallet prompts: ${prompts.tx} transactions, ${prompts.sign} signatures`)
  if (errors.length) console.log('page errors:\n  ' + errors.join('\n  '))
  const pass = results.filter((r) => r.ok).length
  console.log(`${pass}/${results.length} checks passed`)
  process.exitCode = pass === results.length && errors.length === 0 ? 0 : 1
  await browser.close()
}
