// What a file's embedding is made from (D41), without the model: a paper's
// title (its first page's largest horizontal text) and its abstract on, the
// author block left out; other text cleaned of greetings, signatures,
// attendees, license headers. On three real arXiv first pages as pdf.js
// gives them (scripts/fixtures/arxiv-openings.json: their first 80 text
// items and the opening the index reads) and on letters, meeting notes,
// code and a Chinese paper.
//   node scripts/test-subject.mjs
import { build } from 'esbuild'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'node_modules/.cache/test-subject')
mkdirSync(outDir, { recursive: true })
await build({ entryPoints: [join(root, 'web/src/ai/subject.ts')], bundle: true, format: 'esm', platform: 'node', outdir: outDir, outExtension: { '.js': '.mjs' }, logLevel: 'error' })
const { subjectText, pdfTitle } = await import(pathToFileURL(join(outDir, 'subject.mjs')))

let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
// what the text model reads of it (passageText: 600 characters)
const window = (s) => (s ?? '').slice(0, 600)

const papers = JSON.parse(readFileSync(join(root, 'scripts/fixtures/arxiv-openings.json'), 'utf8'))
const AUTHORS = {
  '1706.03762': ['Vaswani', 'Shazeer', 'Parmar', 'Uszkoreit', 'Gomez', 'Kaiser', 'Polosukhin', 'google.com', 'permission'],
  '2210.03629': ['Shunyu', 'Jeffrey Zhao', 'Shafran', 'Narasimhan', 'Princeton'],
  '2302.04761': ['Schick', 'Dwivedi', 'Dessì', 'Raileanu', 'Lomeli', 'Zettlemoyer', 'Cancedda', 'Scialom', 'Pompeu'],
}
const titles = Object.fromEntries(papers.map((p) => [p.arxiv, pdfTitle(p.items)]))
console.log(Object.entries(titles).map(([k, t]) => `  ${k} title: ${JSON.stringify(t)}`).join('\n'))
check('a PDF title is its largest horizontal text, not a rotated stamp (Attention, not "arXiv:1706.03762v7…")', titles['1706.03762'] === 'Attention Is All You Need')
check('…Toolformer’s title read', titles['2302.04761'] === 'Toolformer: Language Models Can Teach Themselves to Use Tools')
check('…small caps pdf.js splits into letters (ReAct) give no title, not letters', titles['2210.03629'] === undefined)
for (const p of papers) {
  const before = window(p.text)
  const after = window(subjectText(p.text, titles[p.arxiv]))
  const namesBefore = AUTHORS[p.arxiv].filter((n) => before.includes(n))
  const namesAfter = AUTHORS[p.arxiv].filter((n) => after.includes(n))
  console.log(`  ${p.arxiv} reads now: ${JSON.stringify(after.slice(0, 150))}…`)
  check(`${p.arxiv}: the embedding reads its abstract, not its authors (before: ${namesBefore.length} author/notice words)`,
    namesAfter.length === 0 && /language|sequence|reasoning|model/i.test(after.slice(0, 300)), namesAfter.join(', '))
}

const letter = 'Dear Ms. Chen,\nThank you for the quote for the kitchen renovation. We would like it to start in March.\nBest regards,\nJohn Smith'
const s1 = subjectText(letter)
check('a letter: its greeting and signature left out', !/Chen|John|Smith/.test(s1) && /kitchen renovation/.test(s1), JSON.stringify(s1))
const notes = '# Standup, Monday\nAttendees: Ming Zeng, Xiang Li, Wei Chen, Hao Wu\nRoadmap: the Q3 roadmap slips a week; the release checklist needs owners.'
const s2 = subjectText(notes)
check('meeting notes: the attendees line left out', !/Zeng|Xiang|Wei Chen|Hao Wu/.test(s2) && /roadmap/.test(s2), JSON.stringify(s2))
const code = '/**\n * Copyright 2024 Google LLC\n * Licensed under the Apache License, Version 2.0\n */\nimport React from "react"\nexport function Button() {}'
const s3 = subjectText(code)
check('code: its license header left out', !/Copyright|Google|Apache/.test(s3) && /Button/.test(s3), JSON.stringify(s3))
const java = 'package shapes;\npublic abstract class Shape {\n  abstract double area();\n}'
check('a lowercase "abstract" (Java) isn’t an abstract heading: the text is kept from its start', subjectText(java).startsWith('package shapes'))
const zh = '区块链共识协议的公平排序 王伟, 张明, 李翔 清华大学 摘要:区块链验证者可以重排交易获利,本文为区块链共识协议加入公平排序。'
const s4 = subjectText(zh, '区块链共识协议的公平排序')
check('a Chinese paper: title and 摘要 on, no authors or institution', s4.startsWith('区块链共识协议的公平排序') && !/王伟|张明|李翔|清华/.test(s4) && /验证者/.test(s4), JSON.stringify(s4))
check('no text: the title alone, or nothing', subjectText(undefined, 'Title') === 'Title' && subjectText(undefined) === undefined)

console.log(failed ? `${failed} FAILED` : 'SUBJECT TEST PASSED ✓')
process.exitCode = failed ? 1 : 0
