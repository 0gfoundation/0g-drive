// Categories found in the files themselves (D37), for the user to keep:
// files whose text embeddings are close are grouped (average linkage on
// cosine), and each group is named by its most distinctive words (c-TF-IDF
// over names and excerpts), the ones closest in meaning to the group. On a
// research-paper drive the small multilingual model separates subjects
// (blockchain, LLM agents, vision) but not sub-areas, and names are rough:
// the user edits a name before keeping it. Pure: vectors come from the
// caller. Nothing here is stored.

import type { SearchEntry } from '@0gdrive/core'
import { dequantize } from './searchcore'

/** Tuned on a sample of papers and everyday files (scripts/test-discover.mjs). */
export const DISCOVER = {
  /** groups merge while their files are, on average, at least this similar */
  link: 0.35,
  /** a group needs this many files */
  minFiles: 3,
  /** skip a group that is nearly a category already: shared files / files in either, at least this */
  overlap: 0.6,
  /** the files grouped at most (newest first): the grouping is quadratic */
  maxFiles: 800,
  /** name candidates weighed for meaning */
  candidates: 12,
}

export interface DiscoverFile {
  id: string
  name: string
  uploadedAt?: number
  search?: SearchEntry
}

export interface Found {
  /** stable for the same files: their ids, sorted */
  key: string
  fileIds: string[]
  /** words to name it by, best first (see nameFrom) */
  candidates: string[]
  /** the group's centre (normalized), to weigh the candidates' meaning */
  centre: Float32Array
}

// ─── Grouping ─────────────────────────────────────────────────────────

const unit = (v: ArrayLike<number>): Float32Array => {
  const out = Float32Array.from(v)
  let n = 0
  for (const x of out) n += x * x
  n = Math.sqrt(n) || 1
  for (let i = 0; i < out.length; i++) out[i] /= n
  return out
}
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** Text files with their own text read (not photos, not known by name alone). */
const groupable = (f: DiscoverFile) => !!f.search?.e && !!f.search.t && !f.search.c

/**
 * Groups of files close in meaning. `inCategory(id)`: the categories a file
 * is in already (own and topics), `sizeOf(category)`: its files. A group
 * that is nearly one of them is left out; one inside a broad one (blockchain
 * papers among Research papers) is still suggested.
 */
export function discover(all: DiscoverFile[], inCategory: (id: string) => string[], sizeOf: (category: string) => number): Found[] {
  const files = all
    .filter(groupable)
    .sort((a, b) => (b.uploadedAt ?? 0) - (a.uploadedAt ?? 0))
    .slice(0, DISCOVER.maxFiles)
  const n = files.length
  if (n < DISCOVER.minFiles) return []
  const vecs = files.map((f) => unit(dequantize(f.search!.e!)))

  // average linkage, by Lance–Williams: merging A and B, s(A∪B, C) = (|A| s(A,C) + |B| s(B,C)) / (|A| + |B|)
  const sim: Float32Array[] = vecs.map((a) => Float32Array.from(vecs, (b) => dot(a, b)))
  const members: (number[] | null)[] = files.map((_, i) => [i])
  for (;;) {
    let best = -Infinity
    let bi = -1
    let bj = -1
    for (let i = 0; i < n; i++) {
      if (!members[i]) continue
      for (let j = i + 1; j < n; j++) {
        if (members[j] && sim[i][j] > best) {
          best = sim[i][j]
          bi = i
          bj = j
        }
      }
    }
    if (bi < 0 || best < DISCOVER.link) break
    const a = members[bi]!.length
    const b = members[bj]!.length
    for (let k = 0; k < n; k++) {
      if (!members[k] || k === bi || k === bj) continue
      const s = (a * sim[bi][k] + b * sim[bj][k]) / (a + b)
      sim[bi][k] = s
      sim[k][bi] = s
    }
    members[bi] = [...members[bi]!, ...members[bj]!]
    members[bj] = null
  }

  const terms = files.map(termsOf)
  const df = new Map<string, number>()
  for (const ts of terms) for (const t of ts) df.set(t, (df.get(t) ?? 0) + 1)

  const out: Found[] = []
  for (const group of members) {
    if (!group || group.length < DISCOVER.minFiles) continue
    const ids = group.map((i) => files[i].id)
    // nearly a category already: nothing new to suggest
    const counts = new Map<string, number>()
    for (const id of ids) for (const c of inCategory(id)) counts.set(c, (counts.get(c) ?? 0) + 1)
    if ([...counts].some(([c, k]) => k / (ids.length + sizeOf(c) - k) >= DISCOVER.overlap)) continue
    const centre = new Float32Array(vecs[0].length)
    for (const i of group) vecs[i].forEach((x, k) => (centre[k] += x))
    out.push({ key: [...ids].sort().join(','), fileIds: ids, candidates: candidates(group, terms, df, n), centre: unit(centre) })
  }
  return out.sort((a, b) => b.fileIds.length - a.fileIds.length)
}

