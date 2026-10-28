// First-visit model download in headless Chromium (empty cache), against the
// dev server: byte progress must only go up and the models must load —
// once over the direct CDN route and once with the CDNs blackholed (requests
// hang, as on networks that can't reach Hugging Face), which must fall back
// to the app's /_models/ route. No wallet needed. ~2 min, ~600 MB downloaded.
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
    const texts = new Set()
    let viaServer = false
    c.subscribeModelStatus((s) => {
      if (s.percent !== undefined) seen.push(s.percent)
      if (s.viaServer) viaServer = true
      if (s.percent !== undefined && s.percent % 25 === 0) texts.add(c.describeModelStatus(s))
    })
    await c.warmUpModels()
    const q = await c.embedSearchQuery('猫', true)
    await new Promise((r) => setTimeout(r, 500)) // persist() runs after warm-up
    return {
      persisted: await navigator.storage.persisted(),
      status: c.getModelStatus(),
      monotonic: seen.every((v, i) => i === 0 || v >= seen[i - 1]),
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
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${blocked ? 'CDNs blackholed' : 'direct'}: ${secs}s, ${r.updates} updates, ` +
    `monotonic=${r.monotonic}, viaServer=${r.viaServer}${blocked ? `, ${hung} requests hung` : ''}, persisted=${r.persisted}`)
  for (const t of r.samples) console.log(`        ${t}`)
  if (errors.length) console.log('  errors:', errors.slice(0, 3))
  await ctx.close()
}
await browser.close()
console.log(failed ? `${failed} FAILED` : 'MODEL DOWNLOAD TEST PASSED ✓')
process.exit(failed ? 1 : 0)
