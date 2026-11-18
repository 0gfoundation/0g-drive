// Category calibration/regression test, on the real on-device models.
// Bundles web/src/ai/{engine,searchcore,categories}.ts with esbuild, indexes
// a labelled corpus (English + Chinese text, names alone the way big PDFs
// are indexed, and photos), groups it, and measures the topics given:
// precision (a topic given is right) and recall (a file with a topic gets
// it). Tuned for precision: a file in the wrong category costs trust, one
// left out is still in its folder. Also: types by name, the user's own
// categories by name, and pins.
//
//   node scripts/test-categories.mjs [imageDir]
// The text model is the trimmed one users get, fetched once from 0G Storage
// and checked against its pinned SHA-256 (as test-search.mjs does); sample
// photos are fetched once from huggingface.co/datasets/Xenova/transformers.js-docs.
// RAW=1 prints each file's best topic fits (for recalibrating CATEGORIZE).
import { build } from 'esbuild'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { RawImage, env } from '@huggingface/transformers'
import { createHash } from 'node:crypto'
import { downloadFile, getNetworkConfig } from '../core/dist/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'node_modules/.cache/test-categories')
mkdirSync(outDir, { recursive: true })
const imageDir = process.argv[2] ?? join(root, 'node_modules/.cache/test-search/images')
const SAMPLE = ['cats.jpg', 'tiger.jpg', 'football-match.jpg', 'city-streets.jpg', 'beach.png', 'receipt.png', 'invoice.png']
mkdirSync(imageDir, { recursive: true })
for (const f of SAMPLE) {
  if (existsSync(join(imageDir, f))) continue
  const res = await fetch(`https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/${f}`)
  if (!res.ok) throw new Error(`cannot fetch sample ${f}: HTTP ${res.status}`)
  writeFileSync(join(imageDir, f), Buffer.from(await res.arrayBuffer()))
}
await build({
  entryPoints: ['engine', 'searchcore', 'categories', 'modelOn0g'].map((m) => join(root, `web/src/ai/${m}.ts`)),
  bundle: true,
  format: 'esm',
  platform: 'node',
  outdir: outDir,
  outExtension: { '.js': '.mjs' },
  external: ['@huggingface/transformers'],
  logLevel: 'error',
})

const { SMALL_TEXT_MODEL, TEXT_MODEL_ON_0G } = await import(pathToFileURL(join(outDir, 'modelOn0g.mjs')))
const modelsDir = join(root, 'node_modules/.cache/test-search/models')
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
for (const [name, file] of Object.entries(TEXT_MODEL_ON_0G.files)) {
  const dest = join(modelsDir, SMALL_TEXT_MODEL, name)
  if (existsSync(dest) && sha256(readFileSync(dest)) === file.sha256) continue
  const { data } = await downloadFile([file.root], getNetworkConfig(TEXT_MODEL_ON_0G.network, 'turbo'), { txSeqs: [file.txSeq] })
  if (sha256(data) !== file.sha256) throw new Error(`${name} from 0G doesn't match its SHA-256`)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, data)
}
env.localModelPath = modelsDir + '/'
env.allowLocalModels = true
let fellBack = false
const warn = console.warn
console.warn = (...args) => {
  if (/trimmed text model unavailable/.test(String(args[0]))) fellBack = true
  warn(...args)
}

const { indexPhoto, indexText, embedPassage } = await import(pathToFileURL(join(outDir, 'engine.mjs')))
const C = await import(pathToFileURL(join(outDir, 'categories.mjs')))
const { cosineQ, dequantize } = await import(pathToFileURL(join(outDir, 'searchcore.mjs')))

