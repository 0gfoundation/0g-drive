// Categories found in the files themselves (D37), for the user to keep:
// files whose text embeddings are close are grouped (average linkage on
// cosine), and each group is named by its most distinctive words (c-TF-IDF
// over names and excerpts), the ones closest in meaning to the group. On a
// research-paper drive the small multilingual model separates subjects
// (blockchain, LLM agents, vision) but not sub-areas, and names are rough:
// the user edits a name before keeping it. Pure: vectors come from the
// caller. Nothing here is stored.

import type { SearchEntry } from '@0gdrive/core'
import { dequantize, likenessShift } from './searchcore'
import { cleanText } from './subject'

export { cleanText }

/** Tuned on a sample of papers and everyday files (scripts/test-discover.mjs). */
export const DISCOVER = {
  /**
   * groups merge while their files are, on average, at least this similar
   * (0.35 for embeddings of openings as read, v1; 0.33 for embeddings of
   * what files are about, v2 (D41): less in common between papers now that
   * "Abstract:" and the authors are out); a file still v1 is held to 0.35
   * by likenessShift (D42)
   */
  link: 0.33,
  /** a group needs this many files */
  minFiles: 3,
  /** skip a group that is nearly a category already: shared files / files in either, at least this */
  overlap: 0.6,
  /** the files grouped at most (newest first): the grouping is quadratic */
  maxFiles: 800,
  /** name candidates weighed for meaning */
  candidates: 12,
  /** a name word is in at least this share of the group's files (and 2) */
  nameShare: 0.4,
  /** and its meaning at least this close to the group's centre (subjects ≥ 0.39 on the test samples; noise up to 0.35) */
  nameFit: 0.36,
  /**
   * a name word that reads like a person's name is dropped: its average
   * likeness to the 3 closest of PEOPLE at least this, or more than its
   * likeness to the group (names from real author lists: pinyin ≥ 0.52,
   * others 0.36–0.65; subject words ≤ 0.41, institutions ≤ 0.49)
   */
  personLike: 0.5,
}

/**
 * Names in many languages and orders, embedded once: what a person's name
 * reads like to the model. An author list in a PDF's text has no commas to
 * go by ("Timo Schick Jane Dwivedi-Yu Roberto Dessì † …"), and a group of
 * papers by the same people has their names in its meaning too, so the
 * model is asked instead: is this word more a person than the subject?
 */
export const PEOPLE = [
  'John Smith', 'Maria Garcia', 'Wei Chen', 'Zhang Wei', 'Ahmed Khan', 'Anna Müller', 'Hiroshi Tanaka', 'Priya Sharma',
  'Olga Ivanova', 'Kim Min-jun', 'Li Na', 'David Johnson', 'Liu Yang', 'Fatima Ali', 'Pierre Dubois', 'Nguyen Van An',
]

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
export const groupable = (f: DiscoverFile) => !!f.search?.e && !!f.search.t && !f.search.c

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
  const shift = files.map((f) => likenessShift(f.search!))

  // average linkage, by Lance–Williams: merging A and B, s(A∪B, C) = (|A| s(A,C) + |B| s(B,C)) / (|A| + |B|)
  const sim: Float32Array[] = vecs.map((a, i) => Float32Array.from(vecs, (b, j) => dot(a, b) - shift[i] - shift[j]))
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
//
// A file's opening is often not about its subject: a paper's author list
// and affiliations, a letter's greeting and signature, a code file's
// license header, an invoice's IDs and dates. Its words are distinctive (a
// group of papers by the same people shares the names), so they'd win on
// distinctiveness alone. Three rules, the same for every kind of file:
// noise is cleaned out of the text first (emails, URLs, words with digits,
// lists of personal names, greetings and signatures, affiliation,
// boilerplate and code words); a name word must be in a good share of the
// group's files (a co-author is in some, the subject in most); and it must
// mean something close to what the group is about (its embedding near the
// group's centre). When nothing passes, no name is made up: the user names it.

