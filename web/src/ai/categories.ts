// Files grouped by category, computed on this device from what the drive
// already holds: a file's type from its name and MIME type; its topic from
// its search entry (the text embedding, or a photo's tags); the user's own
// categories by their name's embedding; and files put in or taken out of a
// category by hand (DriveCategories, stored in the drive). Nothing here is
// stored. No DOM, no model code: the vectors come in from the caller.

import type { DriveCategories, SearchEntry } from '@0gdrive/core'
import { cosineQ, dequantize, likenessOf, likenessShift } from './searchcore'

export type CategoryKind = 'type' | 'topic' | 'own'

export interface Category {
  id: string
  name: string
  kind: CategoryKind
}

// ─── Types ────────────────────────────────────────────────────────────

const ext = (name: string) => name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
const exts = (list: string) => new Set(list.split(' '))

const DOCS = exts('doc docx odt rtf txt md markdown pages tex epub')
const SHEETS = exts('xls xlsx ods csv tsv numbers')
const SLIDES = exts('ppt pptx odp key')
const CODE = exts('js mjs cjs ts tsx jsx py go rs java kt swift c h cc cpp hpp cs rb php sh bash zsh sql sol json yaml yml toml xml html htm css scss vue svelte ipynb lua r m dart')
const ARCHIVES = exts('zip rar 7z tar gz tgz bz2 xz zst dmg iso')

export const TYPES: (Category & { test: (name: string, mime: string) => boolean })[] = [
  { id: 'type:photos', name: 'Photos', kind: 'type', test: (_, m) => m.startsWith('image/') },
  { id: 'type:videos', name: 'Videos', kind: 'type', test: (_, m) => m.startsWith('video/') },
  { id: 'type:audio', name: 'Audio', kind: 'type', test: (_, m) => m.startsWith('audio/') },
  { id: 'type:pdfs', name: 'PDFs', kind: 'type', test: (n, m) => m === 'application/pdf' || ext(n) === 'pdf' },
  { id: 'type:docs', name: 'Documents', kind: 'type', test: (n) => DOCS.has(ext(n)) },
  { id: 'type:sheets', name: 'Spreadsheets', kind: 'type', test: (n) => SHEETS.has(ext(n)) },
  { id: 'type:slides', name: 'Presentations', kind: 'type', test: (n) => SLIDES.has(ext(n)) },
  { id: 'type:code', name: 'Code', kind: 'type', test: (n) => CODE.has(ext(n)) },
  { id: 'type:archives', name: 'Archives', kind: 'type', test: (n) => ARCHIVES.has(ext(n)) },
]

/** A file's type category (the first that fits), if any. */
export function typeOf(name: string, mime: string): string | null {
  return TYPES.find((t) => t.test(name, mime))?.id ?? null
}

// ─── Topics ───────────────────────────────────────────────────────────
//
// Each topic is found by phrases (embedded once, multilingual: a Chinese
// file reaches an English phrase) and/or by photo tags (searchcore.ts
// PHOTO_LABELS). Photos go by their tags only: their text embedding is
// mostly those tags already.

export const TOPICS: (Category & { phrases: string[]; tags: string[] })[] = [
  {
    id: 'topic:finance', name: 'Finance', kind: 'topic',
    phrases: ['invoice', 'receipt for a payment', 'bank account statement', 'tax return', 'utility bill amount due', 'budget and expenses', 'salary payslip'],
    tags: ['receipt', 'invoice'],
  },
  {
    id: 'topic:work', name: 'Work', kind: 'topic',
    phrases: ['meeting notes and action items', 'project plan and milestones', 'business report', 'presentation for the team', 'proposal for a client', 'quarterly business review'],
    tags: ['whiteboard'],
  },
  {
    id: 'topic:research', name: 'Research papers', kind: 'topic',
    phrases: [
      'research paper', 'academic paper abstract and introduction', 'scientific study with experiments and results',
      'we propose a new method and evaluate it on benchmarks', 'technical whitepaper', 'literature review',
    ],
    tags: [],
  },
  {
    id: 'topic:legal', name: 'Contracts & legal', kind: 'topic',
    phrases: ['contract agreement between parties', 'lease agreement', 'terms and conditions', 'legal document', 'non-disclosure agreement'],
    tags: [],
  },
  {
    id: 'topic:travel', name: 'Travel', kind: 'topic',
    phrases: ['travel itinerary', 'flight booking confirmation', 'hotel reservation', 'boarding pass', 'visa application', 'vacation trip plan'],
    tags: ['airplane'],
  },
  {
    id: 'topic:health', name: 'Health', kind: 'topic',
    phrases: ['medical report', 'doctor prescription', 'health insurance claim', 'blood test results', 'hospital appointment', 'vaccination record'],
    tags: [],
  },
  {
    id: 'topic:study', name: 'Study', kind: 'topic',
    phrases: ['lecture notes', 'homework assignment', 'exam preparation', 'course syllabus', 'textbook chapter exercises'],
    tags: ['handwriting'],
  },
  {
    id: 'topic:recipes', name: 'Recipes', kind: 'topic',
    phrases: ['recipe with ingredients', 'cooking instructions', 'baking recipe'],
    tags: [],
  },
  { id: 'topic:screenshots', name: 'Screenshots', kind: 'topic', phrases: [], tags: ['screenshot', 'meme'] },
  {
    id: 'topic:people', name: 'People', kind: 'topic', phrases: [],
    tags: ['person', 'selfie', 'group of people', 'baby', 'child', 'wedding', 'party', 'concert', 'sports'],
  },
  { id: 'topic:pets', name: 'Pets & animals', kind: 'topic', phrases: [], tags: ['dog', 'cat', 'bird', 'animal', 'wildlife'] },
  { id: 'topic:food', name: 'Food', kind: 'topic', phrases: [], tags: ['food', 'drink', 'restaurant'] },
  {
    id: 'topic:places', name: 'Nature & places', kind: 'topic', phrases: [],
    tags: ['beach', 'ocean', 'mountain', 'forest', 'flowers', 'garden', 'nature', 'sunset', 'snow', 'sky', 'city', 'street', 'building', 'architecture'],
  },
]

