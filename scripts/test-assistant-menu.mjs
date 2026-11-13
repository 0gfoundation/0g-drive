// The assistant's ⋯ menu closes when you click elsewhere: in the assistant,
// on the drive page beside it, or on "Balance & usage ↗"; clicks in the menu
// still work. Reported by the user: the menu stayed open. Chromium at desktop
// size and WebKit at phone size. The 0G Router is mocked (no key, no cost).
// Unfunded: no wallet.
//   node scripts/test-assistant-menu.mjs [http://localhost:5173]
import { webkit, chromium } from 'playwright'

const base = process.argv[2] ?? 'http://localhost:5173'
const KEY = 'sk-probe0000000000000000000000'
const t0 = Date.now()
const at = () => `[${((Date.now() - t0) / 1000).toFixed(0)}s]`
let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${at()} ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' }
async function mockRouter(context) {
  await context.route('https://router-api.0g.ai/**', (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (!req.url().endsWith('/chat/completions')) return route.fulfill({ status: 404, headers: cors, body: '{}' })
    return route.fulfill({
      status: 200,
      headers: { ...cors, 'content-type': 'application/json' },
      body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }),
    })
  })
  // the dashboard link opens a tab: answer it here
  await context.route('https://pc.0g.ai/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>dashboard</title>' }))
}

async function run(engine, label, viewport) {
  const phone = viewport.width < 500
  const browser = await engine.launch()
  const context = await browser.newContext({ viewport, ...(phone ? { isMobile: true, hasTouch: true } : {}) })
  await mockRouter(context)
  try {
    console.log(`${at()} ---- ${label}`)
    const page = await context.newPage()
    await page.goto(base)
    await page.getByRole('button', { name: 'Ask the assistant' }).click({ timeout: 60_000 })
    let frame
    for (let i = 0; i < 60 && !frame; i++) {
      frame = page.frames().find((f) => f !== page.mainFrame() && /:3000|assistant/.test(f.url()))
      if (!frame) await page.waitForTimeout(500)
    }
    await frame.waitForLoadState()
    await frame.locator('input[type=password]').waitFor({ timeout: 30_000 })
    await frame.fill('input[type=password]', KEY)
    await frame.getByRole('button', { name: 'Save key' }).click()
    await frame.locator('textarea').waitFor({ timeout: 30_000 })

    const dots = frame.getByRole('button', { name: 'Assistant settings' })
    const menu = frame.locator('.menu')
    const isOpen = async () => {
      await page.waitForTimeout(300)
      return (await menu.count()) > 0
    }
    const panelOpen = () => page.locator('.assist-panel.open').count().then((n) => n > 0)
    const tap = (target) => (phone ? target.tap() : target.click())

    await tap(dots)
    const box = await menu.boundingBox()
    const panelBox = await page.locator('.assist-panel').boundingBox()
    check(`${label}: ⋯ opens the menu, inside the panel`,
      (await isOpen()) && box.x >= panelBox.x && box.x + box.width <= panelBox.x + panelBox.width + 0.5, JSON.stringify({ box, panelBox }))

    await tap(frame.locator('.title'))
    check(`${label}: a click elsewhere in the assistant closes it`, !(await isOpen()))

    await tap(dots)
    await tap(frame.locator('textarea'))
    check(`${label}: so does a click in the question box`, !(await isOpen()))

    if (!phone) {
      // the drive page beside the panel: this frame only sees losing focus
      await dots.click()
      const panel = await page.locator('.assist-panel').boundingBox()
      await page.mouse.click(Math.max(10, panel.x / 2), viewport.height / 2)
      check(`${label}: a click on the drive page beside the panel closes it`, !(await isOpen()), `panel still open: ${await panelOpen()}`)
      if (!(await panelOpen())) await page.getByRole('button', { name: 'Ask the assistant' }).click()
    }

    await tap(dots)
    const tab = context.waitForEvent('page', { timeout: 10_000 }).catch(() => null)
    await tap(frame.getByRole('menuitem', { name: /Balance & usage/ }))
    const opened = await tab
    check(`${label}: “Balance & usage ↗” opens the dashboard and closes the menu`, opened !== null && !(await isOpen()), opened?.url())
    await opened?.close()

    await tap(dots)
    await page.keyboard.press('Escape')
    check(`${label}: Escape still closes it, the panel stays`, !(await isOpen()) && (await panelOpen()))

    await tap(dots)
    await tap(frame.getByRole('menuitem', { name: 'Forget API key' }))
    await frame.locator('input[type=password]').waitFor({ timeout: 10_000 }).catch(() => {})
    check(`${label}: a click in the menu still works (Forget API key)`, (await frame.locator('input[type=password]').count()) === 1 && !(await isOpen()))
  } catch (e) {
    failed++
    console.log(`${at()} ERROR ${label}: ${e.message.split('\n')[0]}`)
  } finally {
    await browser.close()
  }
}

await run(chromium, 'Chromium, desktop', { width: 1280, height: 900 })
await run(webkit, 'WebKit, phone', { width: 390, height: 844 })
console.log(failed ? `${failed} FAILED` : 'ASSISTANT MENU TEST PASSED ✓')
process.exitCode = failed ? 1 : 0
