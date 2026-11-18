// Categories in the browser (D35): headless Chromium + the dev server (or a
// deployment), smart search on, with an injected wallet backed by a FRESH
// key funded from .env's test wallet (the drive's setup deposit and gas, 6
// small uploads; files deleted and wallet refunded at the end). Checks:
// the Tags view (categories in the code) groups the files by topic (found by the on-device
// model) and by type; a chip lists its files with their folder; files
// selected in a folder go into a new category of the user's (Add to
// category), shown at once and stored in the drive; a file taken out of a
// category, a category renamed and deleted, all with no wallet prompt; a
// second device (a 390 px phone with touch) sees the user's category, with
// chips that fit and scroll sideways; Suggest tags finds the papers on
// LLM agents as a group (D37), named for agents: renamed and kept, it's a
// category of the user's with them in it, stored, and isn't suggested again;
// it grows (D38): a 4th agents paper uploaded later joins it by itself;
// each file shows why it's there (D44: "Similar to its files" beside the 3
// "Tagged by you", "Found in its text", "Found by its file name"; in full
// at 390 px too); 3 vision papers uploaded later show as "1 new"
// suggestion, sidebar and chip; a folder's "Group by tag" puts
// its files in sections (list and grid), each file once, kept after a
// reload.
//
//   node scripts/test-categories-ui.mjs [http://localhost:5173]
import { chromium } from 'playwright'
import { answerAsks } from './lib/ask.mjs'
import { connectExtension } from './lib/connect.mjs'
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getNetworkConfig, RelayerClient, V2_TESTNET, deriveStorageKey, hexToBytes, DriveStore, V2Backend } from '../core/dist/index.js'
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
const prompts = { tx: 0, sign: 0 }

async function deleteDriveFiles(masterKeyHex) {
  if (!masterKeyHex) return
  const account = deriveStorageKey(hexToBytes(masterKeyHex))
  const relayer = new RelayerClient(V2_TESTNET)
  const files = (await relayer.list(account.address, { limit: 100 }).catch(() => ({ files: [] }))).files
  for (const f of files) await relayer.delete(account, f.dataHash).catch(() => undefined)
  console.log(`${el()} deleted the drive's ${files.length} files`)
}

/** A browser context with the test wallet injected. */
async function walletContext(opts) {
  const context = await browser.newContext(opts)
  await context.exposeFunction('__eth', async (method, params) => {
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
      async request({ method, params }) {
        const r = await window.__eth(method, params)
        if (r.err) throw Object.assign(new Error(r.err), { code: -32000 })
        return r.ok
      },
      on() {},
      removeListener() {},
    }
    if (localStorage.getItem('0gdrive:layout') === null) localStorage.setItem('0gdrive:layout', 'list')
  })
  return context
}