// ─── Names ────────────────────────────────────────────────────────────

const STOP = new Set(
  (
    'a an the of for and or to in on with by from at as is are be we our this that these those it its into via than over under ' +
    'using use used based new novel paper abstract propose proposes proposed present presents show shows study studies results ' +
    'method methods approach approaches evaluate evaluation analysis analyze work task tasks across between without within while ' +
    'such how what which can only more most less high low large small two three first one per us also not no all each other ' +
    'their they them then there here had has have was were will would should could may might do does did make made get find ' +
    'found report reports describe describes design designs compare compares final draft copy notes note file files document ' +
    'pdf txt md doc docx page pages version v1 v2 arxiv preprint university introduction'
  ).split(' ')
)

/** A file's words and word pairs (Chinese: its 2-character pieces, alone). */
function termsOf(f: DiscoverFile): Set<string> {
  const text = `${f.name} ${f.search?.t ?? ''}`
    .toLowerCase()
    .replace(/\.(pdf|txt|md|docx?|html?)\b/g, ' ')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
  const words: string[] = []
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (/\p{Script=Han}/u.test(w)) for (let i = 0; i + 2 <= w.length; i++) words.push(w.slice(i, i + 2))
    else if (w.length > 2 && !STOP.has(w) && !/^[\d.%x-]+$/.test(w)) words.push(w)
  }
  const pairs = words.slice(1).map((w, i) => `${words[i]} ${w}`).filter((p) => !/\p{Script=Han}/u.test(p))
  return new Set([...words, ...pairs])
}

/** A group's most distinctive terms (in it often, elsewhere rarely), best first. */
function candidates(group: number[], terms: Set<string>[], df: Map<string, number>, n: number): string[] {
  const tf = new Map<string, number>()
  for (const i of group) for (const t of terms[i]) tf.set(t, (tf.get(t) ?? 0) + 1)
  return [...tf]
    .filter(([t, k]) => k >= 2 && !/\p{Script=Han}/u.test(t))
    .map(([t, k]) => ({ t, s: (k / group.length) * Math.log(n / df.get(t)!) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, DISCOVER.candidates)
    .map((x) => x.t)
}

/**
 * A name from the candidates: the two closest in meaning to the group's
 * centre (`vecs`: the candidates' embeddings, same order), neither part of
 * the other; first letter capitalized ("Model agents · llm agents").
 */
export function nameFrom(found: Found, vecs: ArrayLike<number>[]): string {
  const ranked = found.candidates
    .map((t, i) => ({ t, fit: vecs[i] ? dot(found.centre, unit(vecs[i])) : -1 }))
    .sort((a, b) => b.fit - a.fit)
  const picked: string[] = []
  for (const { t } of ranked) {
    if (picked.some((p) => p.includes(t) || t.includes(p))) continue
    picked.push(t)
    if (picked.length === 2) break
  }
  const name = picked.join(' · ') || 'Untitled'
  return name.charAt(0).toUpperCase() + name.slice(1)
}
