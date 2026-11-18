// Whole-file embeddings (D43): calibration on real documents, with the app's
// code (indexText, likenessOf, discover, growJoins) and the trimmed text
// model. The sample: 27 arXiv papers in 4 subjects (LLM agents, retrieval,
// vision, blockchain consensus and data availability; downloaded by ID) and
// 15 Wikipedia/Wikivoyage articles in 5 (finance, health, legal, travel,
// recipes), indexed as the app reads them (30 pages, 256 KB), with the short
// files of scripts/fixtures/discover-sample.json among them. Prints:
//   - TEXT_CENTRE: the average of the long documents' meaning (searchcore.ts)
//   - Suggest categories at each bar, on drives of different makeup
//   - growth: each subject's long documents kept as a category but one,
//     does the held-out one rejoin it, and does anything else join
//   - search by meaning (e and w) against by e alone
// Not a pass/fail test: the numbers behind DISCOVER.link and GROW.floor.
// Downloads are cached in node_modules/.cache/calibrate-whole-file.
//   node scripts/calibrate-whole-file.mjs
import { build } from 'esbuild'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { env } from '@huggingface/transformers'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cache = join(root, 'node_modules/.cache/calibrate-whole-file')
const outDir = join(cache, 'build')
mkdirSync(join(cache, 'pdf'), { recursive: true })
mkdirSync(join(cache, 'wiki'), { recursive: true })
await build({
  entryPoints: ['engine', 'searchcore', 'categories', 'discover', 'subject'].map((m) => join(root, `web/src/ai/${m}.ts`)),
  bundle: true, format: 'esm', platform: 'node', outdir: outDir, outExtension: { '.js': '.mjs' },
  external: ['@huggingface/transformers'], logLevel: 'error',
})
// the trimmed model, as test-search.mjs fetches it (run that once first)
env.localModelPath = join(root, 'node_modules/.cache/test-search/models') + '/'
env.allowLocalModels = true
const imp = (m) => import(pathToFileURL(join(outDir, `${m}.mjs`)))
const E = await imp('engine')
const Q = await imp('searchcore')
const C = await imp('categories')
const D = await imp('discover')
const S = await imp('subject')
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

const PAPERS = {
  agents: ['2210.03629', '2302.04761', '2303.11366', '2304.03442', '2305.16291', '2308.11432'],
  rag: ['2005.11401', '2004.04906', '2312.10997', '2307.03172', '2310.11511', '2002.08909'],
  vision: ['2006.11239', '2010.11929', '1506.02640', '2103.00020', '1512.03385', '2112.10752'],
  chain: ['1803.05069', '2105.11827', '2201.05677', '1807.04938', '1607.01341', '1710.09437', '1809.09044', '1905.09274', '2109.04347'],
}
const ARTICLES = {
  finance: [['en.wikipedia.org', 'Mortgage loan'], ['en.wikipedia.org', 'Index fund'], ['en.wikipedia.org', 'Income tax']],
  health: [['en.wikipedia.org', 'Type 2 diabetes'], ['en.wikipedia.org', 'Influenza'], ['en.wikipedia.org', 'Hypertension']],
  legal: [['en.wikipedia.org', 'Lease'], ['en.wikipedia.org', 'Non-disclosure agreement'], ['en.wikipedia.org', 'Employment contract']],
  travel: [['en.wikivoyage.org', 'Lisbon'], ['en.wikivoyage.org', 'Kyoto'], ['en.wikivoyage.org', 'Barcelona']],
  recipes: [['en.wikipedia.org', 'Carbonara'], ['en.wikipedia.org', 'Ratatouille'], ['en.wikipedia.org', 'Pad thai']],
}
const QUERIES = [
  ['agent that plays Minecraft and writes code skills', '2305.16291'], ['simulated town where characters remember and plan their day', '2304.03442'],
  ['language agent reflects on its failures in words', '2303.11366'], ['interleave thoughts and actions on HotpotQA and ALFWorld', '2210.03629'],
  ['model calls a calculator and a search API', '2302.04761'], ['survey of how LLM-based autonomous agents are built and evaluated', '2308.11432'],
  ['accuracy drops when the relevant document is in the middle of the input', '2307.03172'], ['dual encoder retriever beats BM25 for question answering', '2004.04906'],
  ['retriever pre-trained with masked language modeling', '2002.08909'], ['reflection tokens decide when to retrieve', '2310.11511'],
  ['naive, advanced and modular RAG paradigms', '2312.10997'], ['seq2seq generator with a dense vector index of Wikipedia', '2005.11401'],
  ['skip connections to train very deep networks', '1512.03385'], ['split an image into patches and feed a transformer', '2010.11929'],
  ['one network predicts bounding boxes in real time', '1506.02640'], ['contrastive image-text pretraining for zero-shot classification', '2103.00020'],
  ['diffusion in the latent space of an autoencoder for text-to-image', '2112.10752'], ['predicting the noise to generate images', '2006.11239'],
  ['leader-based BFT with linear view change', '1803.05069'], ['separate transaction dissemination from ordering', '2105.11827'],
  ['DAG BFT protocol with no view-change', '2201.05677'], ['gossip-based termination for Tendermint', '1807.04938'],
  ['cryptographic sortition selects the committee', '1607.01341'], ['finality on top of proof of work with validator deposits and slashing', '1710.09437'],
  ['erasure coding lets light clients check data availability', '1809.09044'], ['blockchain only orders data and clients execute it', '1905.09274'],
  ['automatically find arbitrage and MEV attacks in DeFi contracts', '2109.04347'],
  ['how much interest I pay on my home loan', 'Mortgage loan'], ['low-cost passive funds that track the S&P 500', 'Index fund'],
  ['progressive tax brackets on earnings', 'Income tax'], ['insulin resistance and blood sugar', 'Type 2 diabetes'],
  ['flu vaccine, fever and symptoms', 'Influenza'], ['treating high blood pressure', 'Hypertension'],
  ['tenant pays rent to the landlord', 'Lease'], ['keep trade secrets confidential', 'Non-disclosure agreement'],
  ['terms agreed between employer and worker', 'Employment contract'], ['trams and pastel de nata', 'Lisbon'],
  ['temples and the geisha district', 'Kyoto'], ['Gaudí, Sagrada Família and tapas', 'Barcelona'],
  ['pasta with eggs, guanciale and pecorino', 'Carbonara'], ['stewed vegetables from Provence', 'Ratatouille'],
  ['stir-fried rice noodles with tamarind', 'Pad thai'],
]

