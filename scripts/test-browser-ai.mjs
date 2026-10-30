// Browser test of the on-device AI path, in headless Chromium against the
// dev server (npm run dev): the real Web Worker, model download from the HF
// CDN, ONNX Runtime WebAssembly, pdf.js text extraction, and ranking — the
// code the app runs, imported straight from the page. No wallet needed.
//
//   node scripts/test-browser-ai.mjs [http://localhost:5173]
import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://localhost:5173'
const IMG = 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/'

// Minimal valid one-page PDF with real text (xref offsets computed)
function makePdf(text) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null, // content stream
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  let out = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return out
}

const browser = await chromium.launch()
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`)
})
page.on('worker', (w) => console.log(`worker started: ${w.url().split('?')[0]}`))
await page.goto(base)

const t0 = Date.now()
const result = await page.evaluate(
  async ({ IMG, pdf }) => {
    const client = await import('/src/ai/client.ts')
    const core = await import('/src/ai/searchcore.ts')
    client.setSmartSearchEnabled(true)
    await client.warmUpModels() // as the app does when a drive opens
    const progress = []
    client.subscribeModelStatus((s) => {
      if (s.loading && s.percent !== undefined && progress.at(-1) !== s.percent) progress.push(s.percent)
    })
    const fetchBlob = async (u, type) => new Blob([await (await fetch(u)).arrayBuffer()], { type })
    const items = []
    const add = async (name, blob, mime) => {
      const t = performance.now()
      const search = await client.indexFile(blob, name, mime)
      items.push({ name, search, ms: Math.round(performance.now() - t) })
    }
    await add('IMG_0001.jpg', await fetchBlob(IMG + 'cats.jpg', 'image/jpeg'), 'image/jpeg')
    await add('IMG_0002.png', await fetchBlob(IMG + 'beach.png', 'image/png'), 'image/png')
    await add('IMG_0003.jpg', await fetchBlob(IMG + 'football-match.jpg', 'image/jpeg'), 'image/jpeg')
    await add('lease.pdf', new Blob([pdf], { type: 'application/pdf' }), 'application/pdf')
    await add('会议纪要.txt', new Blob(['第三季度预算会议纪要。讨论了市场推广预算削减百分之十五,研发预算保持不变。'], { type: 'text/plain' }), 'text/plain')
    await add('carbonara.md', new Blob(['Spaghetti carbonara: guanciale, eggs, pecorino, black pepper. Boil the pasta.'], { type: 'text/markdown' }), 'text/markdown')

    const queries = [
      ['cat', 'IMG_0001.jpg'],
      ['海滩', 'IMG_0002.png'],
      ['soccer', 'IMG_0003.jpg'],
      ['rental agreement', 'lease.pdf'],
      ['租房合同', 'lease.pdf'],
      ['budget meeting', '会议纪要.txt'],
      ['pasta recipe', 'carbonara.md'],
    ]
    const out = []
    for (const [q, want] of queries) {
      const v = await client.embedSearchQuery(q, true)
      const hits = core.rank({ text: q, vec: v.vec, clip: v.clip }, items, (i) => i)
      out.push({ q, want, top: hits[0]?.item.name ?? null, score: hits[0]?.score ?? 0 })
    }
    // a rename redoes the embedding with the new name: a file whose content
    // says nothing gets found by meaning once its name does (scored under
    // the old name, so the name-text match can't be what helps)
    const vague = await client.indexFile(new Blob(['see list'], { type: 'text/plain' }), 'x7.txt', 'text/plain')
    const renamed = await client.entryForRename(vague, 'beach holiday packing list.txt')
    const v = await client.embedSearchQuery('what to bring on vacation', false)
    const score = (search) => core.rank({ text: 'what to bring on vacation', vec: v.vec }, [{ name: 'x7.txt', search }], (i) => i)[0]?.score ?? 0
    out.push({
      q: 'rename: "what to bring on vacation" scores higher after x7.txt → beach holiday packing list.txt',
      want: 'higher',
      top: renamed.e !== vague.e && renamed.t === vague.t && score(renamed) > score(vague) + 0.1 ? 'higher' : 'not higher',
      score: score(renamed) - score(vague),
    })
    // cached for next time?
    const cacheNames = await caches.keys()
    return {
      items: items.map((i) => ({ name: i.name, ms: i.ms, tags: i.search?.g, excerpt: i.search?.t?.slice(0, 60), hasVec: !!i.search?.e, hasClip: !!i.search?.c })),
      out,
      progressSamples: progress.length,
      cacheNames,
    }
  },
  { IMG, pdf: makePdf('Residential Lease Agreement between Landlord and Tenant. Notice period sixty days.') }
)

console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s (first run includes model download)`)
for (const i of result.items) console.log(`  indexed ${i.name.padEnd(14)} ${String(i.ms).padStart(6)} ms  vec=${i.hasVec} clip=${i.hasClip} tags=${i.tags?.join(',') ?? '—'} text=${i.excerpt ? JSON.stringify(i.excerpt) : '—'}`)
let pass = 0
for (const r of result.out) {
  const ok = r.top === r.want
  if (ok) pass++
  console.log(`${ok ? 'PASS' : 'FAIL'}  "${r.q}" → ${r.top} (${r.score.toFixed(2)})${ok ? '' : ` [expected ${r.want}]`}`)
}
console.log(`model download progress events: ${result.progressSamples}; caches: ${result.cacheNames.join(', ') || '(none)'}`)
if (errors.length) console.log('errors:\n  ' + errors.join('\n  '))
console.log(`${pass}/${result.out.length} browser queries correct`)
await browser.close()
process.exitCode = pass === result.out.length && errors.length === 0 ? 0 : 1
