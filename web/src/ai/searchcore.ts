// Pure search logic shared by the AI worker, the UI and the Node tests:
// vector (de)quantization, photo tag selection, and query scoring.
// No DOM, no model code.

import type { SearchEntry } from '@0gdrive/core'

export type { SearchEntry }

export const SEARCH_ENTRY_VERSION = 1
/** Characters of extracted text kept in the (encrypted) manifest. */
export const EXCERPT_CHARS = 280
/** Characters of extracted text fed to the text embedder (it reads ≤128 tokens). */
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
  if (entry.e) {
    const s = (cosineQ(q.vec, dequantize(entry.e)) - CAL.textFloor) / CAL.textSpan
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
