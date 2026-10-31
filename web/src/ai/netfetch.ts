// Model downloads (runs in the AI worker as transformers.js's `env.fetch`).
//
// A first visit pulls ~160 MB (text model) from the Hugging Face and jsDelivr
// CDNs, and ~155 MB more (photo models) the first time photos are involved. On
// networks where those are slow or unreachable the stock fetch just hangs,
// so this wrapper:
//   • reports byte-accurate progress across all model files (one number that
//     only goes up, with MB and speed),
//   • notices a stalled or crawling download and resumes it (HTTP Range) via
//     the app's own server at /_models/<host>/… — see vite.config.ts,
//   • keeps the original URLs as cache keys, so changing route never
//     re-downloads a cached file.

const ROUTED_HOSTS = new Set(['huggingface.co', 'cdn.jsdelivr.net'])
const PROXY_PREFIX = '/_models/'
const PROXY_HEADER = 'x-0gdrive-proxy'
const HEADERS_TIMEOUT_MS = 10_000
const STALL_MS = 15_000
/** direct downloads slower than this over SLOW_WINDOW_MS try the server route */
const SLOW_BYTES_PER_SEC = 150 * 1024
const SLOW_WINDOW_MS = 20_000
const MAX_ATTEMPTS = 8

// What a first visit downloads (q8 weights, tokenizers, ONNX Runtime wasm),
// for a progress denominator that doesn't grow as files start. Sizes are
// refined from Content-Length; small config files aren't counted.
// Grouped by what loads them: 'text' with the warm-up (the runtime comes
// with the first model); CLIP's halves on first photo use — 'clipImage' to
// index a photo, 'clipText' for its labels and for photo search.
export type ModelGroup = 'text' | 'clipImage' | 'clipText'
const PLANNED: { re: RegExp; size: number; group: ModelGroup }[] = [
  { re: /paraphrase-multilingual-MiniLM-L12-v2\/resolve\/[^/]+\/onnx\/model_quantized\.onnx$/, size: 118_308_126, group: 'text' },
  { re: /paraphrase-multilingual-MiniLM-L12-v2\/resolve\/[^/]+\/tokenizer\.json$/, size: 17_082_913, group: 'text' },
  { re: /clip-vit-base-patch32\/resolve\/[^/]+\/onnx\/vision_model_quantized\.onnx$/, size: 89_117_001, group: 'clipImage' },
  { re: /clip-vit-base-patch32\/resolve\/[^/]+\/onnx\/text_model_quantized\.onnx$/, size: 64_504_507, group: 'clipText' },
  { re: /clip-vit-base-patch32\/resolve\/[^/]+\/tokenizer\.json$/, size: 2_224_119, group: 'clipText' },
  { re: /\/ort-wasm-simd-threaded[^/]*\.wasm$/, size: 26_861_777, group: 'text' },
]

type Route = 'direct' | 'server'

export interface NetStats {
  /** bytes received for planned files this session */
  loaded: number
  /** bytes this session needs (planned files not already cached) */
  total: number
  bytesPerSec: number
  /** downloads in flight */
  active: number
  route: Route
  /** a download stalled and is being resumed */
  reconnecting: boolean
}

let onStats: ((s: NetStats) => void) | undefined
export function onNetStats(cb: (s: NetStats) => void) {
  onStats = cb
}

const sizes = new Map<number, number>() // PLANNED index → expected bytes still to fetch
const got = new Map<number, number>() // PLANNED index → bytes received
let active = 0
let reconnecting = 0
let preferred: Route = 'direct'
let rate = 0
let rateAt = 0
let rateBytes = 0
let lastPost = 0

function stats(): NetStats {
  let loaded = 0
  let total = 0
  for (const [i, s] of sizes) {
    const g = got.get(i) ?? 0
    loaded += Math.min(g, s)
    total += s
  }
  return { loaded, total, bytesPerSec: rate, active, route: preferred, reconnecting: reconnecting > 0 }
}

