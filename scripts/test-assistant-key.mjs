// The assistant's API key survives the browser being closed, in WebKit
// (Safari's engine, every browser on iPhone) at phone size and in Chromium.
// WebKit keeps a cross-origin frame's localStorage in memory only, so it's
// gone after a restart; the test clears it the same way and checks the key
// comes back from the assistant's cookie. Also: the drive page can't see the
// cookie and the Router never gets it; a refused question keeps the key
// unless the key itself is refused; Forget removes both copies. The 0G
// Router is mocked (no key, no cost). Unfunded: no wallet.
//   node scripts/test-assistant-key.mjs [http://localhost:5173]
import { webkit, chromium } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = process.argv[2] ?? 'http://localhost:5173'
const KEY = 'sk-probe0000000000000000000000'
const t0 = Date.now()
const at = () => `[${((Date.now() - t0) / 1000).toFixed(0)}s]`
let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${at()} ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** what the mocked Router answers: the key check, and questions */
const router = { check: 200, question: 200, cookies: 0 }
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' }
async function mockRouter(context) {
  await context.route('https://router-api.0g.ai/**', async (route) => {
    const req = route.request()
    if ((await req.allHeaders()).cookie) router.cookies++
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (!req.url().endsWith('/chat/completions')) return route.fulfill({ status: 404, headers: cors, body: '{}' })
    const isCheck = /Reply with OK/.test(req.postData() ?? '')
    const status = isCheck ? router.check : router.question
    if (status !== 200)
      return route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ error: { message: 'probe refusal', code: 'probe' } }) })
    return route.fulfill({
      status: 200,
      headers: { ...cors, 'content-type': 'application/json' },
      body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }),
    })
  })
}

async function run(engine, label, viewport) {
  const dir = mkdtempSync(join(tmpdir(), 'assist-key-'))
  const opts = { viewport, ...(viewport.width < 500 ? { isMobile: true, hasTouch: true } : {}) }
  const launch = async () => {
    const context = await engine.launchPersistentContext(dir, opts)
    await mockRouter(context)
    const page = context.pages()[0] ?? (await context.newPage())
    await page.goto(base)
    await page.getByRole('button', { name: 'Ask the assistant' }).click({ timeout: 60_000 })
    let frame
    for (let i = 0; i < 60 && !frame; i++) {
      frame = page.frames().find((f) => f !== page.mainFrame() && /:3000|assistant/.test(f.url()))
      if (!frame) await page.waitForTimeout(500)
    }
    await frame.waitForLoadState()
    await frame.locator('textarea, input[type=password]').first().waitFor({ timeout: 30_000 })
    return { context, page, frame }
  }
  const showsChat = async (frame) => (await frame.locator('textarea').count()) > 0
  const ask = async (frame, q) => {
    const before = await frame.locator('.turn').count()
    await frame.fill('textarea', q)
    await frame.press('textarea', 'Enter')
    const turn = frame.locator('.turn').nth(before)
    await turn.locator('.error').waitFor({ timeout: 30_000 })
    await frame.page().waitForTimeout(1500) // the follow-up key check lands
    return (await turn.locator('.error').textContent()).trim()
  }
  try {
    console.log(`${at()} ---- ${label}`)
    router.check = router.question = 200
    let { context, page, frame } = await launch()
    await frame.fill('input[type=password]', KEY)
    await frame.getByRole('button', { name: 'Save key' }).click()
    await frame.locator('textarea').waitFor({ timeout: 30_000 })
    // cookies don't separate ports: on localhost the drive (:5173) and the
    // assistant (:3000) share them; deployed, they're different hosts
    if (!/^http:\/\/localhost/.test(base)) {
      const pageCookie = await page.evaluate(() => document.cookie)
      check(`${label}: the drive page can’t see the key cookie`, !pageCookie.includes('0gassist'), JSON.stringify(pageCookie))
    }

    // what iOS does to the frame's storage when the browser closes
    await frame.evaluate(() => localStorage.clear())
    await context.close()
    ;({ context, page, frame } = await launch())
    check(`${label}: after a restart with the frame’s localStorage gone, the key is still there`, await showsChat(frame))
    check(`${label}: …and localStorage has it again`, (await frame.evaluate(() => localStorage.getItem('0gassist:key'))) === KEY)

    router.question = 403
    router.check = 200
    const e1 = await ask(frame, 'How do I share a file?')
    check(`${label}: a refused question keeps the key and shows the Router’s reason`, (await showsChat(frame)) && /probe refusal/.test(e1), JSON.stringify(e1))

    router.question = 401
    router.check = 401
    await frame.fill('textarea', 'How do I share a file?')
    await frame.press('textarea', 'Enter')
    await frame.locator('.setup').waitFor({ timeout: 30_000 }).catch(() => {})
    const setupError = (await frame.locator('.setup .error').textContent({ timeout: 10_000 }).catch(() => '')) ?? ''
    check(`${label}: a key the Router refuses goes back to setup, with the message`, !(await showsChat(frame)) && /refused/.test(setupError), JSON.stringify(setupError))
    const gone = await frame.evaluate(() => ({ ls: localStorage.getItem('0gassist:key'), cookie: document.cookie }))
    check(`${label}: …and both copies are removed`, gone.ls === null && !gone.cookie.includes('0gassist_key'), JSON.stringify(gone))

    router.question = 200
    router.check = 200
    await frame.fill('input[type=password]', KEY)
    await frame.getByRole('button', { name: 'Save key' }).click()
    await frame.locator('textarea').waitFor({ timeout: 30_000 })
    await frame.getByRole('button', { name: 'Assistant settings' }).click()
    await frame.getByRole('menuitem', { name: 'Forget API key' }).click()
    await context.close()
    ;({ context, page, frame } = await launch())
    check(`${label}: Forget API key: after a restart it asks for a key`, !(await showsChat(frame)))
    if (viewport.width < 500) {
      const fit = await frame.evaluate(() => ({ w: document.documentElement.scrollWidth, vw: innerWidth }))
      check(`${label}: the key screen fits`, fit.w <= fit.vw, JSON.stringify(fit))
    }
    await context.close()
  } catch (e) {
    failed++
    console.log(`${at()} ERROR ${label}: ${e.message.split('\n')[0]}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

await run(webkit, 'WebKit, phone', { width: 390, height: 844 })
await run(chromium, 'Chromium, desktop', { width: 1280, height: 900 })
check('the Router never got a cookie', router.cookies === 0, `${router.cookies} requests with cookies`)
console.log(failed ? `${failed} FAILED` : 'ASSISTANT KEY TEST PASSED ✓')
process.exitCode = failed ? 1 : 0