const STOP = new Set(
  (
    // English function words, and words every paper or document has
    'a an the of for and or to in on with by from at as is are be we our this that these those it its into via than over under ' +
    'using use used based new novel paper abstract propose proposes proposed present presents show shows study studies results ' +
    'method methods approach approaches evaluate evaluation analysis analyze work task tasks across between without within while ' +
    'such how what which can only more most less high low large small two three first one per us also not no all each other ' +
    'their they them then there here had has have was were will would should could may might do does did make made get find ' +
    'found report reports describe describes design designs compare compares final draft copy notes note file files document ' +
    'pdf txt md doc docx page pages version arxiv preprint introduction et al ' +
    // affiliations, venues
    'university universities institute institution department dept school college lab labs laboratory laboratories inc ltd llc ' +
    'corp corporation company gmbh academy faculty proceedings conference symposium workshop journal vol volume issue pp ' +
    'submitted accepted camera ready ' +
    // letters, emails, meetings, dates
    'dear hello regards sincerely thanks thank cheers best wishes subject sent received forwarded wrote reply attached ' +
    'attendees attendee agenda minutes monday tuesday wednesday thursday friday saturday sunday january february march april ' +
    'may june july august september october november december today tomorrow yesterday ' +
    // boilerplate
    'copyright rights reserved licensed license licence apache mit gpl permission permissions conditions warranty warranties ' +
    'confidential proprietary software distributed ' +
    // code
    'import export const let var function return def class public private protected static void include package module ' +
    'require async await self true false null none undefined'
  ).split(' ')
)

/** A file's words and word pairs; Chinese runs as their 2- to 4-character pieces. */
function termsOf(f: DiscoverFile): Set<string> {
  const stem = f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ')
  // the text the embedding was made from (D41), else the opening as read
  const text = cleanText(`${stem}. ${f.search?.s ?? f.search?.t ?? ''}`)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
  const words: string[] = []
  const han: string[] = []
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (/\p{Script=Han}/u.test(w)) {
      for (const run of w.match(/\p{Script=Han}+/gu) ?? [])
        for (let n = 2; n <= 4; n++) for (let i = 0; i + n <= run.length; i++) han.push(run.slice(i, i + n))
    } else if (w.length > 2 && !STOP.has(w) && !/\d/.test(w) && !/^-|-$/.test(w)) words.push(w)
  }
  const pairs = words.slice(1).map((w, i) => `${words[i]} ${w}`)
  return new Set([...words, ...pairs, ...han])
}

/** A group's terms in a good share of its files and rare elsewhere, best first. */
function candidates(group: number[], terms: Set<string>[], df: Map<string, number>, n: number): string[] {
  const tf = new Map<string, number>()
  for (const i of group) for (const t of terms[i]) tf.set(t, (tf.get(t) ?? 0) + 1)
  const need = Math.max(2, Math.ceil(group.length * DISCOVER.nameShare))
  return [...tf]
    .filter(([, k]) => k >= need)
    .map(([t, k]) => ({ t, s: (k / group.length) * Math.log(n / df.get(t)!) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, DISCOVER.candidates)
    .map((x) => x.t)
}

/**
 * A name from the candidates: the two closest in meaning to the group's
 * centre (`vecs`: the candidates' embeddings, same order), each close
 * enough (DISCOVER.nameFit), neither part of the other; first letter
 * capitalized ("Agents · language models"). '' when none is: the user
 * names the group.
 */
export function nameFrom(found: Found, vecs: ArrayLike<number>[], people: ArrayLike<number>[] = []): string {
  const ranked = candidateFits(found, vecs, people)
    .filter((x) => x.fit >= DISCOVER.nameFit && x.person < DISCOVER.personLike && x.person <= x.fit)
  const picked: string[] = []
  for (const { t } of ranked) {
    if (picked.some((p) => p.includes(t) || t.includes(p))) continue
    picked.push(t)
    if (picked.length === 2) break
  }
  const name = picked.join(' · ')
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/**
 * Each candidate's closeness to the group's centre (`fit`) and how much it
 * reads like a person's name (`person`: its average likeness to the 3
 * closest of PEOPLE's vectors, `people`), best fit first.
 */
export function candidateFits(found: Found, vecs: ArrayLike<number>[], people: ArrayLike<number>[] = []): { t: string; fit: number; person: number }[] {
  const pv = people.map(unit)
  return found.candidates
    .map((t, i) => {
      if (!vecs[i]) return { t, fit: -1, person: 1 }
      const v = unit(vecs[i])
      const sims = pv.map((p) => dot(v, p)).sort((a, b) => b - a)
      const person = sims.length ? sims.slice(0, 3).reduce((a, b) => a + b, 0) / Math.min(3, sims.length) : 0
      return { t, fit: dot(found.centre, v), person }
    })
    .sort((a, b) => b.fit - a.fit)
}
