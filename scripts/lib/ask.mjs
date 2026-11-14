/**
 * Answers the drive's own confirm and prompt boxes (AskDialog) as they open,
 * the way page.on('dialog') answered the browser's.
 *
 * answer(q) gets { title, message, text, prompt } and returns a string to
 * type into a prompt, false to cancel, or anything else to press the action
 * button (a prompt keeps its suggested value). Returns the questions seen.
 */
export function answerAsks(page, answer = () => true) {
  const seen = []
  const modal = page.locator('.ask-modal')
  ;(async () => {
    while (!page.isClosed()) {
      try {
        await modal.waitFor({ state: 'visible', timeout: 0 })
      } catch {
        return // the page closed
      }
      const q = await modal
        .evaluate((m) => ({
          title: m.querySelector('h2')?.textContent ?? '',
          message: m.querySelector('.ask-message')?.textContent ?? '',
          prompt: m.querySelector('input') !== null,
        }))
        .catch(() => null)
      if (!q) continue
      q.text = q.message ? `${q.title} ${q.message}` : q.title
      seen.push(q)
      try {
        const a = await answer(q)
        if (a === false) await modal.getByRole('button', { name: 'Cancel' }).click()
        else {
          if (q.prompt && typeof a === 'string') await modal.locator('input').fill(a)
          await modal.locator('button[type="submit"]').click()
        }
        await modal.waitFor({ state: 'detached', timeout: 10_000 })
      } catch {
        // the page navigated or closed mid-answer; the next loop sees
      }
    }
  })()
  return seen
}
