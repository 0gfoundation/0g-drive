// /_models/<host>/<path>: the AI worker's fallback route for model files
// when the browser's own connection to the model CDNs stalls (see
// src/ai/netfetch.ts). Fetches upstream (following the CDN's redirects) and
// streams back, passing Range through so downloads resume.
//
// On Vercel this is a function (web/vercel.json rewrites /_models/… to
// /api/models?path=…); the dev server runs the same handler (vite.config.ts).
// GET only, and only for the files the on-device models need, so it can't be
// used as a general download proxy.

const ALLOWED: Record<string, RegExp> = {
  'huggingface.co': /^\/Xenova\/(paraphrase-multilingual-MiniLM-L12-v2|clip-vit-base-patch32)\/resolve\//,
  'cdn.jsdelivr.net': /^\/npm\/onnxruntime-web@[^/]+\/dist\//,
}
const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']

export async function GET(request: Request): Promise<Response> {
  const rest = new URL(request.url).searchParams.get('path') ?? ''
  const slash = rest.indexOf('/')
  const host = slash > 0 ? rest.slice(0, slash) : ''
  const path = rest.slice(slash)
  if (!ALLOWED[host]?.test(path) || path.includes('..')) return new Response(null, { status: 404 })

  const headers: Record<string, string> = { 'accept-encoding': 'identity' }
  const range = request.headers.get('range')
  if (range) headers.range = range
  let up: Response
  try {
    up = await fetch(`https://${host}${path}`, { headers, redirect: 'follow', signal: request.signal })
  } catch {
    return new Response(null, { status: 502 })
  }
  const out = new Headers({ 'x-0gdrive-proxy': '1' })
  for (const h of PASS_HEADERS) {
    const v = up.headers.get(h)
    if (v) out.set(h, v)
  }
  return new Response(up.body, { status: up.status, headers: out })
}