let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// [name, text (undefined: indexed by name alone), the topics it should get ([] = none is right), topics also fine]
const T = (id) => `topic:${id}`
const corpus = [
  ['invoice-2025-031.pdf', 'Invoice no. 2025-031. Bill to: Acme Ltd. Web design services, 24 hours at 85 EUR. Subtotal 2,040.00, VAT 23% 469.20, total due 2,509.20 within 30 days.', [T('finance')], [T('work')]],
  ['bank-statement-sept.txt', 'Account statement September. Opening balance 4,210.55. Card payments, direct debits, salary credit 3,800.00. Closing balance 5,032.10.', [T('finance')]],
  ['electricity-bill.txt', 'Electricity bill, period August. Consumption 312 kWh. Amount due 96.40 EUR by direct debit on Sept 20.', [T('finance')]],
  ['taxi-receipt.txt', 'Taxi receipt. Fare 23.80 EUR, tip 2.00, paid by card. Airport to city centre, 19 km.', [T('finance')], [T('travel')]],
  ['2024 tax return.pdf', undefined, [T('finance')]],
  ['工资单-十月.txt', '十月工资单。基本工资一万二千元,绩效奖金三千元,扣除社保和公积金两千一百元,个人所得税八百元,实发一万二千一百元。', [T('finance')]],
  ['家庭开支预算.txt', '家庭每月开支预算:房贷八千,生活费三千,孩子教育两千,交通八百,储蓄三千。', [T('finance')]],
  ['meeting-notes-q3.md', '# Q3 planning meeting\nAttendees: product, design, eng. Decisions: ship the onboarding redesign in October; hire two backend engineers. Action items: Maria drafts the roadmap, Tom books the offsite.', [T('work')]],
  ['project-plan.docx', 'Project plan for the website relaunch. Milestones: discovery by March 1, design by April 15, build by June 30, launch July 10. Risks: content migration, vendor delays.', [T('work')]],
  ['client-proposal-acme.pdf', 'Proposal for Acme Ltd: we propose a three-phase engagement to modernize your data platform, with fixed fees per phase and a dedicated team of four.', [T('work')]],
  ['会议纪要.txt', '第三季度预算会议纪要。参会人员:财务部、市场部。讨论了市场推广预算削减百分之十五,研发预算保持不变。下次会议定于十月二十日。', [T('work')], [T('finance')]],
  ['周报-第42周.txt', '本周工作总结:完成了支付模块的联调,修复了三个线上问题。下周计划:上线新版本,准备季度汇报材料。', [T('work')]],
  ['attention-paper.pdf', 'Abstract. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms. Experiments on two machine translation tasks show these models to be superior in quality.', [T('research')], [T('study')]],
  ['memskill.pdf', 'Abstract: Large language model agents struggle to retain skills across tasks. We introduce MemSkill, a memory architecture that stores reusable skills, and evaluate it on three benchmarks, improving success rates by 18%.', [T('research')]],
  ['consensus-whitepaper.pdf', 'This whitepaper describes a Byzantine fault tolerant consensus protocol for a modular blockchain. We analyze safety and liveness and report throughput measurements on a 100-node testnet.', [T('research')]],
  ['区块链存储论文.pdf', '摘要:本文提出一种去中心化存储网络的数据可用性证明方法,并在测试网络上进行了实验,结果表明吞吐量提升了三倍。', [T('research')]],
  ['Agora.pdf', undefined, []],
  ['lease-final.txt', 'Residential Lease Agreement. This lease is made between the Landlord and the Tenant for the apartment at 14 Rua Augusta. Monthly rent is 1,450 EUR due on the first day of each month. Either party may end it with 60 days notice.', [T('legal')], [T('finance')]],
  ['nda-signed.pdf', 'Mutual Non-Disclosure Agreement. The parties agree to keep confidential all information disclosed in connection with the evaluation of a potential business relationship, for a period of three years.', [T('legal')], [T('work')]],
  ['employment-contract.pdf', 'Employment contract between Nova GmbH and the Employee. Start date, salary, working hours, probation period of six months, notice periods and governing law.', [T('legal')], [T('work')]],
  ['租房合同.txt', '房屋租赁合同。甲方(出租人)与乙方(承租人)就北京市朝阳区某房屋达成租赁协议,租期一年,月租金六千元,押一付三。', [T('legal')], [T('finance')]],
  ['trip-notes.txt', 'Itinerary: fly TAP to Lisbon on May 3. Hotel in Alfama for five nights. Day trip to Sintra and Cascais, tram 28, pastéis de nata in Belém. Return flight May 8.', [T('travel')]],
  ['flight-confirmation.txt', 'Booking confirmation. Flight LH 1172 Frankfurt to Porto, seat 14C, departure 07:35. Please arrive at the gate 30 minutes before boarding.', [T('travel')]],
  ['tokyo-hotel.txt', 'Reservation for 4 nights at Shinjuku Granbell Hotel, check-in Oct 12. Breakfast included. Free cancellation until Oct 5.', [T('travel')]],
  ['日本旅行计划.txt', '日本七日游行程:第一天抵达东京,入住新宿酒店;第三天坐新干线去京都,参观清水寺;第六天大阪购物,第七天回国。', [T('travel')]],
  ['blood-test-results.pdf', 'Laboratory report. Hemoglobin 14.2 g/dL, cholesterol total 5.1 mmol/L, glucose fasting 5.4 mmol/L. Reference ranges attached. Please discuss with your physician.', [T('health')]],
  ['prescription.txt', 'Prescription: amoxicillin 500 mg, three times daily for seven days. Take with food. Dr. Silva, family medicine.', [T('health')]],
  ['体检报告.txt', '年度体检报告:血压正常,血脂偏高,建议减少油腻饮食并增加运动,三个月后复查。', [T('health')]],
  ['linear-algebra-notes.md', 'Lecture 5: eigenvalues and eigenvectors. Definition, characteristic polynomial, diagonalization. Exercises 5.1 to 5.12 due next Tuesday.', [T('study')]],
  ['homework-3.pdf', 'Homework 3, due Friday. Problem 1: prove the sum of the first n odd numbers is n squared. Problem 2: solve the recurrence T(n) = 2T(n/2) + n.', [T('study')]],
  ['期末复习提纲.txt', '期末复习提纲:第一章至第六章重点,包括函数极限、导数应用、定积分计算,考试时间一百二十分钟。', [T('study')]],
  ['carbonara.md', '# Spaghetti carbonara\n\nIngredients: 200g spaghetti, 100g guanciale, 2 eggs, pecorino romano, black pepper.\n\n1. Boil the pasta in salted water.\n2. Fry the guanciale until crisp.\n3. Mix eggs and cheese, toss with the pasta off the heat.', [T('recipes')]],
  ['pancakes.md', 'Fluffy pancakes: 200g flour, 2 eggs, 300ml milk, a pinch of salt, butter for the pan. Whisk and rest 20 minutes before cooking.', [T('recipes')]],
  ['ramen.txt', '拉面做法:猪骨熬汤八小时,加入酱油和味醂调味,面条煮两分钟,配叉烧、溏心蛋和葱花。', [T('recipes')]],
  // nothing in particular: no topic is right
  ['guitar-chords.txt', 'Am C G F progression, capo on 2nd fret, strumming pattern down down up up down up.', []],
  ['todo.txt', 'buy milk, call mom, fix the bike, water the plants', []],
  ['plot_sales.py', 'import pandas as pd\nimport matplotlib.pyplot as plt\n\ndf = pd.read_csv("sales_2025.csv")\nmonthly = df.groupby("month")["revenue"].sum()\nmonthly.plot(kind="bar")', [], [T('work'), T('finance')]],
  ['poem.txt', 'The fog comes on little cat feet. It sits looking over harbor and city on silent haunches and then moves on.', []],
  ['README.md', '# my-app\nRun npm install, then npm run dev. The app listens on port 3000. Set API_URL in .env.', []],
  ['notes.txt', undefined, []],
  ['Mind the Gap.pdf', undefined, []],
  ['DVN in LayerZero.pdf', undefined, []],
]
const photos = [
  ['IMG_0001.jpg', 'cats.jpg', [T('pets')]],
  ['IMG_0002.jpg', 'tiger.jpg', [T('pets')]],
  ['IMG_0003.jpg', 'football-match.jpg', [T('people')], [T('places')]],
  ['IMG_0004.jpg', 'city-streets.jpg', [T('places')], [T('people')]],
  ['IMG_0005.png', 'beach.png', [T('places')]],
  ['IMG_0006.png', 'receipt.png', [T('finance')], [T('screenshots')]],
  ['IMG_0007.png', 'invoice.png', [T('finance')], [T('screenshots')]],
]