const pause = (ms) => new Promise((r) => setTimeout(r, ms))
async function fetchOnce(url, dest, ok) {
  if (existsSync(dest)) return readFileSync(dest)
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { 'user-agent': '0gdrive-calibration/1.0 (https://github.com/0gfoundation/0g-drive)' } })
    const buf = Buffer.from(await res.arrayBuffer())
    if (res.ok && ok(buf)) {
      writeFileSync(dest, buf)
      await pause(2000)
      return buf
    }
    await pause(15_000 * (attempt + 1))
  }
  throw new Error(`couldn’t fetch ${url}`)
}

// ── the documents, read as the app reads them
const docs = []
let at = Date.now()
for (const [subject, ids] of Object.entries(PAPERS)) {
  for (const id of ids) {
    const buf = await fetchOnce(`https://arxiv.org/pdf/${id}`, join(cache, 'pdf', `${id}.pdf`), (b) => b.subarray(0, 5).toString() === '%PDF-')
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise
    const parts = []
    let title
    for (let p = 1; p <= Math.min(30, doc.numPages); p++) {
      const items = (await (await doc.getPage(p)).getTextContent()).items.filter((i) => 'str' in i)
      if (p === 1) title = S.pdfTitle(items)
      parts.push(items.map((i) => i.str).join(' '))
    }
    const text = parts.join('\n').replace(/\s+/g, ' ').trim()
    docs.push({ id, name: `${id}.pdf`, subject, long: true, text, title })
  }
}
for (const [subject, list] of Object.entries(ARTICLES)) {
  for (const [host, title] of list) {
    const url = `https://${host}/w/api.php?action=query&prop=extracts&explaintext=1&format=json&redirects=1&titles=${encodeURIComponent(title)}`
    const buf = await fetchOnce(url, join(cache, 'wiki', `${title.replace(/\W+/g, '-')}.json`), (b) => b[0] === 0x7b)
    const page = Object.values(JSON.parse(buf.toString()).query.pages)[0]
    // a text file: the app reads its first 256 KB; a number for a name, so only the content counts
    docs.push({ id: title, name: `${String(docs.length).padStart(4, '0')}.txt`, subject, long: true, text: page.extract.slice(0, 256 * 1024) })
  }
}
const BROAD = { da: 'chain', consensus: 'chain', bridge: 'chain' }
for (const [subject, name, text] of JSON.parse(readFileSync(join(root, 'scripts/fixtures/discover-sample.json'), 'utf8'))) {
  docs.push({ id: `short:${name}`, name, subject: BROAD[subject] ?? subject, long: false, text })
}
let ms = 0
for (const d of docs) {
  const t = performance.now()
  d.entry = await E.indexText(d.name, d.text, d.title)
  if (d.long) ms += performance.now() - t
  d.file = { id: d.id, name: d.name, uploadedAt: at--, mime: 'text/plain', search: d.entry }
}
const longs = docs.filter((d) => d.long)
console.log(`${docs.length} files: ${longs.length} long (${longs.filter((d) => d.entry.w).length} with a whole-file vector), ${docs.length - longs.length} short; indexing ${(ms / longs.length).toFixed(0)} ms per long file in Node`)

