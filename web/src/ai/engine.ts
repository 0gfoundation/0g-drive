// On-device models (transformers.js / ONNX Runtime). Runs inside the AI Web
// Worker in the browser, and directly under Node in scripts/test-search.mjs.
// Models load lazily on first use and are cached by the runtime (browser
// Cache Storage / Node file cache).

import {
  AutoProcessor,
  AutoTokenizer,
  CLIPTextModelWithProjection,
  CLIPVisionModelWithProjection,
  pipeline,
  type FeatureExtractionPipeline,
  type PreTrainedTokenizer,
  type Processor,
  type RawImage,
} from '@huggingface/transformers'
import {
  PHOTO_LABELS,
  SEARCH_ENTRY_VERSION,
  makeExcerpt,
  passageText,
  photoPrompt,
  pickPhotoTags,
  quantize,
  type SearchEntry,
} from './searchcore'

// Chosen over multilingual-e5-small/-base after scripts/test-search.mjs:
// same size as e5-small, but trained to align languages, so English↔Chinese
// queries reach documents in the other language (10/10 vs 6/10 probes).
// Reads at most 128 tokens — the file name and the document's opening.
export const TEXT_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'
export const CLIP_MODEL = 'Xenova/clip-vit-base-patch32'

export type ProgressCb = (info: { model: string; file?: string; progress?: number; status: string }) => void

let progressCb: ProgressCb | undefined
export function onModelProgress(cb: ProgressCb | undefined) {
  progressCb = cb
}
const progress = (model: string) => (p: { status: string; file?: string; progress?: number }) =>
  progressCb?.({ model, file: p.file, progress: p.progress, status: p.status })

// ─── Text (multilingual MiniLM) ───────────────────────────────────────

let textPipe: Promise<FeatureExtractionPipeline> | null = null
function textModel(): Promise<FeatureExtractionPipeline> {
  textPipe ??= pipeline('feature-extraction', TEXT_MODEL, {
    dtype: 'q8',
    progress_callback: progress('text'),
  }) as Promise<FeatureExtractionPipeline>
  return textPipe
}

async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  const pipe = await textModel()
  const out = await pipe(texts, { pooling: 'mean', normalize: true })
  const dim = out.dims[out.dims.length - 1]
  const data = out.data as Float32Array
  return texts.map((_, i) => data.slice(i * dim, (i + 1) * dim))
}

// symmetric model: queries and passages share one embedding, no prefixes
export const embedQueryText = async (q: string) => (await embedTexts([q]))[0]
export const embedPassage = async (p: string) => (await embedTexts([p]))[0]

// ─── CLIP ─────────────────────────────────────────────────────────────

let clipVision: Promise<[Processor, CLIPVisionModelWithProjection]> | null = null
let clipText: Promise<[PreTrainedTokenizer, CLIPTextModelWithProjection]> | null = null

function visionModel() {
  clipVision ??= Promise.all([
    AutoProcessor.from_pretrained(CLIP_MODEL, { progress_callback: progress('photo') }),
    CLIPVisionModelWithProjection.from_pretrained(CLIP_MODEL, {
      dtype: 'q8',
      progress_callback: progress('photo'),
    }) as Promise<CLIPVisionModelWithProjection>,
  ])
  return clipVision
}

function clipTextModel() {
  clipText ??= Promise.all([
    AutoTokenizer.from_pretrained(CLIP_MODEL, { progress_callback: progress('photo') }),
    CLIPTextModelWithProjection.from_pretrained(CLIP_MODEL, {
      dtype: 'q8',
      progress_callback: progress('photo'),
    }) as Promise<CLIPTextModelWithProjection>,
  ])
  return clipText
}

function normalizeRows(data: Float32Array, rows: number): Float32Array[] {
  const dim = data.length / rows
  const out: Float32Array[] = []
  for (let r = 0; r < rows; r++) {
    const v = data.slice(r * dim, (r + 1) * dim)
    let n = 0
    for (let i = 0; i < dim; i++) n += v[i] * v[i]
    n = Math.sqrt(n) || 1
    for (let i = 0; i < dim; i++) v[i] /= n
    out.push(v)
  }
  return out
}

export async function embedImage(image: RawImage): Promise<Float32Array> {
  const [processor, model] = await visionModel()
  const inputs = await processor(image)
  const { image_embeds } = await model(inputs)
  return normalizeRows(image_embeds.data as Float32Array, 1)[0]
}

export async function embedClipTexts(texts: string[]): Promise<Float32Array[]> {
  const [tokenizer, model] = await clipTextModel()
  const inputs = tokenizer(texts, { padding: true, truncation: true })
  const { text_embeds } = await model(inputs)
  return normalizeRows(text_embeds.data as Float32Array, texts.length)
}

let labelVecs: Promise<Float32Array[]> | null = null
const photoLabelVectors = () => (labelVecs ??= embedClipTexts(PHOTO_LABELS.map(photoPrompt)))

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

// ─── Entries ──────────────────────────────────────────────────────────

export async function indexPhoto(name: string, image: RawImage): Promise<SearchEntry> {
  const vec = await embedImage(image)
  const labels = await photoLabelVectors()
  const tags = pickPhotoTags(labels.map((l) => dot(vec, l)))
  const passage = passageText(name, tags, undefined)
  const e = passage ? quantize(await embedPassage(passage)) : undefined
  return { v: SEARCH_ENTRY_VERSION, g: tags.length ? tags : undefined, e, c: quantize(vec) }
}

export async function indexText(name: string, text: string | undefined): Promise<SearchEntry> {
  const passage = passageText(name, undefined, text)
  const e = passage ? quantize(await embedPassage(passage)) : undefined
  return { v: SEARCH_ENTRY_VERSION, t: makeExcerpt(text), e }
}

/**
 * The entry for a renamed file: the passage embedding redone with the new
 * name. The rest is kept — photo tags and the excerpt don't depend on the
 * name. The excerpt stands in for the text read at upload (it is shorter,
 * so the new embedding leans slightly more on the name).
 */
export async function renameEntry(name: string, entry: SearchEntry): Promise<SearchEntry> {
  const passage = passageText(name, entry.g, entry.t)
  const e = passage ? quantize(await embedPassage(passage)) : undefined
  return { ...entry, e }
}

/**
 * Load CLIP's text half now — what a search in a drive with indexed photos
 * needs (the photos' vectors are stored; only the query is embedded). See
 * warmUpPhotoSearch in client.ts for when.
 */
export async function warmPhotoSearch(): Promise<true> {
  try {
    await clipTextModel()
  } catch (err) {
    clipText = null
    throw err
  }
  return true
}

/**
 * Load the text model now (download + init), so the first upload isn't
 * kept waiting. The photo models (CLIP, ~150 MB) load on first use — a
 * photo upload or a search in a drive with photos — instead of with it:
 * the text model alone already takes the tab past 1 GB.
 */
export async function warmUp(): Promise<true> {
  try {
    await textModel()
  } catch (err) {
    // forget the failed load so a retry starts over (cached files stay)
    textPipe = null
    throw err
  }
  return true
}

export interface QueryVectors {
  vec: Float32Array
  clip?: Float32Array
}

/** Embed a search query; CLIP only when photo search is wanted. */
export async function embedQuery(text: string, withPhotos: boolean): Promise<QueryVectors> {
  const [vec, clip] = await Promise.all([
    embedQueryText(text),
    withPhotos ? embedClipTexts([photoPrompt(text)]).then((v) => v[0]) : Promise.resolve(undefined),
  ])
  return { vec, clip }
}