const files = []
const expected = new Map()
const fine = new Map()
for (const [name, text, want, ok = []] of corpus) {
  const mime = name.endsWith('.pdf') ? 'application/pdf' : 'text/plain'
  files.push({ id: name, name, mime, search: await indexText(name, text) })
  expected.set(name, want)
  fine.set(name, ok)
}
if (fellBack) {
  console.log("FAIL  the trimmed text model (from 0G) didn't load — results would be for the full model")
  process.exit(1)
}
for (const [name, file, want, ok = []] of photos) {
  const search = await indexPhoto(name, await RawImage.read(join(imageDir, file)))
  files.push({ id: name, name, mime: name.endsWith('.png') ? 'image/png' : 'image/jpeg', search })
  expected.set(name, want)
  fine.set(name, ok)
  console.log(`  ${name} (${file}) tags: ${search.g?.join(', ') ?? '—'}`)
}
const topicVecs = await Promise.all(C.topicPhrases().map((p) => embedPassage(p)))

// ── topics: precision and recall ──
let given = 0
let right = 0
let wanted = 0
let found = 0
const rows = []
for (const f of files) {
  const got = C.topicsOf(f, topicVecs)
  const want = expected.get(f.id)
  const okSet = new Set([...want, ...fine.get(f.id)])
  given += got.length
  right += got.filter((t) => okSet.has(t)).length
  wanted += want.length
  found += want.filter((t) => got.includes(t)).length
  const wrong = got.filter((t) => !okSet.has(t))
  const missed = want.filter((t) => !got.includes(t))
  rows.push(`${wrong.length ? 'WRONG ' : missed.length ? 'missed' : 'ok    '} ${f.id}: ${got.join(', ') || '—'}${want.length ? ` (want ${want.join(', ')})` : ''}`)
  if (process.env.RAW && f.search?.e && !f.search.c) {
    const v = dequantize(f.search.e)
    let i = 0
    const fits = C.TOPICS.map((t) => ({ id: t.id, fit: Math.max(-1, ...t.phrases.map(() => cosineQ(topicVecs[i++], v))) }))
      .filter((x) => x.fit > -1)
      .sort((a, b) => b.fit - a.fit)
      .slice(0, 3)
    rows.push(`       ${fits.map((x) => `${x.id.slice(6)} ${x.fit.toFixed(3)}`).join(' | ')}`)
  }
}
console.log(rows.join('\n'))
const precision = given ? right / given : 1
const recall = wanted ? found / wanted : 1
console.log(`topics given ${given}, right ${right}; wanted ${wanted}, found ${found} (CATEGORIZE ${JSON.stringify(C.CATEGORIZE)})`)
check('topics: precision ≥ 90% (a topic given is right)', precision >= 0.9, `${(precision * 100).toFixed(0)}%`)
check('topics: recall ≥ 60% (a file with a topic gets it)', recall >= 0.6, `${(recall * 100).toFixed(0)}%`)

