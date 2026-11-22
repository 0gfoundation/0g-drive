// Deep folders, in the browser (headless Chromium + dev server), with an
// injected wallet backed by a FRESH key funded from .env's test wallet.
// Makes Spark/consensus/blockchain/algorithm/titanic/compute/transformer/inference
// (no files) and Docs:
//   the sidebar shows the chain as one row, every name opens its folder
//   the open folder's subfolders show above its files, in the list and the grid,
//     with a count; a folder of only subfolders shows no "empty drive" hero
//   siblings break the chain; past 4 levels rows keep one indent, with guide bars
//   the row's actions float over its end, so names keep the row's width
//   a deep path's breadcrumb: My drive / … / its last two, … shows it whole
//   phone width: chain rows, folder rows, folder tiles and the breadcrumb fit the screen
// On-device AI is switched off, so no model download.
//
//   node scripts/test-deep-folders.mjs [http://localhost:5173]
import { chromium } from 'playwright'
import { answerAsks } from './lib/ask.mjs'
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
const errors = []
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
let txs = 0
let signs = 0
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
        signs++
        const [data] = params
        return { ok: await wallet.signMessage(ethers.isHexString(data) ? ethers.getBytes(data) : data) }
      }
      case 'eth_sendTransaction': {
        txs++
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
  localStorage.setItem('0gdrive:smart-search', 'off')
  localStorage.setItem('0gdrive:layout', 'list')
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

/** Delete every file of the drive's storage account (rent stops), with its key from the page. */
async function deleteDriveFiles(pg = page, address = wallet.address) {
  const hex = await pg.evaluate((a) => localStorage.getItem('0gdrive:masterkey:' + a.toLowerCase()), address).catch(() => null)
  if (!hex) return
  const account = deriveStorageKey(hexToBytes(hex))
  const relayer = new RelayerClient(V2_TESTNET)
  const files = (await relayer.list(account.address, { limit: 100 }).catch(() => ({ files: [] }))).files
  for (const f of files) await relayer.delete(account, f.dataHash).catch(() => undefined)
  step(`deleted the drive's ${files.length} files`)
}

const CHAIN = ['Spark', 'consensus', 'blockchain', 'algorithm', 'titanic', 'compute', 'transformer', 'inference']
const pathTo = (i) => CHAIN.slice(0, i + 1).join('/')
const crumbs = () => page.$$eval('.breadcrumb .crumb', (els) => els.map((e) => e.textContent.trim()).join('/'))
/** the open folder's path, from the heading over the files (its name, the path as its title) */
const openPath = () => page.$eval('.files-head h2', (h) => h.title || h.childNodes[0].textContent.trim())
const treeRow = (name) => page.locator('.sidebar .tree-row', { has: page.locator('.tree-name', { hasText: new RegExp(`^${name}$`) }) })
const treeLabel = (name) => page.locator('.sidebar .tree-label', { has: page.locator('.tree-name', { hasText: new RegExp(`^${name}$`) }) })
const folderOpen = (name) => page.locator('.folder-open', { has: page.locator('.folder-name', { hasText: new RegExp(`^${name}$`) }) })
let promptAnswer = ''
answerAsks(page, (q) => (q.prompt && q.title === 'New folder' ? promptAnswer : true))
const newFolder = async (name) => {
  promptAnswer = name
  await page.getByRole('button', { name: 'New folder', exact: true }).click()
  await treeRow(name).first().waitFor({ timeout: 5 * 60_000 })
}
/** The sidebar's rows: their names, left edge, guide bars, and how much of the row the label area gets. */
const rows = () => page.$$eval('.sidebar .tree-row', (els) => els.map((r) => {
  const rr = r.getBoundingClientRect()
  const label = (r.querySelector('.tree-chain') ?? r.querySelector('.tree-label')).getBoundingClientRect()
  const caret = r.querySelector('.tree-caret').getBoundingClientRect()
  return {
    names: [...r.querySelectorAll('.tree-name')].map((n) => n.textContent),
    left: Math.round(caret.left - rr.left),
    bars: r.querySelectorAll('.tree-deep i').length,
    labelW: Math.round(label.width),
    gap: Math.round(rr.right - label.right),
    overflow: r.scrollWidth - r.clientWidth,
  }
}))

try {
  await page.goto(base)
  await connectExtension(page)
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: 'New folder', exact: true }).waitFor({ timeout: 120_000 })
  await newFolder('Docs')
  for (let i = 0; i < CHAIN.length; i++) {
    await newFolder(CHAIN[i])
    await treeLabel(CHAIN[i]).first().click()
  }
  step(`folders made; open: ${await openPath()}`)

  // ── the chain is one row; every name in it opens its folder
  const chainRow = (await rows()).find((r) => r.names[0] === 'Spark')
  check('sidebar: the 8 folders that lead straight into each other share one row',
    JSON.stringify(chainRow.names) === JSON.stringify(CHAIN) && chainRow.overflow <= 0, JSON.stringify(chainRow))
  await treeLabel('algorithm').click()
  const onAlgo = { open: await openPath(), here: await page.$eval('.sidebar .tree-seg.here', (e) => e.textContent).catch(() => '') }
  const short = await crumbs()
  await page.getByRole('button', { name: 'Show the whole path' }).click()
  const whole = await crumbs()
  check('a deep path’s breadcrumb shows My drive / … / its last two; … shows it whole',
    short === 'My drive/…/blockchain/algorithm' && whole === `My drive/${pathTo(3)}`, JSON.stringify({ short, whole }))
  check('clicking a name in the row opens that folder and marks it',
    onAlgo.open === pathTo(3) && onAlgo.here === 'algorithm', JSON.stringify(onAlgo))

  // ── the open folder's subfolders, above its files
  const listed = await page.evaluate(() => ({
    folders: [...document.querySelectorAll('.folder-list .folder-row')].map((r) => `${r.querySelector('.folder-name').textContent}|${r.querySelector('.folder-meta').textContent}`),
    hero: !!document.querySelector('.hero'),
    acts: [...document.querySelectorAll('.folder-row .btn')].map((b) => b.getAttribute('aria-label')),
  }))
  check('list: the subfolder shows as a row with its count and actions; no empty-drive hero',
    JSON.stringify(listed.folders) === '["titanic|1 folder"]' && !listed.hero &&
    JSON.stringify(listed.acts) === '["Rename folder","Move folder","Trash folder"]', JSON.stringify(listed))
  await folderOpen('titanic').click()
  check('clicking the folder row opens it', (await openPath()) === pathTo(4), await openPath())
  await page.locator('.breadcrumb .crumb', { hasText: 'My drive' }).click()
  const top = await page.$$eval('.folder-row', (els) => els.map((r) => `${r.querySelector('.folder-name').textContent}|${r.querySelector('.folder-meta').textContent}`))
  check('My drive lists both folders, an empty one as "0 files"', JSON.stringify(top) === '["Docs|0 files","Spark|1 folder"]', JSON.stringify(top))
  await page.getByRole('button', { name: 'Grid view' }).click()
  const grid = await page.evaluate(() => ({
    tiles: [...document.querySelectorAll('.folder-grid .folder-tile .folder-name')].map((e) => e.textContent),
    fileTiles: document.querySelectorAll('.grid .tile').length,
  }))
  check('grid: folders show as tiles before the files', JSON.stringify(grid.tiles) === '["Docs","Spark"]' && grid.fileTiles === 0, JSON.stringify(grid))
  await folderOpen('Spark').click()
  check('clicking a folder tile opens it', (await openPath()) === 'Spark', await openPath())
  await page.getByRole('button', { name: 'List view' }).click()
  await treeLabel('inference').click()
  check('an empty folder still shows the hero', await page.locator('.hero').isVisible() && (await page.locator('.folder-row').count()) === 0)

  // ── siblings break the chain; past 4 levels the indent stops growing
  const siblings = ['a', 'b', 'c', 'd', 'e']
  for (let i = 0; i < siblings.length; i++) {
    await treeLabel(CHAIN[i + 1]).click()
    await newFolder(siblings[i])
  }
  await treeLabel('inference').click()
  const deep = await rows()
  const by = (n) => deep.find((r) => r.names.includes(n))
  const levels = ['consensus', 'blockchain', 'algorithm', 'titanic', 'compute', 'transformer'].map((n) => by(n))
  const step16 = levels[1].left - levels[0].left
  check('siblings split the chain: Spark/consensus, then one row per level, transformer/inference together',
    JSON.stringify(levels[0].names) === '["Spark","consensus"]' && JSON.stringify(levels[5].names) === '["transformer","inference"]' &&
    levels.slice(1, 5).every((r) => r.names.length === 1), JSON.stringify(deep.map((r) => r.names)))
  check('indent grows to 4 levels, then stays; deeper rows get one guide bar per extra level',
    step16 === 16 && levels[3].left - levels[2].left === 16 && levels[4].left - levels[3].left < 6 && levels[5].left - levels[4].left < 6 &&
    levels[3].bars === 0 && levels[4].bars === 1 && levels[5].bars === 2,
    JSON.stringify(levels.map((r) => ({ left: r.left, bars: r.bars }))))
  await page.mouse.move(900, 800)
  const still = await rows()
  check('rows you don’t point at keep their label up to the row’s end; the deepest label ≥ 120 px',
    still.every((r) => r.gap <= 4 && r.overflow <= 0) && still.find((r) => r.names.includes('transformer')).labelW >= 120,
    JSON.stringify(still.map((r) => [r.labelW, r.gap])))
  const hovered = treeRow('compute')
  await hovered.hover()
  const acts = await hovered.evaluate((r) => {
    const label = r.querySelector('.tree-label').getBoundingClientRect()
    const btns = [...r.querySelectorAll('.tree-act')].map((b) => b.getBoundingClientRect())
    return { n: btns.length, shown: btns.every((b) => b.width > 0), clear: btns.every((b) => b.left >= label.right - 1), target: r.querySelector('.tree-rename').title }
  })
  const open = await page.evaluate(() => document.querySelector('.sidebar .tree-row.selected .tree-rename').title)
  check('pointing at a row shows its 3 buttons beside the name, not over it; in a shared row they act on the open folder',
    acts.n === 3 && acts.shown && acts.clear && acts.target === 'Rename compute' && open === 'Rename inference', JSON.stringify({ acts, open }))

  // ── phone width
  await treeLabel('compute').click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  const phoneMain = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    rows: [...document.querySelectorAll('.folder-row')].map((r) => Math.round(r.getBoundingClientRect().right)),
    acts: [...document.querySelectorAll('.folder-row .btn')].map((b) => Math.round(b.getBoundingClientRect().right)),
  }))
  const head = await page.$eval('.files-head h2', (h) => ({ text: h.childNodes[0].textContent.trim(), title: h.title }))
  check('phone: a deep folder’s breadcrumb and heading don’t widen the page; the heading is the folder’s name',
    phoneMain.overflow <= 0 && (await crumbs()) === 'My drive/…/titanic/compute' && head.text === 'compute' && head.title === pathTo(5),
    JSON.stringify({ crumbs: await crumbs(), head }))
  check('phone: folder rows and their buttons fit the screen', phoneMain.overflow <= 0 && phoneMain.rows.length === 2 && [...phoneMain.rows, ...phoneMain.acts].every((x) => x <= 390), JSON.stringify(phoneMain))
  await page.getByRole('button', { name: 'Grid view' }).click()
  const phoneGrid = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    tiles: [...document.querySelectorAll('.folder-tile')].map((t) => Math.round(t.getBoundingClientRect().right)),
  }))
  check('phone: folder tiles fit the screen', phoneGrid.overflow <= 0 && phoneGrid.tiles.length === 2 && phoneGrid.tiles.every((x) => x <= 390), JSON.stringify(phoneGrid))
  await page.getByRole('button', { name: 'List view' }).click()
  await page.getByRole('button', { name: 'Folders and settings' }).click()
  await page.waitForTimeout(400)
  const drawer = await page.evaluate(() => {
    const side = document.querySelector('.sidebar').getBoundingClientRect()
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      side: Math.round(side.right),
      rows: [...document.querySelectorAll('.sidebar .tree-row')].map((r) => ({ right: Math.round(r.getBoundingClientRect().right), sw: r.scrollWidth - r.clientWidth })),
      minLabel: Math.min(...[...document.querySelectorAll('.sidebar .tree-row')].map((r) => Math.round((r.querySelector('.tree-chain') ?? r.querySelector('.tree-label')).getBoundingClientRect().width))),
    }
  })
  check('phone: every tree row fits the drawer, the narrowest label ≥ 100 px',
    drawer.overflow <= 0 && drawer.rows.every((r) => r.right <= drawer.side && r.sw <= 0) && drawer.minLabel >= 100, JSON.stringify(drawer))
  await page.getByRole('button', { name: 'Folders and settings' }).click({ force: true }).catch(() => {})
  await page.setViewportSize({ width: 1280, height: 900 })
} catch (e) {
  check('run completed', false, e.message.split('\n').slice(0, 6).join(' | '))
} finally {
  await deleteDriveFiles()
  await browser.close()
}

if (errors.length) console.log(errors.join('\n'))
const passed = results.filter((r) => r.ok).length
console.log(`${passed}/${results.length} checks passed`)
await refund(wallet, funder.address)
process.exit(passed === results.length && errors.length === 0 ? 0 : 1)
