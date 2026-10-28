// Phase 1 search calibration/regression test, on the real on-device models.
// Bundles web/src/ai/{engine,searchcore}.ts with esbuild, indexes a small
// mixed corpus (English + Chinese text, photos with neutral file names), runs
// queries in both languages and checks the expected file ranks first.
//
//   node scripts/test-search.mjs [imageDir]
// Sample photos (cats, tiger, football, street, beach, receipt, invoice) are
// fetched once from huggingface.co/datasets/Xenova/transformers.js-docs.
// RAW=1 also prints raw cosines (for recalibrating searchcore.ts CAL).
import { build } from 'esbuild'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { RawImage } from '@huggingface/transformers'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// bundle inside the repo so the external package resolves from node_modules
const outDir = join(root, 'node_modules/.cache/test-search')
mkdirSync(outDir, { recursive: true })

// sample photos: fetched once into the cache unless a directory is given
const imageDir = process.argv[2] ?? join(outDir, 'images')
const SAMPLE = ['cats.jpg', 'tiger.jpg', 'football-match.jpg', 'city-streets.jpg', 'beach.png', 'receipt.png', 'invoice.png']
mkdirSync(imageDir, { recursive: true })
for (const f of SAMPLE) {
  if (existsSync(join(imageDir, f))) continue
  const res = await fetch(`https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/${f}`)
  if (!res.ok) throw new Error(`cannot fetch sample ${f}: HTTP ${res.status}`)
  writeFileSync(join(imageDir, f), Buffer.from(await res.arrayBuffer()))
}
await build({
  entryPoints: [join(root, 'web/src/ai/engine.ts'), join(root, 'web/src/ai/searchcore.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outdir: outDir,
  outExtension: { '.js': '.mjs' },
  external: ['@huggingface/transformers'],
  logLevel: 'error',
})
const { indexPhoto, indexText, embedQuery } = await import(pathToFileURL(join(outDir, 'engine.mjs')))
const { rank, CAL } = await import(pathToFileURL(join(outDir, 'searchcore.mjs')))

const texts = {
  'lease-final.txt': 'Residential Lease Agreement. This lease is made between the Landlord and the Tenant for the apartment at 14 Rua Augusta. Monthly rent is 1,450 EUR due on the first day of each month. Either party may terminate this agreement with a notice period of sixty (60) days. Security deposit equals two months of rent.',
  'carbonara.md': '# Spaghetti carbonara\n\nIngredients: 200g spaghetti, 100g guanciale, 2 eggs, pecorino romano, black pepper.\n\n1. Boil the pasta in salted water.\n2. Fry the guanciale until crisp.\n3. Mix eggs and cheese, toss with hot pasta off the heat.',
  'trip-notes.txt': 'Itinerary: fly TAP to Lisbon on May 3. Hotel in Alfama for five nights. Day trip to Sintra and Cascais, tram 28, pastéis de nata in Belém. Return flight May 8.',
  'plot_sales.py': 'import pandas as pd\nimport matplotlib.pyplot as plt\n\ndf = pd.read_csv("sales_2025.csv")\nmonthly = df.groupby("month")["revenue"].sum()\nmonthly.plot(kind="bar")\nplt.title("Monthly revenue")\nplt.savefig("sales_chart.png")',
  '会议纪要.txt': '第三季度预算会议纪要。参会人员:财务部、市场部。讨论了市场推广预算削减百分之十五,研发预算保持不变。下次会议定于十月二十日。',
}
const photos = {
  'IMG_0001.jpg': 'cats.jpg',
  'IMG_0002.jpg': 'tiger.jpg',
  'IMG_0003.jpg': 'football-match.jpg',
  'IMG_0004.jpg': 'city-streets.jpg',
  'IMG_0005.png': 'beach.png',
  'IMG_0006.png': 'receipt.png',
  'IMG_0007.png': 'invoice.png',
}

const items = []
let t = Date.now()
for (const [name, text] of Object.entries(texts)) {
  items.push({ name, search: await indexText(name, text) })
}
console.log(`indexed ${Object.keys(texts).length} texts in ${Date.now() - t} ms (includes model load)`)
t = Date.now()
for (const [name, file] of Object.entries(photos)) {
  const img = await RawImage.read(join(imageDir, file))
  const search = await indexPhoto(name, img)
  items.push({ name, search })
  console.log(`  ${name} (${file}) tags: ${search.g?.join(', ') ?? '—'}`)
}
console.log(`indexed ${Object.keys(photos).length} photos in ${Date.now() - t} ms (includes model load)`)
const bytes = items.map((i) => JSON.stringify(i.search).length)
console.log(`entry size: avg ${Math.round(bytes.reduce((a, b) => a + b) / bytes.length)} B, max ${Math.max(...bytes)} B`)

const cases = [
  ['lease notice period', 'lease-final.txt'],
  ['rental contract', 'lease-final.txt'],
  ['租房合同', 'lease-final.txt'],
  ['how to cook pasta', 'carbonara.md'],
  ['意大利面食谱', 'carbonara.md'],
  ['Lisbon vacation', 'trip-notes.txt'],
  ['sales chart python', 'plot_sales.py'],
  ['budget meeting', '会议纪要.txt'],
  ['预算会议', '会议纪要.txt'],
  ['cat', 'IMG_0001.jpg'],
  ['猫', 'IMG_0001.jpg'],
  ['tiger', 'IMG_0002.jpg'],
  ['soccer game', 'IMG_0003.jpg'],
  ['足球比赛', 'IMG_0003.jpg'],
  ['busy street downtown', 'IMG_0004.jpg'],
  ['beach', 'IMG_0005.png'],
  ['海滩', 'IMG_0005.png'],
  // receipt.png and invoice.png are both itemized bills; either is a fair answer
  ['receipt', ['IMG_0006.png', 'IMG_0007.png']],
  ['invoice', ['IMG_0007.png', 'IMG_0006.png']],
]

let pass = 0
const raw = []
for (const [q, expect] of cases) {
  const vecs = await embedQuery(q, true)
  const hits = rank({ text: q, vec: vecs.vec, clip: vecs.clip }, items, (i) => i)
  // raw scores for calibration: everything, unfiltered
  const all = items.map((i) => ({ name: i.name, s: rank({ text: q, vec: vecs.vec, clip: vecs.clip }, [i], (x) => x)[0]?.score ?? null }))
  raw.push({ q, expect, all })
  const top = hits[0]?.item.name
  const ok = Array.isArray(expect) ? expect.includes(top) : top === expect
  if (ok) pass++
  const fmt = hits.slice(0, 3).map((h) => `${h.item.name} ${h.score.toFixed(2)}`).join(' | ')
  console.log(`${ok ? 'PASS' : 'FAIL'}  "${q}" → ${fmt || '(no results)'}${ok ? '' : `   [expected ${expect}]`}`)
}
console.log(`\n${pass}/${cases.length} queries ranked the expected file first (CAL ${JSON.stringify(CAL)})`)
if (process.env.VERBOSE) console.log(JSON.stringify(raw, null, 1))
process.exitCode = pass >= cases.length - 2 ? 0 : 1

if (process.env.RAW) {
  const { cosineQ, dequantize } = await import(pathToFileURL(join(outDir, 'searchcore.mjs')))
  for (const [q, expect] of cases) {
    const v = await embedQuery(q, true)
    const rows = items.map((i) => ({
      n: i.name,
      e: i.search.e ? cosineQ(v.vec, dequantize(i.search.e)) : NaN,
      c: i.search.c ? cosineQ(v.clip, dequantize(i.search.c)) : NaN,
    }))
    const want = [expect].flat()
    const exp = rows.find((r) => r.n === want[0])
    const others = rows.filter((r) => !want.includes(r.n))
    const maxE = Math.max(...others.map((r) => r.e))
    const maxC = Math.max(...others.filter((r) => !isNaN(r.c)).map((r) => r.c))
    console.log(`RAW "${q}": expected e=${exp.e.toFixed(3)} c=${isNaN(exp.c) ? '—' : exp.c.toFixed(3)} | best-other e=${maxE.toFixed(3)} c=${maxC.toFixed(3)}`)
  }
}

// ─── Organize suggestions ─────────────────────────────────────────────
const { suggestMoves, SUGGEST } = await import(pathToFileURL(join(outDir, 'searchcore.mjs')))
const byName = Object.fromEntries(items.map((i) => [i.name, i]))
const extra = {
  'flight-confirmation.txt': 'Booking confirmation. Flight LH 1172 Frankfurt to Porto, seat 14C, departure 07:35. Please arrive at the gate 30 minutes before boarding.',
  'bank-statement-sept.txt': 'Account statement September. Opening balance 4,210.55. Card payments, direct debits, salary credit 3,800.00. Closing balance 5,032.10.',
  'pancakes.md': 'Fluffy pancakes: 200g flour, 2 eggs, 300ml milk, a pinch of salt, butter for the pan. Whisk and rest 20 minutes before cooking.',
  // unsorted, at the drive root
  'ramen.txt': '拉面做法:猪骨熬汤八小时,加入酱油和味醂调味,面条煮两分钟,配叉烧、溏心蛋和葱花。',
  'tokyo-hotel.txt': 'Reservation for 4 nights at Shinjuku Granbell Hotel, check-in Oct 12. Breakfast included. Free cancellation until Oct 5.',
  'electricity-bill.txt': 'Electricity bill, period August. Consumption 312 kWh. Amount due 96.40 EUR by direct debit on Sept 20.',
  'guitar-chords.txt': 'Am C G F progression, capo on 2nd fret, strumming pattern down down up up down up.',
  // misfiled under Recipes
  'taxi-receipt.txt': 'Taxi receipt. Fare 23.80 EUR, tip 2.00, paid by card. Airport to city centre, 19 km.',
}
for (const [name, text] of Object.entries(extra)) byName[name] = { name, search: await indexText(name, text) }
const folderSpec = {
  '': ['ramen.txt', 'tokyo-hotel.txt', 'electricity-bill.txt', 'guitar-chords.txt', 'IMG_0001.jpg'],
  Travel: ['trip-notes.txt', 'flight-confirmation.txt', 'IMG_0005.png'],
  Finance: ['bank-statement-sept.txt', 'IMG_0006.png', 'IMG_0007.png'],
  Recipes: ['carbonara.md', 'pancakes.md', 'taxi-receipt.txt'],
}
const { embedPassage } = await import(pathToFileURL(join(outDir, 'engine.mjs')))
const folders = await Promise.all(
  Object.entries(folderSpec).map(async ([path, names]) => ({
    path,
    files: names.map((n) => byName[n]),
    nameVec: path ? await embedPassage(path) : undefined,
  }))
)
const expectMoves = {
  '': { 'ramen.txt': 'Recipes', 'tokyo-hotel.txt': 'Travel', 'electricity-bill.txt': 'Finance' },
  Recipes: { 'taxi-receipt.txt': ['Finance', 'Travel'] }, // an airport taxi fits either
  Travel: {},
  Finance: {},
}
let sPass = 0, sTotal = 0
for (const [src, want] of Object.entries(expectMoves)) {
  const got = suggestMoves(folders, src, (i) => i)
  const gotMap = Object.fromEntries(got.map((m) => [m.item.name, m.to]))
  console.log(`suggest from "${src || '/'}": ${got.map((m) => `${m.item.name}→${m.to} (${m.fit.toFixed(2)})`).join(', ') || '(none)'}`)
  const names = new Set([...Object.keys(want), ...Object.keys(gotMap)])
  for (const n of names) {
    sTotal++
    if ([want[n]].flat().includes(gotMap[n])) sPass++
    else console.log(`  MISMATCH ${n}: expected ${want[n] ?? 'no move'}, got ${gotMap[n] ?? 'no move'}`)
  }
}
console.log(`${sPass}/${sTotal} suggestion checks (SUGGEST ${JSON.stringify(SUGGEST)})`)
if (sPass < sTotal) process.exitCode = 1