// ── types by name and MIME type ──
const types = {
  'a.pdf': 'type:pdfs', 'b.docx': 'type:docs', 'c.md': 'type:docs', 'd.xlsx': 'type:sheets', 'e.csv': 'type:sheets',
  'f.pptx': 'type:slides', 'g.py': 'type:code', 'h.zip': 'type:archives', 'i.bin': null,
}
const typeOk = Object.entries(types).every(([n, t]) => C.typeOf(n, '') === t) &&
  C.typeOf('x', 'image/heic') === 'type:photos' && C.typeOf('x.mov', 'video/quicktime') === 'type:videos' && C.typeOf('x.mp3', 'audio/mpeg') === 'type:audio'
check('types: by extension and MIME type', typeOk)

// ── the user's own categories, and pins ──
const user = {
  v: 1,
  own: [{ id: 'own:chain', name: 'Blockchain' }, { id: 'own:cook', name: '做饭' }],
  pins: [
    { file: 'Agora.pdf', cat: 'own:chain', in: true },
    { file: 'carbonara.md', cat: 'topic:recipes', in: false },
    { file: 'gone.txt', cat: 'own:chain', in: true },
  ],
  updatedAt: 0,
}
const ownVecs = new Map(await Promise.all(user.own.map(async (c) => [c.id, await embedPassage(c.name)])))
const g = C.groupFiles(files, user, topicVecs, ownVecs)
if (process.env.RAW) {
  for (const c of user.own) {
    const fits = files.filter((f) => f.search?.e).map((f) => ({ n: f.id, fit: cosineQ(ownVecs.get(c.id), dequantize(f.search.e)), only: !f.search.t && !f.search.c }))
      .sort((a, b) => b.fit - a.fit).slice(0, 10)
    console.log(`own ${c.name}: ${fits.map((x) => `${x.n}${x.only ? '*' : ''} ${x.fit.toFixed(3)}`).join(' | ')}`)
  }
}
const chain = g.files.get('own:chain') ?? []
const cook = g.files.get('own:cook') ?? []
console.log(`own "Blockchain": ${chain.join(', ')}\nown "做饭": ${cook.join(', ')}`)
check('own category “Blockchain” gathers the blockchain papers', ['consensus-whitepaper.pdf', '区块链存储论文.pdf'].every((n) => chain.includes(n)))
check('own category “做饭” (cooking, in Chinese) gathers the recipes', ['pancakes.md', 'ramen.txt'].every((n) => cook.includes(n)))
const ownWrong = [...chain.filter((n) => !/consensus|区块链|Agora|DVN|LayerZero/.test(n)), ...cook.filter((n) => !/carbonara|pancakes|ramen|IMG/.test(n))]
check('own categories gather nothing unrelated', ownWrong.length === 0, ownWrong.join(', '))
check('a file put in by hand is in (Agora.pdf → Blockchain)', chain.includes('Agora.pdf'))
check('a file taken out by hand is out (carbonara.md ✗ Recipes)', !(g.files.get('topic:recipes') ?? []).includes('carbonara.md') && (g.of.get('carbonara.md') ?? []).includes('type:docs'))
check('a pin of a file no longer in the drive is ignored', !chain.includes('gone.txt'))
check('own categories listed first, even empty; empty built-ins not listed',
  g.categories[0].id === 'own:chain' && g.categories[1].id === 'own:cook' && g.categories.every((c) => c.kind === 'own' || c.count > 0))