/** Every topic phrase, in order: what the caller embeds (once) for `TopicVecs`. */
export const topicPhrases = () => TOPICS.flatMap((t) => t.phrases)

/** Topic phrase vectors, as embedded from `topicPhrases()` (same order). */
export type TopicVecs = ArrayLike<number>[]

/**
 * Tuned for precision over recall (scripts/test-categories.mjs): a file in
 * the wrong category costs trust; one left out is still in its folder.
 */
export const CATEGORIZE = {
  /** a topic's best phrase must fit at least this well */
  minFit: 0.36,
  /** …and beat the next topic by this much (else it's unsure: no topic) */
  margin: 0.04,
  /** a second topic, if it fits nearly as well as the first */
  secondWithin: 0.02,
  /** a user's own category: its name must fit at least this well */
  ownMinFit: 0.32,
  /**
   * A file known by its name alone (no text read: too big, or none in it):
   * a short name embeds loosely ("notes" fits "lecture notes" at 0.68), so
   * only a clear fit counts.
   */
  nameOnlyMinFit: 0.55,
  nameOnlyMargin: 0.1,
  nameOnlyOwnMinFit: 0.5,
}

/** Tags that say what a photo is a picture of, over what's in it: a receipt from a restaurant is a receipt. */
const DOCUMENT_TAGS = new Set(['receipt', 'invoice', 'document', 'screenshot', 'whiteboard', 'handwriting', 'text', 'chart', 'diagram'])

const nameOnly = (e: SearchEntry) => !e.t && !e.c

/** A file as categorized: what's needed of its record. */
export interface CatFile {
  id: string
  name: string
  mime: string
  uploadedAt?: number
  search?: SearchEntry
}

// ─── Kept categories that grow (D38) ──────────────────────────────────
//
// A category kept from a suggestion is a group of files alike in meaning.
// A new file joins it when most of its nearest files are ones put in it by
// hand, and it's alike enough to them on average. Asking where a file's
// neighbours are, rather than a fixed bar, keeps loosely related files out:
// on a sample of papers, each group kept with one paper held out at a time,
// 24 of 28 rejoined their own group and nothing else joined any (a fixed
// bar letting as many back in let 27 join wrongly). scripts/test-discover.mjs.