function post(force = false) {
  const now = Date.now()
  if (!force && now - lastPost < 250) return
  lastPost = now
  onStats?.(stats())
}

function countBytes(i: number, n: number) {
  if (i >= 0) got.set(i, (got.get(i) ?? 0) + n)
  const now = Date.now()
  rateBytes += n
  if (!rateAt) rateAt = now
  if (now - rateAt >= 1000) {
    const inst = (rateBytes * 1000) / (now - rateAt)
    rate = rate ? rate * 0.6 + inst * 0.4 : inst
    rateAt = now
    rateBytes = 0
  }
  post()
}

/**
 * Work out which of `groups`' planned files still need downloading (call
 * before loading their models). Without Cache Storage everything counts as
 * needed.
 */
export async function planDownloads(cacheKey: string, groups: ModelGroup[]): Promise<void> {
  const cached = new Set<number>()
  try {
    const cache = await caches.open(cacheKey)
    for (const req of await cache.keys()) {
      const i = PLANNED.findIndex((p) => p.re.test(new URL(req.url).pathname))
      if (i >= 0) cached.add(i)
    }
  } catch {
    // no Cache Storage (private mode) — assume nothing is cached
  }
  PLANNED.forEach((p, i) => {
    if (groups.includes(p.group) && !cached.has(i) && !sizes.has(i)) sizes.set(i, p.size)
  })
  post(true)
}

function proxied(url: URL): string {
  return `${self.location.origin}${PROXY_PREFIX}${url.host}${url.pathname}${url.search}`
}

const other = (r: Route): Route => (r === 'direct' ? 'server' : 'direct')

class RouteUnavailable extends Error {}

async function open(url: URL, route: Route, from: number, init?: RequestInit) {
  const ctrl = new AbortController()
  const headers = new Headers(init?.headers)
  if (from > 0) headers.set('Range', `bytes=${from}-`)
  const timer = setTimeout(() => ctrl.abort(), HEADERS_TIMEOUT_MS)
  try {
    const res = await fetch(route === 'direct' ? url.href : proxied(url), {
      ...init,
      headers,
      signal: ctrl.signal,
    })
    if (route === 'server' && !res.headers.has(PROXY_HEADER)) {
      // a static host without the model route
      ctrl.abort()
      preferred = 'direct'
      throw new RouteUnavailable('no model route on this server')
    }
    return { res, ctrl }
  } finally {
    clearTimeout(timer)
  }
}

function totalFrom(res: Response): number | undefined {
  const range = res.headers.get('content-range') // bytes a-b/total
  const m = range && /\/(\d+)$/.exec(range)
  if (m) return Number(m[1])
  const len = res.headers.get('content-length')
  return len ? Number(len) : undefined
}

function readWithin<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('download stalled')), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** First response for a request, trying the other route when one fails. */
async function openFirst(url: URL, init?: RequestInit) {
  let route = preferred
  let attempts = 0
  let serverMissing = false
  for (;;) {
    try {
      const opened = await open(url, route, 0, init)
      if (route === 'server') preferred = 'server' // direct failed: stay on the server route
      return { ...opened, route, serverMissing }
    } catch (err) {
      if (err instanceof RouteUnavailable) serverMissing = true
      if (++attempts >= MAX_ATTEMPTS || (serverMissing && route === 'direct')) throw err
      route = serverMissing ? 'direct' : other(route)
    }
  }
}