// ── why each file is in each category (shown beside it) ──
const why = (file, cat) => g.why.get(file)?.get(cat)
check('why: put in by hand → “put” (Agora.pdf in Blockchain)', why('Agora.pdf', 'own:chain') === 'put')
check('why: fits an own category’s name → “name”', chain.filter((n) => n !== 'Agora.pdf').every((n) => why(n, 'own:chain') === 'name'), chain.map((n) => `${n}:${why(n, 'own:chain')}`).join(' '))
const reasonsRight = files.every((f) => [...(g.why.get(f.id) ?? [])].every(([c, r]) =>
  c.startsWith('type:') ? r === 'type'
    : c.startsWith('topic:') ? r === 'put' || r === (f.search?.c ? 'photo' : f.search && !f.search.t ? 'filename' : 'text')
      : ['put', 'name', 'grew'].includes(r)))
check('why: types by type; topics from the text, the photo, or the file name alone', reasonsRight)
check('why: every category a file is in has a reason, and only those', files.every((f) => JSON.stringify([...(g.why.get(f.id)?.keys() ?? [])]) === JSON.stringify(g.of.get(f.id))))
check('why: a file taken out has no reason there', !g.why.get('carbonara.md')?.has('topic:recipes'))
// a kept category (from a suggestion) grows: 4 agents papers put in, a 5th grows in (the drive's other files don't)
{
  const AGENTS = [
    'Reusable Skills for LLM Agents. Abstract: Large language model agents struggle to retain skills across tasks. We give agents a memory of reusable skills.',
    'Planning with Language Model Agents. Abstract: We study how language model agents plan, act and revise their plans in interactive tasks.',
    'Tool Use for LLM Agents. Abstract: Agents built on large language models call tools such as search and calculators; we teach agents when to call which tool.',
    'Memory in LLM Agents: A Survey. Abstract: We survey how language model agents store and retrieve memory, from long context to episodic stores.',
    'Benchmarking Web Agents. Abstract: We release a benchmark of realistic web tasks for language model agents; the best agents complete fewer than half.',
  ]
  const extra = []
  for (const [k, text] of AGENTS.entries()) extra.push({ id: `agents-${k}.pdf`, name: `agents-${k}.pdf`, mime: 'application/pdf', uploadedAt: k, search: await indexText(`agents-${k}.pdf`, text) })
  const put = extra.slice(0, 4).map((f) => f.id)
  const kept = { v: 1, own: [{ id: 'own:kept', name: 'Group', grow: true }], pins: put.map((file) => ({ file, cat: 'own:kept', in: true })), updatedAt: 0 }
  const gk = C.groupFiles([...files, ...extra], kept, topicVecs, new Map())
  const reasons = (gk.files.get('own:kept') ?? []).map((n) => `${n}:${gk.why.get(n)?.get('own:kept')}`)
  check('why: grown into a kept category → “grew”; the files put in → “put”',
    put.every((n) => gk.why.get(n)?.get('own:kept') === 'put') && gk.why.get('agents-4.pdf')?.get('own:kept') === 'grew', reasons.join(' '))
}

// ── edits are idempotent ──
const e0 = { v: 1, own: [], pins: [], updatedAt: 0 }
const twice = (edit) => JSON.stringify(edit(edit(e0))) === JSON.stringify(edit(e0))
check('edits applied twice are applied once', twice(C.addOwn('own:x', 'X')) && twice(C.pin(['a', 'b'], 'own:x', true)) && twice(C.removeOwn('own:x')))
const removed = C.removeOwn('own:x')(C.pin(['a'], 'own:x', true)(C.addOwn('own:x', 'X')(e0)))
check('removing a category drops its pins', removed.own.length === 0 && removed.pins.length === 0)

console.log(failed ? `${failed} FAILED` : 'CATEGORIES TEST PASSED ✓')
process.exitCode = failed ? 1 : 0
