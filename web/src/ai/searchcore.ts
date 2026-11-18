// Pure search logic shared by the AI worker, the UI and the Node tests:
// vector (de)quantization, photo tag selection, and query scoring.
// No DOM, no model code.

import type { SearchEntry } from '@0gdrive/core'

export type { SearchEntry }

/** 3: a file's whole text read too, as `w` (D43); 2: embeddings made from what a file is about (subject.ts, D41); 1: from its opening as read */
export const SEARCH_ENTRY_VERSION = 3

/** An entry made from a file's text before the whole file was read (v1, v2): indexed again, from the file. Photos and names alone are the same either way. */
export const outdatedSearch = (e: SearchEntry): boolean => (e.v ?? 1) < SEARCH_ENTRY_VERSION && !!e.t && !e.c
/**
 * Two files' text vectors made the old way (v1) are more alike than made
 * from what the files are about, by about this: the authors, notices and
 * "Abstract:" they share (D41: groups link at 0.35 on v1, 0.33 on v2). Taken
 * off their likeness, half for each v1 file, so one bar serves a drive
 * whose entries aren't all indexed again yet (D42).
 */
export const V1_LIKENESS = 0.02
/** What a file's entry takes off its likeness to another file (see V1_LIKENESS). */
export const likenessShift = (e: SearchEntry): number => (outdatedSearch(e) ? V1_LIKENESS / 2 : 0)
/** Characters of extracted text kept in the (encrypted) manifest. */
export const EXCERPT_CHARS = 280
/** Characters of extracted text fed to the text embedder: ~128 tokens, what it was trained on (it takes 512 at most). */
export const EMBED_TEXT_CHARS = 600

// ─── int8 vectors ─────────────────────────────────────────────────────
//
// Embeddings are L2-normalized, so every component is in [-1, 1]; scaling
// by 127 and rounding keeps cosine similarity within ~0.01 of float32 at a
// quarter of the size (384 B for the text model, 512 B for CLIP B/32).

function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

export function quantize(vec: ArrayLike<number>): string {
  const q = new Int8Array(vec.length)
  for (let i = 0; i < vec.length; i++) {
    q[i] = Math.max(-127, Math.min(127, Math.round(vec[i] * 127)))
  }
  return bytesToBase64(new Uint8Array(q.buffer))
}

