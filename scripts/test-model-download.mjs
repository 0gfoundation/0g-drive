// First-visit model download in headless Chromium (empty cache), against the
// dev server: byte progress must only go up while it shows and reach 90%,
// and the models must load. The text model comes from 0G Storage
// (web/src/ai/modelOn0g.ts), the rest from the CDNs: once over the direct CDN route and once with the CDNs
// blackholed (requests hang, as on networks that can't reach Hugging Face),
// which must fall back to the app's /_models/ route. No wallet needed.
//
//   node scripts/test-model-download.mjs [http://localhost:5173]
import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://localhost:5173'
const browser = await chromium.launch()
let failed = 0

for (const blocked of [false, true]) {
  const ctx = await browser.newContext()
  let hung = 0
  if (blocked) {
    await ctx.route(/^https:\/\/(huggingface\.co|cdn\.jsdelivr\.net|[^/]*\.hf\.co)\//, () => {
      hung++ // never answered
    })
  }
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(base)
  const t0 = Date.now()
  const r = await page.evaluate(async () => {
    const c = await import('/src/ai/client.ts')
    const seen = []
    const runs = [[]] // percents per stretch of loading: a later step (the photo model) joins the total, so a new run starts lower
    const texts = new Set()
    let viaServer = false
    c.subscribeModelStatus((s) => {
      if (s.percent !== undefined) seen.push(s.percent), runs.at(-1).push(s.percent)
      else if (!s.loading && runs.at(-1).length) runs.push([])
      if (s.viaServer) viaServer = true
      if (s.percent !== undefined && s.percent % 25 === 0) texts.add(c.describeModelStatus(s))
    })
    await c.warmUpModels()
    const q = await c.embedSearchQuery('猫', true)
    await new Promise((r) => setTimeout(r, 500)) // persist() runs after warm-up
    return {
      persisted: await navigator.storage.persisted(),
      status: c.getModelStatus(),
      monotonic: runs.every((run) => run.every((v, i) => i === 0 || v >= run[i - 1])),
      runs: runs.filter((run) => run.length).length,
      updates: seen.length,
      maxPercent: Math.max(...seen),
      viaServer,
      dims: [q.vec.length, q.clip?.length],
      samples: [...texts].slice(0, 4),
    }
  })
  const secs = Math.round((Date.now() - t0) / 1000)
  const ok =
    !r.status.loading && !r.status.error && r.monotonic && r.maxPercent >= 90 &&
    r.dims[0] === 384 && r.dims[1] === 512 && r.viaServer === blocked && !errors.length
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${blocked ? 'CDNs blackholed' : 'direct'}: ${secs}s, ${r.updates} updates in ${r.runs} runs, ` +
    `monotonic=${r.monotonic}, viaServer=${r.viaServer}${blocked ? `, ${hung} requests hung` : ''}, persisted=${r.persisted}`)
  for (const t of r.samples) console.log(`        ${t}`)
  if (errors.length) console.log('  errors:', errors.slice(0, 3))
  await ctx.close()
}
await browser.close()
console.log(failed ? `${failed} FAILED` : 'MODEL DOWNLOAD TEST PASSED ✓')
process.exit(failed ? 1 : 0)
