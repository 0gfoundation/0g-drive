// Dialogs don't close when a drag ends outside them, in the browser (headless
// Chromium + dev server), with an injected wallet backed by a FRESH key
// funded from .env's test wallet (the V2 drive's setup deposit and gas, one
// small upload; files deleted and wallet refunded at the end).
// Reported by the user: selecting the typed password with the mouse and
// letting go outside the box closed the password dialog. For the password
// and rename dialogs: a drag from inside a field to the backdrop, and one
// from the backdrop into the dialog, leave it open with the text kept; a
// plain click on the backdrop still closes it.
//
//   node scripts/test-dialog-backdrop.mjs [http://localhost:5173]
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

/** Press inside `from` (a locator) and let go on the backdrop's top-left corner, or the reverse. */
async function drag(fromBox, toPoint) {
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2)
  await page.mouse.down()
  await page.mouse.move((fromBox.x + toPoint.x) / 2, (fromBox.y + toPoint.y) / 2, { steps: 4 })
  await page.mouse.move(toPoint.x, toPoint.y, { steps: 4 })
  await page.mouse.up()
}
const CORNER = { x: 8, y: 8 } // on the backdrop, outside any dialog
const open = () => page.locator('.modal-backdrop .modal').count().then((n) => n > 0)

/** The three backdrop checks for the dialog now open, its field `field` holding `text`. */
async function backdropChecks(name, field, text) {
  const box = await field.boundingBox()
  await drag(box, CORNER)
  const sel = await page.evaluate(() => String(window.getSelection?.() ?? '') || (document.activeElement?.selectionEnd ?? 0) - (document.activeElement?.selectionStart ?? 0))
  check(`${name}: dragging from inside the field to outside keeps the dialog open, text kept`, (await open()) && (await field.inputValue()) === text, `selected: ${JSON.stringify(sel)}`)
  const dialog = await page.locator('.modal-backdrop .modal').boundingBox()
  await page.mouse.move(CORNER.x, CORNER.y)
  await page.mouse.down()
  await page.mouse.move(dialog.x + dialog.width / 2, dialog.y + dialog.height / 2, { steps: 6 })
  await page.mouse.up()
  check(`${name}: dragging from outside into the dialog keeps it open`, (await open()) && (await field.inputValue()) === text)
  await page.mouse.click(CORNER.x, CORNER.y)
  await page.waitForTimeout(200)
  check(`${name}: a click outside still closes it`, !(await open()))
}

let masterKeyHex = null
try {
  await page.goto(base)
  await page.evaluate(() => localStorage.setItem('0gdrive:smart-search', 'off'))
  await page.reload()
  await connectExtension(page)
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: '+ New folder' }).waitFor({ timeout: 5 * 60_000 })
  masterKeyHex = await page.evaluate((a) => localStorage.getItem('0gdrive:masterkey:' + a.toLowerCase()), wallet.address)

  // the password dialog, as reported
  await page.locator('.sec-row[data-row="password"] button').click()
  const pw = page.getByPlaceholder(/new password/)
  await pw.fill('correct horse battery staple')
  await backdropChecks('password dialog', pw, 'correct horse battery staple')

  // the rename dialog
  await page.setInputFiles('.dropzone input[type=file]', [{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('backdrop probe\n') }])
  await page.getByRole('button', { name: 'Rename' }).first().waitFor({ timeout: 5 * 60_000 })
  await page.getByRole('button', { name: 'Rename' }).first().click()
  const nameField = page.locator('.modal-backdrop .modal input').first()
  await nameField.waitFor()
  const current = await nameField.inputValue()
  await backdropChecks('rename dialog', nameField, current)
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