export const GROW = {
  /** a file's nearest files looked at */
  k: 3,
  /** of them, at least this many put in the category by hand */
  need: 2,
  /** and its average likeness to those files at least this (likenessOf, D43: on real papers and articles 57 of 68 held out came back; v1 files 0.02 higher) */
  floor: 0.2,
  /** the files compared at most (newest first) */
  maxFiles: 800,
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** Files that join a growing category by resemblance: file id → category ids. */
export function growJoins(files: CatFile[], user: DriveCategories | null | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const ids = new Set(files.map((f) => f.id))
  const growing = (user?.own ?? [])
    .filter((c) => c.grow)
    .map((c) => {
      const pins = (user?.pins ?? []).filter((p) => p.cat === c.id && ids.has(p.file))
      return { id: c.id, put: new Set(pins.filter((p) => p.in).map((p) => p.file)), out: new Set(pins.filter((p) => !p.in).map((p) => p.file)) }
    })
    .filter((c) => c.put.size >= GROW.need)
  if (growing.length === 0) return out
  // text files with their own text read: as Suggest categories groups them
  const pool = files
    .filter((f) => f.search?.e && f.search.t && !f.search.c)
    .sort((a, b) => (b.uploadedAt ?? 0) - (a.uploadedAt ?? 0))
    .slice(0, GROW.maxFiles)
  const vecs = pool.map((f) => likenessOf(f.search!)!)
  const shift = pool.map((f) => likenessShift(f.search!))
  for (let i = 0; i < pool.length; i++) {
    const id = pool[i].id
    const sims = vecs.map((v, j) => (j === i ? -Infinity : dot(vecs[i], v) - shift[i] - shift[j]))
    const nearest = sims
      .map((s, j) => ({ s, j }))
      .sort((a, b) => b.s - a.s)
      .slice(0, GROW.k)
      .map((x) => pool[x.j].id)
    for (const c of growing) {
      if (c.put.has(id) || c.out.has(id)) continue
      if (nearest.filter((n) => c.put.has(n)).length < GROW.need) continue
      let sum = 0
      let n = 0
      pool.forEach((f, j) => {
        if (c.put.has(f.id)) {
          sum += sims[j]
          n++
        }
      })
      if (n > 0 && sum / n >= GROW.floor) out.set(id, [...(out.get(id) ?? []), c.id])
    }
  }
  return out
}

/** A file's topics from its search entry: up to 2, best first. */
export function topicsOf(file: CatFile, vecs: TopicVecs | null): string[] {
  const e = file.search
  if (!e) return []
  if (e.c) {
    // a photo: by its tags, best tag first
    const out: string[] = []
    const tags = e.g ?? []
    const docs = tags.filter((t) => DOCUMENT_TAGS.has(t))
    for (const tag of docs.length ? docs : tags) {
      const t = TOPICS.find((x) => x.tags.includes(tag))
      if (t && !out.includes(t.id)) out.push(t.id)
    }
    return out.slice(0, 2)
  }
  if (!e.e || !vecs) return []
  const v = dequantize(e.e)
  let i = 0
  const fits = TOPICS.map((t) => {
    let best = -1
    for (const _ of t.phrases) best = Math.max(best, cosineQ(vecs[i++], v))
    return { id: t.id, fit: best }
  })
    .filter((f) => f.fit > -1)
    .sort((a, b) => b.fit - a.fit)
  const [first, second, third] = fits
  if (!first) return []
  if (nameOnly(e)) {
    const clear = first.fit >= CATEGORIZE.nameOnlyMinFit && (!second || first.fit - second.fit >= CATEGORIZE.nameOnlyMargin)
    return clear ? [first.id] : []
  }
  if (first.fit < CATEGORIZE.minFit) return []
  if (second && first.fit - second.fit < CATEGORIZE.margin) {
    // two topics nearly tied: both, if they clearly beat the rest
    const both = first.fit - second.fit <= CATEGORIZE.secondWithin && second.fit >= CATEGORIZE.minFit
    return both && (!third || second.fit - third.fit >= CATEGORIZE.margin) ? [first.id, second.id] : []
  }
  return [first.id]
}

/** Whether a file fits one of the user's own categories, by its name's vector. */
export function fitsOwn(file: CatFile, nameVec: ArrayLike<number> | undefined): boolean {
  const e = file.search
  if (!e?.e || !nameVec) return false
  return cosineQ(nameVec, dequantize(e.e)) >= (nameOnly(e) ? CATEGORIZE.nameOnlyOwnMinFit : CATEGORIZE.ownMinFit)
}

/**
 * Why a file is in a category, as shown beside it: put in by the user (a
 * pin, or kept from a suggestion), grown into a kept category by
 * resemblance, fitting the name of the user's category, a topic found in
 * its text, in a photo or from its file name alone, or its type.
 */
export type Reason = 'put' | 'grew' | 'name' | 'text' | 'photo' | 'filename' | 'type'

export interface Grouping {
  /** every category with at least one file (own ones always), in display order */
  categories: (Category & { count: number })[]
  /** file ids by category id */
  files: Map<string, string[]>
  /** category ids by file id */
  of: Map<string, string[]>
  /** why each file is in each of its categories: file id → category id → reason */
  why: Map<string, Map<string, Reason>>
}

/** A topic found for a file: from the photo, from its file name alone, or from its text. */
const topicReason = (e: SearchEntry | undefined): Reason => (e?.c ? 'photo' : e && nameOnly(e) ? 'filename' : 'text')

/**
 * Group `files`: types, topics (when `topicVecs` is given: the text model
 * is ready), the user's own categories (by `ownVecs`, their names'
 * vectors, when given), then pins: a file put in a category by hand is in
 * it, one taken out isn't.
 */
export function groupFiles(
  files: CatFile[],
  user: DriveCategories | null | undefined,
  topicVecs: TopicVecs | null,
  ownVecs: Map<string, ArrayLike<number>> | null
): Grouping {
  const own: Category[] = (user?.own ?? []).map((c) => ({ id: c.id, name: c.name, kind: 'own' }))
  // each file's categories, with why it's in each (the last reason found wins: a pin over the rest)
  const of = new Map<string, Map<string, Reason>>()
  const ids = new Set(files.map((f) => f.id))
  for (const f of files) {
    const cats = new Map<string, Reason>()
    const type = typeOf(f.name, f.mime)
    if (type) cats.set(type, 'type')
    for (const t of topicsOf(f, topicVecs)) cats.set(t, topicReason(f.search))
    for (const c of own) if (fitsOwn(f, ownVecs?.get(c.id))) cats.set(c.id, 'name')
    of.set(f.id, cats)
  }
  // kept categories grow by resemblance (with smart search on: the files have their vectors then)
  if (topicVecs) for (const [id, cs] of growJoins(files, user)) for (const c of cs) of.get(id)!.set(c, 'grew')
  const known = new Set([...TYPES, ...TOPICS, ...own].map((c) => c.id))
  for (const p of user?.pins ?? []) {
    if (!ids.has(p.file) || !known.has(p.cat)) continue
    if (p.in) of.get(p.file)!.set(p.cat, 'put')
    else of.get(p.file)!.delete(p.cat)
  }
  const byCat = new Map<string, string[]>()
  for (const f of files) for (const c of of.get(f.id)!.keys()) byCat.set(c, [...(byCat.get(c) ?? []), f.id])
  const categories = [...own, ...TOPICS, ...TYPES]
    .map((c) => ({ id: c.id, name: c.name, kind: c.kind, count: byCat.get(c.id)?.length ?? 0 }))
    .filter((c) => c.count > 0 || c.kind === 'own')
  return { categories, files: byCat, of: new Map([...of].map(([k, v]) => [k, [...v.keys()]])), why: of }
}

// ─── Edits (idempotent: the same edit twice is the edit once) ─────────

/** `grow`: kept from a suggestion: it grows by resemblance (D38). */
export const addOwn = (id: string, name: string, grow?: boolean) => (c: DriveCategories): DriveCategories =>
  c.own.some((o) => o.id === id) ? c : { ...c, own: [...c.own, grow ? { id, name, grow } : { id, name }] }

export const renameOwn = (id: string, name: string) => (c: DriveCategories): DriveCategories => ({
  ...c,
  own: c.own.map((o) => (o.id === id ? { ...o, name } : o)),
})

export const removeOwn = (id: string) => (c: DriveCategories): DriveCategories => ({
  ...c,
  own: c.own.filter((o) => o.id !== id),
  pins: c.pins.filter((p) => p.cat !== id),
})

/** Files put in (`inCat`) or taken out of a category by hand; `keep`: the drive's file ids (pins of files gone are dropped). */
export const pin = (fileIds: string[], cat: string, inCat: boolean, keep?: Set<string>) => (c: DriveCategories): DriveCategories => {
  const these = new Set(fileIds)
  const others = c.pins.filter((p) => !(p.cat === cat && these.has(p.file)) && (!keep || keep.has(p.file)))
  return { ...c, pins: [...others, ...fileIds.map((file) => ({ file, cat, in: inCat }))] }
}

// ─── A folder in sections ─────────────────────────────────────────────

export interface Section<T> {
  id: string
  name: string
  items: T[]
}

/**
 * `items` (a folder's files) in sections, each file once: under its first
 * own category, else its first topic, else its type, else "Other". In
 * category order (own, topics, types), Other last; files keep their order.
 */
export function sectionsOf<T extends { id: string }>(items: T[], grouping: Grouping): Section<T>[] {
  const order = grouping.categories
  const rank = (kind: CategoryKind) => (kind === 'own' ? 0 : kind === 'topic' ? 1 : 2)
  const sections = new Map<string, Section<T>>()
  const other: Section<T> = { id: 'other', name: 'Other', items: [] }
  for (const item of items) {
    const cats = grouping.of.get(item.id) ?? []
    const first = order
      .filter((c) => cats.includes(c.id))
      .sort((a, b) => rank(a.kind) - rank(b.kind))[0]
    if (!first) {
      other.items.push(item)
      continue
    }
    if (!sections.has(first.id)) sections.set(first.id, { id: first.id, name: first.name, items: [] })
    sections.get(first.id)!.items.push(item)
  }
  const out = order.filter((c) => sections.has(c.id)).map((c) => sections.get(c.id)!)
  return other.items.length ? [...out, other] : out
}