export function dequantize(b64: string): Int8Array {
  const bytes = base64ToBytes(b64)
  return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** Cosine of a normalized float query against a quantized normalized vector. */
export function cosineQ(query: ArrayLike<number>, q: Int8Array): number {
  if (q.length !== query.length) return 0
  let dot = 0
  let norm = 0
  for (let i = 0; i < q.length; i++) {
    dot += query[i] * q[i]
    norm += q[i] * q[i]
  }
  return norm > 0 ? dot / Math.sqrt(norm) : 0
}

// ─── A file's meaning, and its likeness to other files (D43) ─────────
//
// `e` is what a file is about (title and abstract, or its opening cleaned);
// `w` its whole text, as the average of pieces spread over it. Search goes
// by the two together. Files are compared with each other (Suggest
// categories, growth) by that, less part of what every text has in common
// (TEXT_CENTRE): an average of many pieces leans towards it, so without
// this two long files on different subjects are as alike as two short
// files on the same one, and no one bar groups both. Built-in topics go by
// `e` alone (they were tuned on it).

/**
 * The average of the whole-file vectors of a reference sample (27 arXiv
 * papers in 4 subjects, 15 Wikipedia and Wikivoyage articles in 5): what
 * text in general reads like to the model. scripts/calibrate-whole-file.mjs.
 */
export const TEXT_CENTRE =
  '2g7c6O8C9wcA/xcJK/z77BX96QL/0goO8fgA8xDEDBMVDe8dAwHxCOoMAw8K+/YPsOr++gEHAgUY/9zxBfnhAhILG/oKJN7y4gsXFusCJOQs5fH55PoO/w/nMPwKGhT9Af4Of+kF4/Mc+w7h+vn0BfL/+/L+EhoBAu8WDijS2/ruySj6AhL/9grj7BIJPzIp9zQV6xv3G9oQ7hf6BPXuAdcqAA/86g3mHRUj6+zh//PN9/b1A98PDPoK9Aj9COL0KAve21L29PS5Bt/P4ekf6Pck5xnO8h3u3Q7uDgbvIMXDDNgs3vDz1x4g2NMKFA3QCeMB7wAKxRkOHe3k//IR7tcd+g8iChcpCfzb//AC5gUTAhT6DNztFQASKQwe5wEO/ATvExHlG/wa/PT9+Af3+uf4Ig4T9wrIDQ8PAPUuDL8H7P4XFPjf5gIOCxXx9hohBzjs8EEp1fXxFAg67+wQH/7yFiPqCgL9GewBJhv21/URItgEEBMTAh71Ghn8HgUB'
/** How much of TEXT_CENTRE is taken out of a file's meaning to compare files (tried 0.5, 0.7: 0.5 groups best). */
export const CENTRE_WEIGHT = 0.5

const unitOf = (v: ArrayLike<number>): Float32Array => {
  const out = Float32Array.from(v)
  let n = 0
  for (const x of out) n += x * x
  n = Math.sqrt(n) || 1
  for (let i = 0; i < out.length; i++) out[i] /= n
  return out
}
let centre: Float32Array | null = null
const meaningCache = new Map<string, Float32Array>()
const likenessCache = new Map<string, Float32Array>()
const cached = (cache: Map<string, Float32Array>, key: string, make: () => Float32Array) => {
  let v = cache.get(key)
  if (!v) {
    v = make()
    if (cache.size > 20_000) cache.clear()
    cache.set(key, v)
  }
  return v
}

/** A file's meaning, normalized: what it's about and its whole text together (`e` alone without `w`). */
export function meaningOf(entry: SearchEntry): Float32Array | null {
  const { e, w } = entry
  if (!e) return null
  return cached(meaningCache, w ? e + w : e, () => {
    const a = unitOf(dequantize(e))
    if (!w) return a
    const b = unitOf(dequantize(w))
    return unitOf(a.map((x, i) => x + b[i]))
  })
}

/** A file's vector to compare with other files' (dot product = likeness): its meaning less part of TEXT_CENTRE. */
export function likenessOf(entry: SearchEntry): Float32Array | null {
  const m = meaningOf(entry)
  if (!m) return null
  return cached(likenessCache, entry.w ? entry.e! + entry.w : entry.e!, () => {
    centre ??= unitOf(dequantize(TEXT_CENTRE))
    const c = centre
    return c.length === m.length ? unitOf(m.map((x, i) => x - CENTRE_WEIGHT * c[i])) : m
  })
}

// ─── Photo tags (CLIP zero-shot) ──────────────────────────────────────
//
// Tags are stored as English words. They also go into the photo's text
// embedding, which is multilingual — so a query in Chinese ("猫") reaches
// cat photos through the tag "cat", although CLIP itself is English-only.

export const PHOTO_LABELS = [
  'person', 'selfie', 'group of people', 'baby', 'child',
  'dog', 'cat', 'bird', 'animal', 'wildlife',
  'food', 'drink', 'restaurant',
  'beach', 'ocean', 'mountain', 'forest', 'flowers', 'garden', 'nature',
  'sunset', 'night', 'snow', 'sky',
  'city', 'street', 'building', 'architecture', 'interior', 'home',
  'car', 'vehicle', 'airplane', 'train',
  'sports', 'concert', 'party', 'wedding',
  'document', 'receipt', 'invoice', 'screenshot', 'whiteboard', 'handwriting',
  'chart', 'diagram', 'map', 'text',
  'art', 'drawing', 'logo', 'meme',
  'computer', 'phone', 'product',
] as const

export const photoPrompt = (label: string) => `a photo of ${label === 'text' ? 'text' : `a ${label}`}`

/**
 * Pick tags from CLIP image↔label cosines: softmax at CLIP's logit scale,
 * keep labels above a probability floor, at most 3.
 */
export function pickPhotoTags(cosines: number[], labels: readonly string[] = PHOTO_LABELS): string[] {
  const logits = cosines.map((c) => c * 100)
  const max = Math.max(...logits)
  const exps = logits.map((l) => Math.exp(l - max))
  const sum = exps.reduce((a, b) => a + b, 0)
  return exps
    .map((e, i) => ({ label: labels[i], p: e / sum }))
    .filter((x) => x.p >= 0.08)
    .sort((a, b) => b.p - a.p)
    .slice(0, 3)
    .map((x) => x.label)
}

// ─── Entry text ───────────────────────────────────────────────────────

/**
 * Camera/screenshot-style names ("IMG_0042", "PXL_20240611_…", "Screenshot
 * 2024-06-11 at …") carry no meaning but dominate a short passage — every
 * such photo would embed alike. They stay matchable by name search.
 */
const MEANINGLESS_NAME =
  /^(?:img|dsc|dscn|dcim|pxl|mvimg|vid|mov|photo|image|scan|screenshot|screen shot|wp|whatsapp image)?(?:[\d\s_\-.:@]|\bat\b)*$/i

export function meaningfulStem(name: string): string {
  const stem = name.replace(/\.[^.]+$/, '')
  return MEANINGLESS_NAME.test(stem) ? '' : stem.replace(/[_\-.]+/g, ' ').trim()
}

/** The passage embedded for a file: its name, photo tags, and leading text. */
export function passageText(name: string, tags: string[] | undefined, text: string | undefined): string {
  const stem = meaningfulStem(name)
  const parts = stem ? [stem] : []
  if (tags?.length) parts.push(`photo of ${tags.join(', ')}`)
  if (text) parts.push(text.slice(0, EMBED_TEXT_CHARS))
  return parts.join('\n')
}

export function makeExcerpt(text: string | undefined): string | undefined {
  if (!text) return undefined
  const t = text.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, EXCERPT_CHARS) : undefined
}