async function fetchResumable(url: URL, init?: RequestInit): Promise<Response> {
  // the library's own Range probes (file size checks): no resuming, but
  // they need the route fallback just as much
  if (new Headers(init?.headers).has('range')) return (await openFirst(url, init)).res

  const planned = PLANNED.findIndex((p) => p.re.test(url.pathname))
  const first = await openFirst(url, init)
  let { route, serverMissing } = first
  let attempts = 0
  const { res } = first
  if (!res.ok || !res.body) return res // 404s etc. pass straight through

  const total = totalFrom(res)
  if (planned >= 0) {
    // Content-Length can be the compressed size (tokenizer.json is served
    // gzipped), so it only ever raises the estimate; the exact size is
    // known once the file is done.
    sizes.set(planned, Math.max(sizes.get(planned) ?? PLANNED[planned].size, total ?? 0))
    got.set(planned, 0)
  }

  let cur: { res: Response; ctrl: AbortController } = first
  let reader = res.body.getReader()
  let received = 0
  let skip = 0 // bytes to drop when a resumed request ignored Range
  let windowAt = Date.now()
  let windowBytes = 0
  let triedServerForSlow = false
  let closed = false
  active++
  post(true)

  const finish = (complete = false) => {
    if (closed) return
    closed = true
    if (complete && planned >= 0) sizes.set(planned, received)
    active--
    post(true)
  }

  const resume = async (why: string) => {
    console.warn(`[models] ${why} — resuming ${url.pathname.split('/').pop()} at ${received} bytes`)
    cur.ctrl.abort()
    reconnecting++
    post(true)
    try {
      for (;;) {
        if (++attempts >= MAX_ATTEMPTS) throw new Error(`model download failed (${why})`)
        route = serverMissing ? 'direct' : other(route)
        try {
          const next = await open(url, route, received, init)
          if (next.res.status !== 206 && next.res.status !== 200) {
            next.ctrl.abort()
            continue
          }
          cur = next
          reader = next.res.body!.getReader()
          skip = next.res.status === 200 ? received : 0
          windowAt = Date.now()
          windowBytes = 0
          if (route === 'server') preferred = 'server'
          return
        } catch (err) {
          if (err instanceof RouteUnavailable) serverMissing = true
        }
      }
    } finally {
      reconnecting--
      post(true)
    }
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>
        try {
          chunk = await readWithin(reader.read(), STALL_MS)
        } catch (err) {
          if (closed) return // cancelled by the reader
          try {
            await resume((err as Error).message)
          } catch (fatal) {
            finish()
            controller.error(fatal)
            return
          }
          continue
        }
        if (chunk.done) {
          if (total !== undefined && received < total) {
            // connection closed early
            try {
              await resume('connection closed early')
            } catch (fatal) {
              finish()
              controller.error(fatal)
              return
            }
            continue
          }
          finish(true)
          controller.close()
          return
        }
        let bytes = chunk.value
        if (skip > 0) {
          const drop = Math.min(skip, bytes.length)
          skip -= drop
          bytes = bytes.subarray(drop)
          if (!bytes.length) continue
        }
        received += bytes.length
        countBytes(planned, bytes.length)
        controller.enqueue(bytes)

        // crawling on the direct route: try the server once
        windowBytes += bytes.length
        const elapsed = Date.now() - windowAt
        if (elapsed >= SLOW_WINDOW_MS) {
          const slow = (windowBytes * 1000) / elapsed < SLOW_BYTES_PER_SEC
          windowAt = Date.now()
          windowBytes = 0
          if (slow && route === 'direct' && !serverMissing && !triedServerForSlow &&
              (total === undefined || total - received > 4 * 1024 * 1024)) {
            triedServerForSlow = true
            try {
              await resume('slow connection')
            } catch (fatal) {
              finish()
              controller.error(fatal)
              return
            }
          }
        }
        return
      }
    },
    cancel() {
      cur.ctrl.abort()
      finish()
    },
  })

  const headers = new Headers()
  const type = res.headers.get('content-type')
  if (type) headers.set('content-type', type)
  if (total !== undefined) headers.set('content-length', String(total))
  return new Response(body, { status: 200, headers })
}

/** Drop-in `fetch` for transformers.js (`env.fetch`). */
export function modelFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  let url: URL
  try {
    url = new URL(href, self.location.href)
  } catch {
    return fetch(input, init)
  }
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  if (!ROUTED_HOSTS.has(url.hostname) || method !== 'GET' || input instanceof Request) {
    return fetch(input, init)
  }
  return fetchResumable(url, init)
}
