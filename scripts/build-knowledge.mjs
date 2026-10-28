// Builds the assistant's knowledge bundle: assistant/public/knowledge.json.
//
//   node scripts/build-knowledge.mjs [--if-missing]
//
// Contents (all pinned at build time, so answers cite stable text):
//   0gdrive:<path>   the user guide, design docs and source of this repo
//   docs:<path>      every page of docs.0g.ai (from llms-full.txt)
//   github:<repo>/<path>
//                    full text of the 0G TypeScript storage SDK (local clone
//                    in reference/), plus file LISTS of the other 0G storage
//                    repos at a fixed commit — the assistant fetches those
//                    files on demand from raw.githubusercontent.com
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve, dirname, relative, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(root, 'assistant/public/knowledge.json')
if (process.argv.includes('--if-missing') && existsSync(out)) process.exit(0)

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

// ── 0GDrive: guide, docs, source ──
const localDocs = ['docs/user-guide.md', 'README.md', 'docs/decisions.md', 'docs/0g-storage-api-study.md']
for (const f of localDocs) {
  const text = readFileSync(resolve(root, f), 'utf8')
  add(`0gdrive:${f}`, /^# (.+)$/m.exec(text)?.[1] ?? f, text)
}
for (const dir of ['core/src', 'web/src']) {
  for (const full of walk(resolve(root, dir), (n) => /\.(ts|tsx)$/.test(n) && !n.endsWith('.d.ts'))) {
    const p = relative(root, full)
    add(`0gdrive:${p}`, p, readFileSync(full, 'utf8'))
  }
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

// ── 0G TypeScript storage SDK: full text from the local clone ──
const sdkDir = resolve(root, 'reference/0g-storage-ts-sdk')
const sdkCommit = execFileSync('git', ['-C', sdkDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const sdkRepo = '0gfoundation/0g-storage-ts-sdk'
const sdkFiles = [resolve(sdkDir, 'README.md'), ...walk(resolve(sdkDir, 'src.ts'), (n) => n.endsWith('.ts'))]
for (const f of sdkFiles) {
  const p = relative(sdkDir, f)
  add(`github:${sdkRepo}/${p}`, `${sdkRepo}/${p}`, readFileSync(f, 'utf8'), `https://github.com/${sdkRepo}/blob/${sdkCommit}/${p}`)
}

// ── other 0G storage repos: file lists at a pinned commit ──
const CODE = /\.(go|rs|sol|ts|js|md|toml|proto|py)$/
const SKIP = /(^|\/)(node_modules|vendor|third_party|\.github|deployments|artifacts|typechain-types|tests?\/data)\//
const gh = async (url) => {
  const r = await fetch(`https://api.github.com/${url}`, { headers: { accept: 'application/vnd.github+json' } })
  if (!r.ok) throw new Error(`GitHub ${url}: ${r.status}`)
  return r.json()
}
const repos = [{ repo: sdkRepo, commit: sdkCommit, files: sdkFiles.map((f) => relative(sdkDir, f)), indexed: true }]
for (const repo of ['0gfoundation/0g-storage-client', '0gfoundation/0g-storage-node', '0gfoundation/0g-storage-kv', '0gfoundation/0g-storage-contracts']) {
  const { default_branch } = await gh(`repos/${repo}`)
  const { sha } = await gh(`repos/${repo}/commits/${default_branch}`)
  const tree = await gh(`repos/${repo}/git/trees/${sha}?recursive=1`)
  const files = tree.tree.filter((e) => e.type === 'blob' && CODE.test(e.path) && !SKIP.test(e.path)).map((e) => e.path)
  repos.push({ repo, commit: sha, files })
}

mkdirSync(dirname(out), { recursive: true })
const bundle = { builtAt: new Date().toISOString(), docs, repos }
writeFileSync(out, JSON.stringify(bundle))
const kb = (n) => `${(n / 1024).toFixed(0)} KB`
console.log(`knowledge.json: ${docs.length} documents (${docPages} docs.0g.ai pages), ${kb(JSON.stringify(bundle).length)}`)
for (const r of repos) console.log(`  ${r.repo}@${r.commit.slice(0, 7)}: ${r.files.length} files${r.indexed ? ' (full text)' : ''}`)