// ─── Scoring ──────────────────────────────────────────────────────────

export interface Query {
  text: string
  /** text-model query embedding (normalized) */
  vec: ArrayLike<number>
  /** CLIP text embedding (normalized), for photo search */
  clip?: ArrayLike<number>
}

/**
 * Calibration (scripts/test-search.mjs, English + Chinese corpus): text-model
 * cosines are ~0.18–0.42 for unrelated pairs and ~0.42–0.79 for matches,
 * across languages; CLIP text↔photo cosines reach ~0.255 unrelated and
 * ~0.26–0.31 for matches (weak — photo tags carry most of the signal through
 * the text model). Each signal maps to ~0 at "unrelated" and ~1 at "clear
 * match"; the best signal wins.
 */
export const CAL = {
  textFloor: 0.3,
  textSpan: 0.3,
  clipFloor: 0.245,
  clipSpan: 0.05,
  minScore: 0.25,
}

export function scoreFile(
  q: Query,
  name: string,
  entry: SearchEntry | undefined
): number {
  let best = 0
  const needle = q.text.trim().toLowerCase()
  const hay = name.toLowerCase()
  if (needle && hay.includes(needle)) best = 1.5
  else if (needle) {
    // every query word in the name
    const words = needle.split(/\s+/).filter(Boolean)
    if (words.length > 1 && words.every((w) => hay.includes(w))) best = 1.2
  }
  if (!entry) return best
  // exact keyword in the extracted text (codes, numbers, CJK terms)
  if (needle.length >= 2 && entry.t?.toLowerCase().includes(needle)) best = Math.max(best, 1.0)
  const meaning = meaningOf(entry)
  if (meaning) {
    let cos = 0
    if (q.vec.length === meaning.length) for (let i = 0; i < meaning.length; i++) cos += q.vec[i] * meaning[i]
    const s = (cos - CAL.textFloor) / CAL.textSpan
    best = Math.max(best, s)
  }
  if (entry.c && q.clip) {
    const s = (cosineQ(q.clip, dequantize(entry.c)) - CAL.clipFloor) / CAL.clipSpan
    best = Math.max(best, s)
  }
  return best
}

export interface Hit<T> {
  item: T
  score: number
}

