// File-type icons (web/src/fileIcons.tsx), offline — no wallet, no network:
//   each extension (and, without one, the stored type) maps to its family
//   the grid icon's strip shows the extension (≤ 4 letters, "FILE" without
//   one), and every label fits its strip in a real browser
//   each family has its own colour; list icons carry no text
//
//   node scripts/test-file-icons.mjs
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// inside the project, so the bundle resolves react from node_modules
const dir = join(root, 'node_modules/.cache/test-file-icons')
mkdirSync(dir, { recursive: true })
const out = join(dir, 'fileIcons.mjs')
await build({ entryPoints: [join(root, 'web/src/fileIcons.tsx')], bundle: true, format: 'esm', platform: 'node', outfile: out, external: ['react'], jsx: 'automatic', logLevel: 'silent' })
const { FileIcon, FAMILIES, fileFamily, fileLabel } = await import(out)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const cases = [
  ['report.pdf', '', 'pdf'], ['Letter.DOCX', '', 'doc'], ['story.odt', '', 'doc'], ['deck.pptx', '', 'slides'],
  ['talk.key', '', 'slides'], ['budget.xlsx', '', 'sheet'], ['data.csv', 'text/csv', 'sheet'], ['notes.md', 'text/markdown', 'text'],
  ['todo.txt', 'text/plain', 'text'], ['app.ts', '', 'code'], ['index.html', 'text/html', 'code'], ['backup.zip', '', 'archive'],
  ['src.tar.gz', '', 'archive'], ['song.mp3', '', 'audio'], ['clip.mov', '', 'video'], ['photo.heic', '', 'image'],
  ['book.epub', '', 'ebook'], ['poster.psd', '', 'design'], ['Inter.woff2', '', 'font'], ['setup.dmg', '', 'app'],
  ['weird.xyz', '', 'generic'],
  // no extension: the stored type decides
  ['slides', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'slides'],
  ['sheet', 'application/vnd.ms-excel', 'sheet'], ['letter', 'application/msword', 'doc'], ['README', 'text/plain', 'text'],
  ['movie', 'video/mp4', 'video'], ['blob', 'application/octet-stream', 'generic'],
]
const wrong = cases.filter(([name, mime, want]) => fileFamily({ name, mime }) !== want).map(([n, m, w]) => `${n} (${m}) → ${fileFamily({ name: n, mime: m })}, want ${w}`)
check(`${cases.length} names and types map to their family`, wrong.length === 0, wrong.join('; '))

const labels = [['deck.pptx', 'PPTX'], ['a.pdf', 'PDF'], ['b.jpeg', 'JPEG'], ['c.markdown', 'MARK'], ['README', 'FILE'], ['.env', 'FILE'], ['x.tar.gz', 'GZ']]
const badLabels = labels.filter(([n, l]) => fileLabel(n) !== l).map(([n, l]) => `${n} → ${fileLabel(n)}, want ${l}`)
check('the strip shows the extension in capitals, at most 4 letters, "FILE" without one', badLabels.length === 0, badLabels.join('; '))

const colors = Object.values(FAMILIES).map((f) => f.color)
check('each family has its own colour', new Set(colors).size === colors.length, `${colors.length} families`)

// in a browser: every label fits its strip; list icons have no text
const widest = ['WOFF', 'WEBM', 'WEBP', 'MOBI', 'XLSX', 'DOCX', 'PPTX', 'JPEG', 'MARK', 'AZW3', 'MMMM', 'WMV', 'PDF', 'GZ']
const markup = (name, large) => renderToStaticMarkup(createElement(FileIcon, { meta: { name, mime: '' }, large }))
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.setContent(
    `<div id="big">${widest.map((l) => `<span style="display:inline-block;width:46px;height:55px">${markup(`x.${l.toLowerCase()}`, true).replace('class="ficon"', 'class="ficon" width="46" height="55"')}</span>`).join('')}</div>` +
      `<div id="small">${Object.keys(FAMILIES).map((f) => markup(`x.${f}`, false).replace('class="ficon"', 'class="ficon" width="19" height="19"')).join('')}</div>`
  )
  const fits = await page.$$eval('#big svg', (svgs) =>
    svgs.map((svg) => {
      const strip = svg.querySelector('rect').getBBox()
      const text = svg.querySelector('text').getBBox()
      return { label: svg.querySelector('text').textContent, ok: text.x >= strip.x + 1 && text.x + text.width <= strip.x + strip.width - 1 && text.height <= strip.height + 2 }
    })
  )
  check('every label fits its strip (the widest real extensions)', fits.every((f) => f.ok), fits.filter((f) => !f.ok).map((f) => f.label).join(', ') || fits.map((f) => f.label).join(' '))
  check('list icons carry no text (too small to read)', (await page.$$eval('#small svg text', (t) => t.length)) === 0)
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} checks passed`)
process.exit(passed === results.length ? 0 : 1)
