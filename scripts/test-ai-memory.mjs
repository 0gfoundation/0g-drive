// ONNX Runtime's WebAssembly memory is capped (web/src/ai/wasmMemory.ts), in
// headless Chromium against the dev server (npm run dev) or a deployment:
//   - ORT asks for 4 GB of room and gets 1 GB; the text model, the photo
//     models, indexing and searches work inside it, with the peak reported
//   - dev server only: a tab with room for 1 GB but not 4 GB, as an iPhone
//     tab gets after some refreshes (simulated: reservations over 1 GB are
//     refused with WebKit's "RangeError: Out of memory"). Without the cap
//     the models fail with the error users saw; with it they load.
//
//   node scripts/test-ai-memory.mjs [http://localhost:5173]
import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://localhost:5173'
const dev = /localhost|127\.0\.0\.1/.test(base)
const IMG = 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/'
const CAP = 16384 // pages: 1 GB

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) passed++
  else failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch()

/** A fresh context; `wasmMemory` rewrites that module's source (dev server only). */
async function open(wasmMemory) {
  const context = await browser.newContext()
  if (wasmMemory) {
    await context.route(/\/src\/ai\/wasmMemory\.ts/, async (route) => {
      const res = await route.fetch()
      await route.fulfill({ response: res, body: wasmMemory(await res.text()) })
    })
  }
  const page = await context.newPage()
  await page.goto(base)
  return { context, page }
}

/** The worker's record of ORT's memory: asked / given maximum (pages), current size (MB). */
async function ortMemory(page) {
  for (const w of page.workers()) {
    const r = await w
      .evaluate(() => {
        const m = globalThis.ortMemory
        return m ? { asked: m.asked, given: m.given, mb: m.memory.buffer.byteLength / 2 ** 20 } : null
      })
      .catch(() => null)
    if (r) return r
  }
  return null
}

const warm = (page) =>
  page.evaluate(async () => {
    const client = await import(location.origin + '/src/ai/client.ts').catch(() => null)
    if (!client) return { error: 'client not importable' }
    client.setSmartSearchEnabled(true)
    await client.warmUpModels() // a failure ends up in the model status
    const error = client.getModelStatus().error
    return error ? { error } : { ok: true }
  })

// ---- 1. the real thing: asked 4 GB, given 1 GB, everything fits
{
  const { context, page } = await open()
  const w = await warm(page)
  check('the text model loads', w.ok === true, w.error)
  const m1 = await ortMemory(page)
  check('ORT asks for 4 GB of room and gets 1 GB', m1?.asked === 65536 && m1?.given === CAP, JSON.stringify(m1))
  const long = Array.from({ length: 400 }, (_, i) => `Paragraph ${i}: the quarterly budget review covered marketing, research, travel and hiring plans.`).join('\n')
  const r = await page.evaluate(
    async ({ IMG, long }) => {
      const client = await import('/src/ai/client.ts')
      const core = await import('/src/ai/searchcore.ts')
      const fb = async (u, type) => new Blob([await (await fetch(u)).arrayBuffer()], { type })
      const items = []
      for (const [n, t] of [['cats.jpg', 'image/jpeg'], ['football-match.jpg', 'image/jpeg'], ['beach.png', 'image/png']]) items.push({ name: n, search: await client.indexFile(await fb(IMG + n, t), n, t) })
      items.push({ name: 'budget.txt', search: await client.indexFile(new Blob([long], { type: 'text/plain' }), 'budget.txt', 'text/plain') })
      const top = async (q) => {
        const v = await client.embedSearchQuery(q, true)
        return core.rank({ text: q, vec: v.vec, clip: v.clip }, items, (i) => i)[0]?.item.name
      }
      return { cat: await top('a cat'), budget: await top('budget review'), clip: items.filter((i) => i.search?.c).length }
    },
    { IMG, long }
  )
  check('photo models index photos and searches find them inside the cap', r.clip === 3 && r.cat === 'cats.jpg' && r.budget === 'budget.txt', JSON.stringify(r))
  const m2 = await ortMemory(page)
  check('peak use leaves at least half the cap free', m2 && m2.mb <= (CAP * 64) / 1024 / 2, `${m2?.mb.toFixed(0)} MB of ${(CAP * 64) / 1024} MB`)
  await context.close()
}

// ---- 2. a tab with room for 1 GB but not 4 GB (dev server: the module is rewritable)
if (dev) {
  const tight = `{ const Real = WebAssembly.Memory
  WebAssembly.Memory = class extends Real {
    constructor(d) { if (d.shared && d.maximum > ${CAP}) throw new RangeError('Out of memory'); super(d) }
  } }\n`
  {
    const { context, page } = await open(() => tight + 'export const MAX_PAGES = Infinity\n') // no cap
    const w = await warm(page)
    check('without the cap, such a tab fails as users saw', /no available backend.*Out of memory/is.test(w.error ?? ''), w.error ?? 'loaded')
    await context.close()
  }
  {
    const { context, page } = await open((src) => tight + src)
    const w = await warm(page)
    const m = await ortMemory(page)
    check('with the cap, the models load in that tab', w.ok === true && m?.given === CAP, w.error ?? JSON.stringify(m))
    await context.close()
  }
} else console.log('(the tight-tab checks need the dev server)')

await browser.close()
console.log(`${passed}/${passed + failed} checks passed`)
process.exitCode = failed ? 1 : 0