export function rank<T>(
  q: Query,
  items: T[],
  get: (item: T) => { name: string; search?: SearchEntry }
): Hit<T>[] {
  return items
    .map((item) => {
      const { name, search } = get(item)
      return { item, score: scoreFile(q, name, search) }
    })
    .filter((h) => h.score >= CAL.minScore)
    .sort((a, b) => b.score - a.score)
}

// ─── Organize suggestions ─────────────────────────────────────────────
//
// A folder's "topic" is the mean of its files' text vectors. A file is
// suggested for a move when another folder's topic fits it clearly better
// than its own folder does. Drive-root files have no topic to compare
// against, so they only need a strong enough fit.

export interface FolderFiles<T> {
  path: string
  files: T[]
  /** text embedding of the folder's own name (last path segment) */
  nameVec?: ArrayLike<number>
}

export interface MoveSuggestion<T> {
  item: T
  from: string
  to: string
  /** cosine of the file to the destination's topic */
  fit: number
}

/**
 * Tuned for precision over recall (scripts/test-search.mjs): a wrong
 * suggestion costs trust and a transaction; a missed one costs nothing.
 */
export const SUGGEST = {
  /** minimum fit to the destination (topic or folder name) */
  minFit: 0.25,
  /** how much the best folder must beat the runner-up — and, for files
   *  already in a folder, their own folder */
  margin: 0.06,
  /** a folder needs this many indexed files to have a topic */
  minFolderFiles: 2,
}

function centroid(vecs: Int8Array[], exclude?: Int8Array): Float32Array | null {
  const use = exclude ? vecs.filter((v) => v !== exclude) : vecs
  if (use.length === 0) return null
  const c = new Float32Array(use[0].length)
  for (const v of use) {
    let n = 0
    for (let i = 0; i < v.length; i++) n += v[i] * v[i]
    n = Math.sqrt(n) || 1
    for (let i = 0; i < v.length; i++) c[i] += v[i] / n
  }
  let n = 0
  for (let i = 0; i < c.length; i++) n += c[i] * c[i]
  n = Math.sqrt(n) || 1
  for (let i = 0; i < c.length; i++) c[i] /= n
  return c
}

export function suggestMoves<T>(
  folders: FolderFiles<T>[],
  sourcePath: string,
  get: (item: T) => { search?: SearchEntry }
): MoveSuggestion<T>[] {
  const vecsOf = (f: FolderFiles<T>) =>
    f.files
      .map((item) => ({ item, v: get(item).search?.e ? dequantize(get(item).search!.e!) : null }))
      .filter((x): x is { item: T; v: Int8Array } => x.v !== null)

  const source = folders.find((f) => f.path === sourcePath)
  if (!source) return []
  const sourceVecs = vecsOf(source)
  const topics = folders
    .filter((f) => f.path !== sourcePath && f.path !== '')
    .map((f) => {
      const vecs = vecsOf(f).map((x) => x.v)
      return {
        path: f.path,
        c: vecs.length >= SUGGEST.minFolderFiles ? centroid(vecs) : null,
        name: f.nameVec,
      }
    })
    .filter((t) => t.c !== null || t.name !== undefined)
  if (topics.length === 0) return []

  const fitTo = (t: (typeof topics)[number], v: Int8Array) =>
    Math.max(t.c ? cosineQ(t.c, v) : -1, t.name ? cosineQ(t.name, v) : -1)

  const out: MoveSuggestion<T>[] = []
  for (const { item, v } of sourceVecs) {
    const fits = topics.map((t) => ({ path: t.path, fit: fitTo(t, v) })).sort((a, b) => b.fit - a.fit)
    const best = fits[0]
    if (best.fit < SUGGEST.minFit) continue
    let rival = fits[1]?.fit ?? -1
    if (sourcePath !== '') {
      const own = centroid(sourceVecs.map((x) => x.v), v)
      const ownFit = Math.max(own ? cosineQ(own, v) : -1, source.nameVec ? cosineQ(source.nameVec, v) : -1)
      rival = Math.max(rival, ownFit)
    }
    if (best.fit - rival < SUGGEST.margin) continue
    out.push({ item, from: sourcePath, to: best.path, fit: best.fit })
  }
  return out.sort((a, b) => b.fit - a.fit)
}
