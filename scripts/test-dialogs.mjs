// The drive's own confirm and prompt boxes, in place of the browser's, in
// the browser (headless Chromium + dev server), with an injected wallet
// backed by a FRESH key funded from .env's test wallet (the V2 drive's setup
// deposit and gas, one folder, one small upload; files deleted and wallet
// refunded at the end).
// Reported by the user: "Delete forever" and the deposit box used the
// browser's own style. New folder, Deposit and Delete forever open the
// drive's dialog: fields checked as you type, Enter / Escape / a click
// outside, a red button and focus on Cancel for what can't be undone, a
// bottom sheet at 390 px, and never a browser dialog.
//
//   node scripts/test-dialogs.mjs [http://localhost:5173]
import { chromium } from 'playwright'
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

const ask = page.locator('.modal-backdrop .ask-modal')
const field = ask.locator('input')
const shown = () => ask.count().then((n) => n > 0)
const native = []
page.on('dialog', (d) => {
  native.push(d.message())
  d.dismiss()
})
const treeRow = (name) => page.locator('.sidebar .tree-row', { has: page.locator('.tree-name', { hasText: new RegExp(`^${name}$`) }) })

let masterKeyHex = null
try {
  await page.goto(base)
  await page.evaluate(() => {
    localStorage.setItem('0gdrive:smart-search', 'off')
    localStorage.setItem('0gdrive:layout', 'list')
  })
  await page.reload()
  await connectExtension(page)
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 5 * 60_000 })
  masterKeyHex = await page.evaluate((a) => localStorage.getItem('0gdrive:masterkey:' + a.toLowerCase()), wallet.address)

  // New folder: the drive's own box, its field focused
  await page.getByRole('button', { name: '+ New folder' }).click()
  await ask.waitFor({ timeout: 5000 })
  const look = await ask.evaluate((m) => ({
    title: m.querySelector('h2')?.textContent,
    panel: getComputedStyle(m).backgroundColor,
    focused: document.activeElement === m.querySelector('input'),
    buttons: [...m.querySelectorAll('.modal-actions button')].map((b) => `${b.textContent}${b.classList.contains('primary') ? ' (primary)' : ''}`),
  }))
  check('“+ New folder” opens the drive’s own dialog, not the browser’s', native.length === 0 && look.title === 'New folder' && look.panel !== 'rgba(0, 0, 0, 0)', JSON.stringify(look))
  check('…its name field is focused, with Cancel and a “Create” button', look.focused && look.buttons.join() === 'Cancel,Create (primary)', JSON.stringify(look.buttons))

  // checks as you type; Enter with a bad name keeps the box open
  await field.fill('a/b')
  const slash = (await ask.locator('.error-text').textContent({ timeout: 2000 }).catch(() => '')).trim()
  await field.press('Enter')
  check('a name with “/” shows a problem and Enter doesn’t create it', slash !== '' && (await shown()), JSON.stringify(slash))
  await field.fill('')
  await field.press('Enter')
  const required = (await ask.locator('.error-text').textContent({ timeout: 2000 }).catch(() => '')).trim()
  check('an empty name: “Required.”, still open', required.includes('Required') && (await shown()), JSON.stringify(required))

  // Escape cancels: nothing created
  await field.fill('Never')
  await field.press('Escape')
  await page.waitForTimeout(1500)
  check('Escape closes it and creates nothing', !(await shown()) && (await treeRow('Never').count()) === 0)

  // Enter creates
  await page.getByRole('button', { name: '+ New folder' }).click()
  await field.fill('Recipes')
  await field.press('Enter')
  await treeRow('Recipes').waitFor({ timeout: 5 * 60_000 })
  check('Enter with a good name creates the folder', !(await shown()))

  // a name already used here
  await page.getByRole('button', { name: '+ New folder' }).click()
  await field.fill('recipes')
  const clash = (await ask.locator('.error-text').textContent({ timeout: 2000 }).catch(() => '')).trim()
  check('a folder name already here is refused before anything is sent', /already a folder named “Recipes”/.test(clash), JSON.stringify(clash))
  await ask.getByRole('button', { name: 'Cancel' }).click()

  // Deposit: amount field with a suggestion, checked; Cancel sends nothing
  const nonce = await provider.getTransactionCount(wallet.address)
  await page.locator('.sec-row[data-row="storage"] button').click()
  await ask.waitFor({ timeout: 5000 })
  const dep = await ask.evaluate((m) => ({ text: m.textContent, value: m.querySelector('input')?.value, mode: m.querySelector('input')?.inputMode }))
  check('Deposit asks for the amount in the drive’s dialog, suggested amount filled in, says 1 wallet transaction',
    /approve 1 transaction/.test(dep.text) && Number(dep.value) > 0 && dep.mode === 'decimal', JSON.stringify(dep))
  await field.fill('lots')
  const amountProblem = (await ask.locator('.error-text').textContent({ timeout: 2000 }).catch(() => '')).trim()
  check('an amount that isn’t a number is refused in the dialog', /amount of 0G/.test(amountProblem) && (await shown()), JSON.stringify(amountProblem))
  await ask.getByRole('button', { name: 'Cancel' }).click()
  await page.waitForTimeout(2000)
  check('Cancel: no transaction, the button is back to “Deposit”',
    (await provider.getTransactionCount(wallet.address)) === nonce && (await page.locator('.sec-row[data-row="storage"] button').textContent()).trim() === 'Deposit')

  // Delete forever: red action, focus on Cancel, Enter there cancels
  await page.setInputFiles('.dropzone input[type=file]', [{ name: 'keep.txt', mimeType: 'text/plain', buffer: Buffer.from('ask dialog probe\n') }])
  const row = page.locator('table tbody tr', { hasText: 'keep.txt' })
  await row.getByRole('button', { name: 'Move to trash' }).waitFor({ timeout: 5 * 60_000 })
  await row.getByRole('button', { name: 'Move to trash' }).click()
  await row.waitFor({ state: 'detached', timeout: 3 * 60_000 })
  await page.locator('[data-guide="trash"]').click()
  await row.waitFor({ timeout: 60_000 })
  await row.getByRole('button', { name: 'Delete forever' }).click()
  await ask.waitFor({ timeout: 5000 })
  const del = await ask.evaluate((m) => ({
    title: m.querySelector('h2')?.textContent,
    action: [...m.querySelectorAll('button')].find((b) => b.type === 'submit')?.className,
    focus: document.activeElement?.textContent,
  }))
  check('“Delete forever” asks in the drive’s dialog with a red “Delete forever” button, focus on Cancel',
    del.title === 'Delete “keep.txt” forever?' && /danger-solid/.test(del.action) && del.focus === 'Cancel', JSON.stringify(del))
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
  check('Enter on Cancel keeps the file', !(await shown()) && (await row.count()) === 1)
  await row.getByRole('button', { name: 'Delete forever' }).click()
  await ask.waitFor({ timeout: 5000 })
  await page.mouse.click(8, 8)
  await page.waitForTimeout(1500)
  check('a click outside cancels too', !(await shown()) && (await row.count()) === 1)

  // phone: a bottom sheet with thumb-sized buttons
  await page.setViewportSize({ width: 390, height: 844 })
  await row.getByRole('button', { name: 'Delete forever' }).click()
  await ask.waitFor({ timeout: 5000 })
  const phone = await ask.evaluate((m) => {
    const r = m.getBoundingClientRect()
    return {
      left: r.left,
      right: r.right,
      bottom: Math.round(r.bottom),
      buttons: [...m.querySelectorAll('.modal-actions button')].map((b) => Math.round(b.getBoundingClientRect().height)),
      scroll: document.documentElement.scrollWidth - innerWidth,
    }
  })
  check('390 px: the dialog fits the screen as a bottom sheet, ≥44 px buttons, no sideways scroll',
    phone.left >= 0 && phone.right <= 390 && phone.bottom === 844 && phone.buttons.every((h) => h >= 44) && phone.scroll <= 0, JSON.stringify(phone))
  await ask.getByRole('button', { name: 'Delete forever' }).click()
  await page.locator('.empty', { hasText: 'Trash is empty.' }).waitFor({ timeout: 3 * 60_000 })
  check('the red button deletes it', (await row.count()) === 0)
  check('no browser dialog opened at any point', native.length === 0, JSON.stringify(native))
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