// ── TEXT_CENTRE: the average of the long documents' meaning
const sum = new Float32Array(384)
for (const d of longs) Q.meaningOf(d.entry).forEach((x, i) => (sum[i] += x))
// scaled to its largest component for int8 precision: it's normalized again where it's used
const top = Math.max(...sum.map(Math.abs))
const centre = Q.quantize(sum.map((x) => x / top))
console.log(`\nTEXT_CENTRE = '${centre}'`)
if (Q.TEXT_CENTRE !== centre) console.log('(differs from searchcore.ts: the numbers below use the one in searchcore.ts)')

// ── Suggest categories at each bar, on drives of different makeup
const PAPER = new Set(Object.keys(PAPERS))
const drives = {
  everything: docs,
  'papers + their abstracts': docs.filter((d) => PAPER.has(d.subject)),
  'everyday files': docs.filter((d) => !PAPER.has(d.subject)),
  'papers + a few everyday': docs.filter((d) => PAPER.has(d.subject) || ['finance', 'travel'].includes(d.subject)),
}
const bars = [0.14, 0.16, 0.18, 0.2, 0.22, 0.24, 0.26, 0.28, 0.3, 0.33]
console.log('\nSuggest categories — files in a group of their subject / files grouped (groups mixed):')
for (const [name, ds] of Object.entries(drives)) {
  const cells = bars.map((link) => {
    D.DISCOVER.link = link
    let right = 0, grouped = 0, mixed = 0
    for (const g of D.discover(ds.map((d) => d.file), () => [], () => 0)) {
      const subj = new Map()
      for (const id of g.fileIds) { const s = ds.find((d) => d.id === id).subject; subj.set(s, (subj.get(s) ?? 0) + 1) }
      right += Math.max(...subj.values()); grouped += g.fileIds.length; if (subj.size > 1) mixed++
    }
    return `${link}: ${right}/${grouped}${mixed ? ` (${mixed})` : ''}`
  })
  console.log(`  ${name} (${ds.length}): ${cells.join(' · ')}`)
}

// ── growth: each subject's files kept as a category but one
const floors = [0.16, 0.18, 0.2, 0.22, 0.24, 0.26, 0.28]
console.log('\nGrowth — held-out files back in their category / other files joining:')
const files = docs.map((d) => d.file)
for (const floor of floors) {
  C.GROW.floor = floor
  let back = 0, held = 0, wrong = 0
  for (const subject of new Set(docs.map((d) => d.subject))) {
    const members = docs.filter((d) => d.subject === subject)
    if (members.length < 4) continue
    for (const out of members) {
      const user = { own: [{ id: 'own:x', name: subject, grow: true }], pins: members.filter((m) => m !== out).map((m) => ({ file: m.id, cat: 'own:x', in: true })) }
      const joins = C.growJoins(files, user)
      held++
      if (joins.get(out.id)?.includes('own:x')) back++
      const bad = [...joins].filter(([id, cs]) => cs.includes('own:x') && docs.find((d) => d.id === id).subject !== subject)
      wrong += bad.length
      if (process.env.SHOW_WRONG && floor === 0.2) for (const [id] of bad) console.log(`    ${id} (${docs.find((d) => d.id === id).subject}) joined ${subject}`)
    }
  }
  console.log(`  floor ${floor}: ${back}/${held} back, ${wrong} wrong joins (over ${held} trials)`)
}

// ── search by meaning
for (const [label, vec] of [['e alone', (d) => Q.meaningOf({ e: d.entry.e })], ['e and w (search)', (d) => Q.meaningOf(d.entry)]]) {
  let top1 = 0, rr = 0
  for (const [q, id] of QUERIES) {
    const qv = await E.embedQueryText(q)
    const ranked = longs.map((d) => ({ id: d.id, s: vec(d).reduce((acc, x, i) => acc + x * qv[i], 0) })).sort((a, b) => b.s - a.s)
    const r = ranked.findIndex((x) => x.id === id) + 1
    if (r === 1) top1++
    rr += 1 / r
  }
  console.log(`\nSearch by ${label}: the query's document first ${top1}/${QUERIES.length}, MRR ${(rr / QUERIES.length).toFixed(3)}`)
}