const errors = []
const context = await walletContext({ viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
let nextAnswer = true
answerAsks(page, () => nextAnswer)

const FILES = {
  'invoice-031.txt': 'Invoice no. 2025-031. Bill to: Acme Ltd. Web design services, 24 hours at 85 EUR. Subtotal 2,040.00, VAT 469.20, total due 2,509.20 within 30 days.',
  'lease.txt': 'Residential Lease Agreement between the Landlord and the Tenant for the apartment at 14 Rua Augusta. Monthly rent 1,450 EUR. Either party may end it with 60 days notice.',
  'carbonara.md': '# Spaghetti carbonara\n\nIngredients: 200g spaghetti, 100g guanciale, 2 eggs, pecorino romano, black pepper. Boil the pasta, fry the guanciale, mix eggs and cheese off the heat.',
  'trip-notes.txt': 'Itinerary: fly TAP to Lisbon on May 3. Hotel in Alfama for five nights. Day trip to Sintra and Cascais. Return flight May 8.',
  'consensus-whitepaper.txt': 'This whitepaper describes a Byzantine fault tolerant consensus protocol for a modular blockchain. We analyze safety and liveness and report throughput on a 100-node testnet.',
  'budget.xlsx': 'not really a spreadsheet',
  // papers: the LLM agents ones are a group Suggest tags finds
  'agent-memory.txt': 'Memory in LLM Agents: A Survey. Abstract: We survey how language model agents store and retrieve memory, from long context to retrieval-augmented memory and episodic stores, and outline open problems.',
  'agent-tools.txt': 'Teaching Language Models to Use Tools. Abstract: We train a language model agent to decide when to call external tools such as search and calculators, improving accuracy on agent tasks.',
  'agent-planning.txt': 'Reasoning and Acting with Language Models. Abstract: We interleave reasoning traces with actions so an LLM agent can plan, act in an environment and revise its plan on interactive tasks.',
  'dag-consensus.txt': 'DAG-Based Consensus for High-Throughput Blockchains. Abstract: We separate data dissemination from ordering in a BFT consensus protocol and reach 150k transactions per second on validators worldwide.',
  'storage-proofs.txt': 'Proofs of Storage over Erasure-Coded Data. Abstract: Decentralized storage networks on a blockchain must verify that providers keep the data they are paid for; we design proofs of replication over erasure-coded sectors.',
}
const AGENTS = ['agent-memory.txt', 'agent-planning.txt', 'agent-tools.txt']
const names = Object.keys(FILES)
// uploaded later: a 4th agents paper (the kept category grows by it) and 3 vision papers (a new subject: a new suggestion)
const LATER = {
  'agent-benchmark.txt': 'Benchmarking Web Agents. Abstract: We release a benchmark of 800 realistic web tasks for language model agents and find that the best LLM agents complete fewer than half, failing at long-horizon planning.',
  'diffusion-images.txt': 'Denoising Diffusion Models for Image Synthesis. Abstract: We generate high quality images with diffusion probabilistic models trained by denoising, and report FID on CIFAR-10 and LSUN image benchmarks.',
  'vision-transformer.txt': 'Transformers for Image Recognition. Abstract: We apply a pure transformer to sequences of image patches and match convolutional networks on ImageNet image classification.',
  'object-detection.txt': 'Real-Time Object Detection in Images. Abstract: We frame object detection as one regression from image pixels to bounding boxes and class probabilities, at 45 frames per second.',
}
const VISION = ['diffusion-images.txt', 'object-detection.txt', 'vision-transformer.txt']
const ALL = [...names, ...Object.keys(LATER)]
const uploadLater = async (list) => {
  await page.locator('.sidebar .nav-item', { hasText: 'My Drive' }).click()
  await page.setInputFiles('.dropzone input[type=file]', list.map((name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(LATER[name]) })))
  await page.waitForFunction((n) => n.every((x) => [...document.querySelectorAll('table tbody tr')].some((r) => r.textContent.includes(x))), list, { timeout: 5 * 60_000, polling: 500 })
  await settled(page)
}
const row = (p, name) => p.locator('table tbody tr', { hasText: name }).first()
const settled = (p) => p.waitForFunction(() => !document.querySelector('.progress-line.on'), null, { timeout: 3 * 60_000, polling: 200 })
const chips = (p, group) =>
  p.$$eval(`.categories .cat-group`, (gs, group) => {
    const g = gs.find((x) => x.querySelector('.cat-group-title')?.textContent === group)
    return g ? [...g.querySelectorAll('.chip:not(.chip-new)')].map((c) => `${c.querySelector('.chip-name').textContent} ${c.querySelector('.chip-count')?.textContent ?? ''}`.trim()) : []
  }, group)
const chip = (p, name) => p.locator('.categories .chip', { has: p.locator('.chip-name', { hasText: new RegExp(`^${name}$`) }) })
const listed = (p) => p.$$eval('.cat-files .result .fname-btn', (els) => els.map((e) => e.textContent.trim()).sort())
/** each listed file's reason for being in the category shown, as the row says it */
const reasons = (p) => p.$$eval('.cat-files .result', (rows) => Object.fromEntries(rows.map((r) => [r.querySelector('.fname-btn').textContent.trim(), r.querySelector('.cat-why')?.textContent.replace(/^·\s*/, '') ?? null])))
const toast = (p) => p.locator('.toast .toast-text').textContent({ timeout: 3000 }).catch(() => null)
let mk = null
let masterKeyHex = null
const stored = async () => (await new DriveStore(new V2Backend(new RelayerClient(V2_TESTNET), deriveStorageKey(mk), mk)).loadDrive()).categories

try {
  await page.goto(base)
  await connectExtension(page)
  await page.getByRole('button', { name: 'Create my drive' }).click({ timeout: 120_000 })
  await page.getByRole('button', { name: 'New folder', exact: true }).waitFor({ timeout: 5 * 60_000 })
  masterKeyHex = await page.evaluate((a) => localStorage.getItem('0gdrive:masterkey:' + a.toLowerCase()), wallet.address)
  mk = hexToBytes(masterKeyHex)
  await page.setInputFiles('.dropzone input[type=file]', names.map((name) => ({ name, mimeType: name.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/plain', buffer: Buffer.from(FILES[name]) })))
  await page.waitForFunction((n) => document.querySelectorAll('table tbody tr').length >= n, names.length, { timeout: 8 * 60_000, polling: 1000 })
  await settled(page)
  step('6 files uploaded')

  // ── the Categories view: topics (once the model has indexed them) and types
  await page.locator('.sidebar .nav-item', { hasText: 'Tags' }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('.categories .chip-name')].some((c) => c.textContent === 'Travel'), null, { timeout: 10 * 60_000, polling: 1000 })
  await page.waitForTimeout(3000) // the rest of the files indexed
  const topics = await chips(page, 'Auto tags')
  const types = await chips(page, 'File types')
  // budget.xlsx has no text read (not a real spreadsheet): its name puts it in Finance
  // the files known for sure, by name (a short paper's abstract may also land in a topic: see D35's limits)
  const inTopic = async (topic) => {
    await chip(page, topic).click()
    const got = await listed(page)
    await chip(page, topic).click()
    return got
  }
  const want = { Finance: ['budget.xlsx', 'invoice-031.txt'], 'Contracts & legal': ['lease.txt'], Recipes: ['carbonara.md'], Travel: ['trip-notes.txt'], 'Research papers': ['consensus-whitepaper.txt'] }
  const gotTopics = {}
  for (const topic of Object.keys(want)) gotTopics[topic] = await inTopic(topic)
  check('Categories: the files by topic — the invoice and budget.xlsx in Finance, the lease in Contracts & legal, the recipe, the trip, the whitepaper in Research papers',
    Object.entries(want).every(([topic, files]) => files.every((f) => gotTopics[topic].includes(f))) && JSON.stringify(gotTopics.Finance) === JSON.stringify(want.Finance),
    JSON.stringify(gotTopics))
  check('…and by type: Documents 10, Spreadsheets 1', types.includes('Documents 10') && types.includes('Spreadsheets 1'), JSON.stringify(types))
  await chip(page, 'Finance').click()
  const fin = await listed(page)
  const folderLink = await page.locator('.cat-files .result-folder').first().textContent()
  check('a chip lists its files, with the folder each is in', JSON.stringify(fin) === JSON.stringify(['budget.xlsx', 'invoice-031.txt']) && folderLink === 'My drive', JSON.stringify({ fin, folderLink }))
  const finWhy = await reasons(page)
  check('…and why each is there: the invoice “Found in its text”, budget.xlsx (no text read) “Found by its file name”',
    finWhy['invoice-031.txt'] === 'Found in its text' && finWhy['budget.xlsx'] === 'Found by its file name', JSON.stringify(finWhy))

  // ── Add to category: a new category of the user's, from a selection
  const before = { ...prompts }
  await page.locator('.sidebar .nav-item', { hasText: 'My Drive' }).click()
  await row(page, 'lease.txt').locator('input[type=checkbox]').check()
  await row(page, 'consensus-whitepaper.txt').locator('input[type=checkbox]').check()
  await page.getByRole('button', { name: 'Add tag' }).click()
  await page.locator('.categorize-modal input').fill('Shortlist')
  let t = Date.now()
  await page.locator('.categorize-modal').getByRole('button', { name: 'Create & add' }).click()
  const added = await toast(page)
  await page.locator('.sidebar .nav-item', { hasText: 'Tags' }).click()
  await chip(page, 'Shortlist').waitFor({ timeout: 2000 })
  const shownMs = Date.now() - t
  const own = await chips(page, 'Your tags')
  check('Add tag → a new tag: “Tagged with Shortlist”, its chip shown at once with both files', added === 'Tagged with Shortlist' && own.includes('Shortlist 2') && shownMs < 2000, `${shownMs} ms, ${JSON.stringify({ added, own })}`)
  await settled(page)
  let s = await stored()
  check('…stored in the drive: the category and both files put in it', s?.own.length === 1 && s.own[0].name === 'Shortlist' && s.pins.filter((p) => p.in).length === 2, JSON.stringify(s))

  // ── taken out by hand (a category made from the dialog is the one shown)
  if ((await chip(page, 'Shortlist').getAttribute('aria-pressed')) !== 'true') await chip(page, 'Shortlist').click()
  await page.locator('.cat-files .result', { hasText: 'lease.txt' }).getByRole('button', { name: 'Remove the Shortlist tag' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.cat-files .result').length === 1, null, { timeout: 2000 })
  check('a file taken out leaves the list at once', JSON.stringify(await listed(page)) === JSON.stringify(['consensus-whitepaper.txt']))
  check('…the one left: “Tagged by you”', (await reasons(page))['consensus-whitepaper.txt'] === 'Tagged by you', JSON.stringify(await reasons(page)))
  await chip(page, 'Finance').click()
  await page.locator('.cat-files .result', { hasText: 'invoice-031.txt' }).getByRole('button', { name: 'Remove the Finance tag' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.cat-files .result').length === 1, null, { timeout: 2000 }).catch(() => undefined)
  check('a file taken out of a topic leaves it', (await chips(page, 'Auto tags')).includes('Finance 1'), JSON.stringify(await chips(page, 'Auto tags')))
  await settled(page)
  s = await stored()
  const out = s?.pins.filter((p) => !p.in).map((p) => p.cat).sort()
  check('…stored: taken out of Shortlist and Finance', JSON.stringify(out) === JSON.stringify([s.own[0].id, 'topic:finance'].sort()), JSON.stringify(s?.pins))

  // ── Suggest tags: the agents papers, named for agents; renamed and kept
  await page.locator('.categories .chip', { hasText: 'Suggest tags' }).click()
  await page.locator('.cat-suggest').waitFor({ timeout: 60_000 })
  await page.waitForFunction(() => !document.querySelector('.categories .chip:disabled'), null, { timeout: 60_000 })
  const cards = await page.$$eval('.cat-suggest-card', (cs) => cs.map((c) => ({ name: c.querySelector('input').value, files: c.querySelector('.cat-suggest-files').textContent })))
  const agentsCard = cards.find((c) => AGENTS.every((n) => c.files.includes(n)))
  check('Suggest tags: the LLM agents papers are a suggested group, named for agents',
    !!agentsCard && /agent/i.test(agentsCard.name) && !/invoice|lease|carbonara|trip/.test(agentsCard.files), JSON.stringify(cards))
  const card = page.locator('.cat-suggest-card', { hasText: 'agent-memory.txt' })
  await card.locator('input').fill('AI agents')
  const keptBefore = { ...prompts }
  t = Date.now()
  await card.getByRole('button', { name: 'Keep' }).click()
  await chip(page, 'AI agents').waitFor({ timeout: 2000 })
  const keptMs = Date.now() - t
  const keptList = await listed(page)
  check('Keep: a category of the user’s, shown at once with the 3 papers, the card gone',
    JSON.stringify(keptList) === JSON.stringify(AGENTS) && keptMs < 2000 && (await page.locator('.cat-suggest-card', { hasText: 'agent-memory.txt' }).count()) === 0,
    `${keptMs} ms, ${JSON.stringify(keptList)}`)
  await settled(page)
  s = await stored()
  const kept = s?.own.find((o) => o.name === 'AI agents')
  check('…stored: the category and its 3 files put in it, no wallet prompt',
    !!kept && s.pins.filter((p) => p.cat === kept.id && p.in).length === 3 && prompts.tx === keptBefore.tx && prompts.sign === keptBefore.sign, JSON.stringify(s))
  await page.locator('.categories .chip', { hasText: 'Suggest tags' }).click()
  await page.waitForFunction(() => !document.querySelector('.categories .chip:disabled'), null, { timeout: 60_000 })
  await page.waitForTimeout(300)
  const again = await page.$$eval('.cat-suggest-card', (cs) => cs.map((c) => c.querySelector('.cat-suggest-files').textContent))
  check('…and isn’t suggested again', !again.some((f) => AGENTS.every((n) => f.includes(n))), JSON.stringify(again))
  await page.getByRole('button', { name: 'Close suggestions' }).click()

  // ── a kept category grows (D38): a new agents paper joins it, not put in by hand
  await uploadLater(['agent-benchmark.txt'])
  await page.locator('.sidebar .nav-item', { hasText: 'Tags' }).click()
  const grew = await page.waitForFunction(() => [...document.querySelectorAll('.categories .chip')].some((c) => c.querySelector('.chip-name')?.textContent === 'AI agents' && c.querySelector('.chip-count')?.textContent === '4'), null, { timeout: 60_000, polling: 500 }).then(() => true, () => false)
  await chip(page, 'AI agents').click().catch(() => undefined)
  if ((await chip(page, 'AI agents').getAttribute('aria-pressed')) !== 'true') await chip(page, 'AI agents').click()
  const grown = await listed(page)
  s = await stored()
  const keptId = s.own.find((o) => o.name === 'AI agents')?.id
  check('a kept category grows: a new agents paper joins “AI agents” by itself (not put in by hand)',
    grew && grown.includes('agent-benchmark.txt') && s.own.find((o) => o.id === keptId)?.grow === true && s.pins.filter((p) => p.cat === keptId).length === 3,
    JSON.stringify({ grown, pins: s.pins.filter((p) => p.cat === keptId).length }))
  const grownWhy = await reasons(page)
  check('…shown as “Similar to its files”; the 3 kept with the suggestion “Tagged by you”',
    grownWhy['agent-benchmark.txt'] === 'Similar to its files' && Object.entries(grownWhy).filter(([, r]) => r === 'Tagged by you').length === 3, JSON.stringify(grownWhy))

  // ── new suggestions after uploads: 3 vision papers, a new subject
  await uploadLater(VISION)
  const badge = await page.locator('.sidebar .nav-item', { hasText: 'Tags' }).locator('.nav-fresh').textContent({ timeout: 60_000 }).catch(() => null)
  check('after uploads, the sidebar says there are new suggested categories', badge === '1 new', String(badge))
  await page.locator('.sidebar .nav-item', { hasText: 'Tags' }).click()
  const chipSays = await page.locator('.categories .chip', { hasText: 'Suggest tags' }).textContent()
  await page.locator('.categories .chip', { hasText: 'Suggest tags' }).click()
  await page.locator('.cat-suggest').waitFor({ timeout: 60_000 })
  await page.waitForFunction(() => !document.querySelector('.categories .chip:disabled'), null, { timeout: 60_000 })
  const visionCard = await page.$$eval('.cat-suggest-card .cat-suggest-files', (cs) => cs.map((c) => c.textContent))
  const cleared = await page.locator('.sidebar .nav-item', { hasText: 'Tags' }).locator('.nav-fresh').count()
  check('…the chip too; looking shows the vision papers as a group, and the count goes',
    /1 new/.test(chipSays) && visionCard.some((f) => VISION.every((n) => f.includes(n))) && cleared === 0, JSON.stringify({ chipSays, visionCard, cleared }))
  await page.getByRole('button', { name: 'Close suggestions' }).click()

  // ── a second device, a 390 px phone: the user's category is there
  const phone = await walletContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const pp = await phone.newPage()
  pp.on('pageerror', (e) => errors.push(`phone pageerror: ${e.message}`))
  answerAsks(pp, () => true)
  const phoneFrom = { ...prompts }
  await pp.goto(base)
  await connectExtension(pp)
  await pp.getByRole('button', { name: 'Restore my drive' }).tap({ timeout: 2 * 60_000 })
  await pp.locator('.nav-toggle').waitFor({ timeout: 5 * 60_000 })
  await pp.locator('.nav-toggle').tap()
  await pp.locator('.sidebar .nav-item', { hasText: 'Tags' }).tap()
  await chip(pp, 'Shortlist').waitFor({ timeout: 60_000 })
  const fit = await pp.evaluate(() => {
    const rows = [...document.querySelectorAll('.categories .chips')].map((c) => ({ w: c.clientWidth, sw: c.scrollWidth, wrap: getComputedStyle(c).flexWrap }))
    const hs = [...document.querySelectorAll('.categories .chip')].map((c) => Math.round(c.getBoundingClientRect().height))
    const r = document.querySelector('.categories').getBoundingClientRect()
    return { rows, minH: Math.min(...hs), left: Math.round(r.left), right: Math.round(r.right), scroll: document.documentElement.scrollWidth - window.innerWidth }
  })
  // (smart search starts off on phones: the user's category and types here, no topics)
  check('another device (390 px phone) sees the user’s category; chips ≥44 px in rows that scroll sideways within the page, no page sideways scroll',
    fit.minH >= 44 && fit.rows.every((r) => r.wrap === 'nowrap' && r.w <= fit.right - fit.left) && fit.left >= 12 && fit.right <= 378 && fit.scroll <= 0, JSON.stringify(fit))
  // Add to category on the phone: the selection bar's button and the dialog fit
  await pp.locator('.nav-toggle').tap()
  await pp.locator('.sidebar .nav-item', { hasText: 'My Drive' }).tap()
  await row(pp, 'carbonara.md').locator('input[type=checkbox]').tap()
  await pp.getByRole('button', { name: 'Add tag' }).tap()
  await pp.locator('.categorize-modal').waitFor()
  const dlg = await pp.evaluate(() => {
    const r = document.querySelector('.categorize-modal').getBoundingClientRect()
    return { left: Math.round(r.left), right: Math.round(r.right), scroll: document.documentElement.scrollWidth - window.innerWidth }
  })
  check('390 px: Add tag opens a dialog that fits', dlg.left >= 0 && dlg.right <= 390 && dlg.scroll <= 0, JSON.stringify(dlg))
  await pp.locator('.categorize-modal').getByRole('button', { name: 'Cancel' }).tap()
  await phone.close()
  // the phone's restore signature isn't a category edit's
  const phoneUsed = { tx: prompts.tx - phoneFrom.tx, sign: prompts.sign - phoneFrom.sign }

  // ── rename and delete the user's category
  await page.reload()
  await page.locator('.sidebar .nav-item', { hasText: 'Tags' }).click({ timeout: 5 * 60_000 })
  await chip(page, 'Shortlist').click()
  nextAnswer = 'Picked'
  await page.locator('.cat-own-actions').getByRole('button', { name: 'Rename' }).click()
  await chip(page, 'Picked').waitFor({ timeout: 5000 })
  check('rename: the chip shows the new name at once', (await toast(page)) === 'Renamed to Picked')
  await settled(page)
  nextAnswer = true
  await page.locator('.cat-own-actions').getByRole('button', { name: 'Delete' }).click()
  await page.waitForFunction(() => ![...document.querySelectorAll('.categories .chip-own .chip-name')].some((c) => c.textContent === 'Picked'), null, { timeout: 5000 })
  await settled(page)
  s = await stored()
  check('delete: the category and its pins go (the others stay)',
    s.own.map((o) => o.name).join() === 'AI agents' && s.pins.filter((p) => p.cat === 'topic:finance').length === 1 && s.pins.filter((p) => p.cat === s.own[0].id).length === 3 && s.pins.length === 4,
    JSON.stringify(s))
  check('none of it asked the wallet (the phone’s restore aside)', prompts.tx - phoneUsed.tx === before.tx && prompts.sign - phoneUsed.sign === before.sign, JSON.stringify({ before, after: prompts, phoneUsed }))

  // ── a folder grouped by category: sections, each file once; kept after a reload
  await page.locator('.sidebar .nav-item', { hasText: 'My Drive' }).click()
  await page.locator('.group-toggle input').check()
  const topicSections = () => page.waitForFunction(() => [...document.querySelectorAll('.group-row th, .group-title')].some((h) => h.textContent.startsWith('Recipes')), null, { timeout: 5 * 60_000, polling: 500 })
  await topicSections()
  const groups = async () => page.$$eval('tbody.group-body', (bs) => bs.map((b) => ({ name: b.querySelector('.group-row th').childNodes[0].textContent.trim(), rows: b.querySelectorAll('tr:not(.group-row)').length })))
  let g = await groups()
  const total = g.reduce((n, x) => n + x.rows, 0)
  check('Group by tag: the folder in sections, each file once', g.length >= 4 && total === ALL.length && g.some((x) => x.name === 'Recipes'), JSON.stringify(g))
  const inDocs = await page.$$eval('tbody.group-body', (bs) => bs.filter((b) => b.querySelector('.group-row th').textContent.startsWith('Documents')).flatMap((b) => [...b.querySelectorAll('tr:not(.group-row)')].map((r) => r.textContent)))
  check('…the file taken out of Finance is under its type instead', inDocs.some((r) => r.includes('invoice-031.txt')), JSON.stringify(g))
  await page.reload()
  await page.locator('tbody.group-body').first().waitFor({ timeout: 5 * 60_000 })
  check('…kept after a reload (by type until the model is ready)', await page.locator('.group-toggle input').isChecked())
  await topicSections()
  await page.getByRole('button', { name: 'Grid view' }).click()
  const grid = await page.$$eval('.grid-sections .group-sec', (ss) => ss.map((x) => x.querySelectorAll('.tile').length))
  check('…and in the grid: sections of tiles', grid.length === g.length && grid.reduce((a, b) => a + b, 0) === ALL.length, JSON.stringify(grid))

  // ── 390 px with topics: their row scrolls sideways, the page doesn't
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.nav-toggle').click()
  await page.locator('.sidebar .nav-item', { hasText: 'Tags' }).click()
  await chip(page, 'Recipes').waitFor({ timeout: 60_000 })
  const row390 = await page.evaluate(() => {
    const g = [...document.querySelectorAll('.categories .cat-group')].find((x) => x.querySelector('.cat-group-title')?.textContent === 'Auto tags')
    const c = g.querySelector('.chips')
    return { w: c.clientWidth, sw: c.scrollWidth, scroll: document.documentElement.scrollWidth - window.innerWidth }
  })
  check('390 px: the Auto tags row scrolls sideways; the page doesn’t', row390.sw > row390.w && row390.scroll <= 0, JSON.stringify(row390))
  // the reason beside each file shows in full on a phone, inside its row; the folder gives way first
  await chip(page, 'AI agents').click()
  if ((await chip(page, 'AI agents').getAttribute('aria-pressed')) !== 'true') await chip(page, 'AI agents').click()
  const why390 = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.cat-files .result')]
    return {
      n: rows.length,
      shown: rows.filter((r) => { const w = r.querySelector('.cat-why'); const m = r.querySelector('.cat-meta').getBoundingClientRect(); const b = w?.getBoundingClientRect(); return b && b.width > 0 && w.scrollWidth <= w.clientWidth + 1 && b.right <= m.right + 1 && b.right <= 390 }).length,
      scroll: document.documentElement.scrollWidth - window.innerWidth,
    }
  })
  check('390 px: each file’s reason shows in full inside its row; no sideways scroll', why390.n >= 4 && why390.shown === why390.n && why390.scroll <= 0, JSON.stringify(why390))
  await page.locator('.categories .chip', { hasText: 'Suggest tags' }).click()
  await page.locator('.cat-suggest').waitFor({ timeout: 60_000 })
  await page.waitForFunction(() => !document.querySelector('.categories .chip:disabled'), null, { timeout: 60_000 })
  const sug390 = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.cat-suggest, .cat-suggest-card, .cat-suggest button, .cat-suggest input')].map((e) => e.getBoundingClientRect())
    return { minLeft: Math.round(Math.min(...els.map((r) => r.left))), maxRight: Math.round(Math.max(...els.map((r) => r.right))), n: document.querySelectorAll('.cat-suggest-card').length, scroll: document.documentElement.scrollWidth - window.innerWidth }
  })
  check('390 px: the suggestions fit (cards, names, buttons), no sideways scroll', sug390.minLeft >= 12 && sug390.maxRight <= 378 && sug390.scroll <= 0, JSON.stringify(sug390))
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
