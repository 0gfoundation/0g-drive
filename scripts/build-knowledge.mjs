// Builds the assistant's knowledge bundle: assistant/public/knowledge.json.
//
//   node scripts/build-knowledge.mjs [--if-missing] [--update]
//
// Contents (pinned, so answers cite stable text):
//   0gdrive:<path>   the user guide, design docs and source of this repo,
//                    linked to GitHub at the commit being built
//   docs:<path>      every page of docs.0g.ai (from llms-full.txt)
//   github:<repo>/<path>
//                    full text of the 0G TypeScript storage SDK, plus file
//                    LISTS of the other 0G storage repos — the assistant
//                    fetches those files on demand from raw.githubusercontent.com
//
// The 0G repos are read at the commits in scripts/knowledge-sources.json,
// from GitHub's tarballs (no API calls, so no rate limit on shared build
// machines). --update moves them to each repo's latest commit first.
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve, dirname, relative, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(root, 'assistant/public/knowledge.json')
if (process.argv.includes('--if-missing') && existsSync(out)) process.exit(0)

const sourcesFile = resolve(root, 'scripts/knowledge-sources.json')
const sources = JSON.parse(readFileSync(sourcesFile, 'utf8'))
if (process.argv.includes('--update')) {
  for (const repo of Object.keys(sources)) {
    sources[repo] = execFileSync('git', ['ls-remote', `https://github.com/${repo}`, 'HEAD'], { encoding: 'utf8' }).split('\t')[0]
  }
  writeFileSync(sourcesFile, JSON.stringify(sources, null, 2) + '\n')
}

// this repo's commit, for links to the exact source the bundle was built from
const DRIVE_REPO = '0gfoundation/0g-drive'
let driveCommit = process.env.VERCEL_GIT_COMMIT_SHA || null
try {
  driveCommit ??= execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
} catch {}

const docs = []
const add = (p, title, text, url = null) => docs.push({ p, t: title, u: url, x: text.replace(/\r\n/g, '\n') })

function walk(dir, keep) {
  const files = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name !== 'node_modules' && name !== 'stubs' && !name.startsWith('.')) files.push(...walk(full, keep))
    } else if (keep(name)) files.push(full)
  }
  return files.sort()
}

// ── 0GDrive: guide, docs, source, deployment config ──
const driveUrl = (p) => (driveCommit ? `https://github.com/${DRIVE_REPO}/blob/${driveCommit}/${p}` : null)
const localDocs = ['docs/user-guide.md', 'README.md', 'docs/decisions.md', 'docs/deploy.md', 'docs/0g-storage-api-study.md']
for (const f of localDocs) {
  const text = readFileSync(resolve(root, f), 'utf8')
  add(`0gdrive:${f}`, /^# (.+)$/m.exec(text)?.[1] ?? f, text, driveUrl(f))
}
for (const dir of ['core/src', 'web/src', 'web/api', 'assistant/src']) {
  for (const full of walk(resolve(root, dir), (n) => /\.(ts|tsx)$/.test(n) && !n.endsWith('.d.ts'))) {
    const p = relative(root, full)
    add(`0gdrive:${p}`, p, readFileSync(full, 'utf8'), driveUrl(p))
  }
}
for (const p of ['web/vercel.json', 'assistant/vercel.json', 'assistant/index.html']) {
  add(`0gdrive:${p}`, p, readFileSync(resolve(root, p), 'utf8'), driveUrl(p))
}

// ── docs.0g.ai, one entry per page ──
const full = await (await fetch('https://docs.0g.ai/llms-full.txt')).text()
const lines = full.split('\n')
const starts = []
lines.forEach((l, i) => {
  if (/^Source: https:\/\/docs\.0g\.ai\/\S+\.md$/.test(l) && /^#{1,2} /.test(lines[i - 2] ?? '')) starts.push(i - 2)
})
starts.forEach((s, k) => {
  const end = k + 1 < starts.length ? starts[k + 1] : lines.length
  const url = lines[s + 2].slice('Source: '.length)
  const path = url.replace('https://docs.0g.ai/', '')
  add(`docs:${path}`, lines[s].replace(/^#+ /, ''), lines.slice(s, end).join('\n').trim(), url.replace(/\.md$/, ''))
})
const docPages = starts.length

// ── 0G repos: tarballs at the pinned commits ──
const CODE = /\.(go|rs|sol|ts|js|md|toml|proto|py)$/
const SKIP = /(^|\/)(node_modules|vendor|third_party|\.github|deployments|artifacts|typechain-types|tests?\/data)\//
const SDK = '0gfoundation/0g-storage-ts-sdk'
const isSdkText = (p) => p === 'README.md' || (p.startsWith('src.ts/') && p.endsWith('.ts'))
const tmp = mkdtempSync(join(tmpdir(), 'knowledge-'))
const repos = []
try {
  for (const [repo, commit] of Object.entries(sources)) {
    const res = await fetch(`https://codeload.github.com/${repo}/tar.gz/${commit}`)
    if (!res.ok) throw new Error(`GitHub tarball ${repo}@${commit}: HTTP ${res.status}`)
    const tgz = join(tmp, `${repo.replace('/', '_')}.tar.gz`)
    writeFileSync(tgz, Buffer.from(await res.arrayBuffer()))
    // entries look like "<repo>-<sha>/path"; drop that first component
    const files = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8', maxBuffer: 64 << 20 })
      .split('\n')
      .map((e) => e.slice(e.indexOf('/') + 1))
      .filter((p) => p && !p.endsWith('/') && CODE.test(p) && !SKIP.test(p))
      .sort()
    if (repo !== SDK) {
      repos.push({ repo, commit, files })
      continue
    }
    const dir = join(tmp, 'sdk')
    mkdirSync(dir)
    execFileSync('tar', ['-xzf', tgz, '-C', dir, '--strip-components=1'])
    const sdkFiles = files.filter(isSdkText)
    for (const p of sdkFiles) {
      add(`github:${repo}/${p}`, `${repo}/${p}`, readFileSync(join(dir, p), 'utf8'), `https://github.com/${repo}/blob/${commit}/${p}`)
    }
    repos.push({ repo, commit, files: sdkFiles, indexed: true })
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

mkdirSync(dirname(out), { recursive: true })
const bundle = { builtAt: new Date().toISOString(), drive: { repo: DRIVE_REPO, commit: driveCommit }, docs, repos }
writeFileSync(out, JSON.stringify(bundle))
const kb = (n) => `${(n / 1024).toFixed(0)} KB`
console.log(`knowledge.json: ${docs.length} documents (${docPages} docs.0g.ai pages), ${kb(JSON.stringify(bundle).length)}; 0GDrive @${driveCommit?.slice(0, 7) ?? 'unknown'}`)
for (const r of repos) console.log(`  ${r.repo}@${r.commit.slice(0, 7)}: ${r.files.length} files${r.indexed ? ' (full text)' : ''}`)
