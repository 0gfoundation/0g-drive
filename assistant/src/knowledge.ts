// The assistant's knowledge: a bundle built by scripts/build-knowledge.mjs
// (0GDrive guide/docs/source, docs.0g.ai, the 0G TS SDK, file lists of the
// other 0G storage repos at pinned commits), searched with BM25 over chunks.
// Keyword search is enough here: the model writes the queries, and it
// rephrases and retries when the first search misses.

export interface Doc {
  /** id: 0gdrive:<path> | docs:<path>.md | github:<owner>/<repo>/<path> */
  p: string
  t: string
  u: string | null
  x: string
}
export interface Repo {
  repo: string
  commit: string
  files: string[]
  indexed?: boolean
}
interface Bundle {
  builtAt: string
  docs: Doc[]
  repos: Repo[]
}
interface Chunk {
  doc: Doc
  /** 1-based, inclusive */
  start: number
  end: number
  tf: Map<string, number>
  len: number
}

export type Scope = 'all' | 'guide' | '0gdrive' | '0g-docs' | 'code'

let bundle: Promise<Bundle> | null = null
let loaded: Bundle | null = null
let index: { chunks: Chunk[]; df: Map<string, number>; avgLen: number } | null = null

export function loadKnowledge(): Promise<Bundle> {
  bundle ??= fetch('/knowledge.json').then((r) => {
    if (!r.ok) throw new Error(`knowledge bundle: HTTP ${r.status}`)
    return r.json() as Promise<Bundle>
  }).then((b) => (loaded = b))
  bundle.catch(() => (bundle = null))
  return bundle
}

const STOP = new Set(
  'the a an and or of to in on for is are be it this that with as by at from how what why when do does can i my you your me we our not no use using into about which'.split(' ')
)

/** words, camelCase parts and whole identifiers; CJK as character bigrams */
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const raw of text.match(/[A-Za-z0-9_]+|[぀-ヿ㐀-鿿가-힯]+/g) ?? []) {
    if (/^[A-Za-z0-9_]+$/.test(raw)) {
      const whole = raw.toLowerCase()
      const parts = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase().split(' ')
      for (const w of parts) if (w.length > 1 && !STOP.has(w)) out.push(w)
      if (parts.length > 1 && whole.length > 2) out.push(whole)
    } else if (raw.length === 1) {
      out.push(raw)
    } else {
      for (let i = 0; i + 1 < raw.length; i++) out.push(raw.slice(i, i + 2))
    }
  }
  return out
}

const isMarkdown = (d: Doc) => d.p.endsWith('.md')

/** markdown: sections (split at headings, ≤60 lines); code: 50-line windows overlapping by 10 */
function chunkDoc(doc: Doc): Chunk[] {
  const lines = doc.x.split('\n')
  const spans: [number, number][] = []
  if (isMarkdown(doc)) {
    let s = 0
    for (let i = 1; i <= lines.length; i++) {
      const heading = i < lines.length && /^#{1,4} /.test(lines[i])
      if (i === lines.length || (heading && i - s >= 6) || i - s >= 60) {
        spans.push([s, i])
        s = i
      }
    }
  } else {
    for (let s = 0; s < lines.length; s += 40) spans.push([s, Math.min(lines.length, s + 50)])
  }
  const titleTerms = tokenize(`${doc.t} ${doc.p}`)
  return spans.map(([s, e]) => {
    const tf = new Map<string, number>()
    const terms = tokenize(lines.slice(s, e).join('\n'))
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1)
    // the title and path count as part of every chunk of the document
    for (const t of titleTerms) tf.set(t, (tf.get(t) ?? 0) + 2)
    return { doc, start: s + 1, end: e, tf, len: terms.length + titleTerms.length * 2 }
  })
}

async function getIndex() {
  if (index) return index
  const { docs } = await loadKnowledge()
  const chunks = docs.flatMap(chunkDoc)
  const df = new Map<string, number>()
  for (const c of chunks) for (const t of c.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  const avgLen = chunks.reduce((n, c) => n + c.len, 0) / chunks.length
  index = { chunks, df, avgLen }
  return index
}

function inScope(doc: Doc, scope: Scope): boolean {
  switch (scope) {
    case 'guide':
      return doc.p === '0gdrive:docs/user-guide.md'
    case '0gdrive':
      return doc.p.startsWith('0gdrive:')
    case '0g-docs':
      return doc.p.startsWith('docs:')
    case 'code':
      return (doc.p.startsWith('0gdrive:') || doc.p.startsWith('github:')) && !isMarkdown(doc)
    default:
      return true
  }
}

/** user-facing explanations first: the guide outranks design notes, which outrank code */
function boost(doc: Doc): number {
  if (doc.p === '0gdrive:docs/user-guide.md') return 1.5
  if (isMarkdown(doc)) return 1.1
  return 1
}

export interface Hit {
  path: string
  title: string
  lines: string
  text: string
}

export async function search(query: string, scope: Scope = 'all', limit = 5): Promise<Hit[]> {
  const { chunks, df, avgLen } = await getIndex()
  const terms = [...new Set(tokenize(query))]
  if (!terms.length) return []
  const N = chunks.length
  const k1 = 1.2
  const b = 0.75
  const scored: { c: Chunk; score: number }[] = []
  for (const c of chunks) {
    if (!inScope(c.doc, scope)) continue
    let score = 0
    for (const t of terms) {
      const f = c.tf.get(t)
      if (!f) continue
      const idf = Math.log(1 + (N - df.get(t)! + 0.5) / (df.get(t)! + 0.5))
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * c.len) / avgLen))
    }
    if (score > 0) scored.push({ c, score: score * boost(c.doc) })
  }
  scored.sort((a, b) => b.score - a.score)
  const hits: Hit[] = []
  const perDoc = new Map<string, number>()
  for (const { c } of scored) {
    const n = perDoc.get(c.doc.p) ?? 0
    if (n >= 2) continue
    perDoc.set(c.doc.p, n + 1)
    const text = c.doc.x.split('\n').slice(c.start - 1, c.end).join('\n')
    hits.push({
      path: c.doc.p,
      title: c.doc.t,
      lines: `${c.start}-${c.end}`,
      text: text.length > 1000 ? text.slice(0, 1000) + '\n…' : text,
    })
    if (hits.length >= limit) break
  }
  return hits
}

const fetched = new Map<string, Promise<string>>()

/** a document's full text: from the bundle, or fetched from GitHub at the pinned commit */
export async function readText(path: string): Promise<{ text: string; url: string | null }> {
  const { docs, repos } = await loadKnowledge()
  const doc = docs.find((d) => d.p === path)
  if (doc) return { text: doc.x, url: doc.u }
  const m = /^github:([^/]+\/[^/]+)\/(.+)$/.exec(path)
  const repo = m && repos.find((r) => r.repo === m[1])
  if (!m || !repo || !repo.files.includes(m[2])) throw new Error(`Unknown path: ${path}. Use find_files or search_knowledge to get exact paths.`)
  const raw = `https://raw.githubusercontent.com/${repo.repo}/${repo.commit}/${m[2]}`
  if (!fetched.has(raw)) {
    const p = fetch(raw).then((r) => {
      if (!r.ok) throw new Error(`GitHub: HTTP ${r.status} for ${path}`)
      return r.text()
    })
    p.catch(() => fetched.delete(raw))
    fetched.set(raw, p)
  }
  return { text: await fetched.get(raw)!, url: `https://github.com/${repo.repo}/blob/${repo.commit}/${m[2]}` }
}

/** paths (bundle documents and repo file lists) containing every word of the query */
export async function findFiles(query: string, limit = 40): Promise<{ matches: string[]; total: number }> {
  const { docs, repos } = await loadKnowledge()
  const words = query.toLowerCase().split(/[\s/]+/).filter(Boolean)
  const all = [
    ...docs.map((d) => d.p),
    ...repos.filter((r) => !r.indexed).flatMap((r) => r.files.map((f) => `github:${r.repo}/${f}`)),
  ]
  const matches = all.filter((p) => words.every((w) => p.toLowerCase().includes(w)))
  return { matches: matches.slice(0, limit), total: matches.length }
}

/** a link a person can open for a cited path (0GDrive's own files have none) */
export function publicUrl(path: string): string | null {
  if (path.startsWith('docs:')) return `https://docs.0g.ai/${path.slice(5).replace(/\.md$/, '')}`
  const m = /^github:([^/]+\/[^/]+)\/(.+)$/.exec(path)
  const repo = m && loaded?.repos.find((r) => r.repo === m[1])
  return repo ? `https://github.com/${repo.repo}/blob/${repo.commit}/${m![2]}` : null
}
