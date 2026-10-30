// /_node/<ip>:<port>: HTTPS relay to 0G storage nodes. Nodes only speak
// plain HTTP, which browsers block from https pages (mixed content), so on
// https the app sends its node JSON-RPC here instead (core setNodeRelay) and
// this forwards it to http://<ip>:<port> unchanged. Data is already
// encrypted in the browser; nothing is stored.
//
// On Vercel this is a function (web/vercel.json rewrites /_node/… to
// /api/node?target=…); the dev server runs the same handler (vite.config.ts).
// Not an open proxy: POST only, storage-node (zgs_*) methods only, and only
// to nodes that a 0G indexer currently lists.

// Same indexers as core/src/config.ts
const INDEXERS = [
  'https://indexer-storage-testnet-turbo.0g.ai',
  'https://indexer-storage-testnet-standard.0g.ai',
  'https://indexer-storage-turbo.0g.ai',
  'https://indexer-storage.0g.ai',
]
const NODES_TTL_MS = 60_000
const MISS_REFRESH_MS = 10_000 // an unknown target re-reads the lists at most this often
const MAX_BODY = 4 * 1024 * 1024 // a batch of segments; Vercel's request limit is 4.5 MB
const TIMEOUT_MS = 60_000

let nodes = new Set<string>()
let fetchedAt = 0
let refreshing: Promise<void> | null = null

async function refreshNodes(): Promise<void> {
  const lists = await Promise.all(
    INDEXERS.map(async (url) => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'indexer_getShardedNodes', params: [] }),
          signal: AbortSignal.timeout(10_000),
        })
        const { result } = (await res.json()) as { result?: Record<string, { url: string }[] | null> }
        return Object.values(result ?? {}).flatMap((list) => list ?? []).map((n) => n.url)
      } catch {
        return []
      }
    })
  )
  const next = new Set(lists.flat().flatMap((u) => /^http:\/\/([^/]+)\/?$/.exec(u)?.[1] ?? []))
  if (next.size > 0) nodes = next
  fetchedAt = Date.now()
}

async function isKnownNode(target: string): Promise<boolean> {
  const age = Date.now() - fetchedAt
  if (age > NODES_TTL_MS || (!nodes.has(target) && age > MISS_REFRESH_MS)) {
    refreshing ??= refreshNodes().finally(() => (refreshing = null))
    await refreshing
  }
  return nodes.has(target)
}

const deny = (status: number) => new Response(null, { status })

export async function POST(request: Request): Promise<Response> {
  const target = new URL(request.url).searchParams.get('target') ?? ''
  if (!/^[a-z0-9.-]+:\d{1,5}$/i.test(target)) return deny(404)
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return deny(413)

  const body = await request.text()
  if (body.length > MAX_BODY) return deny(413)
  let calls: unknown
  try {
    calls = JSON.parse(body)
  } catch {
    return deny(400)
  }
  const list = Array.isArray(calls) ? calls : [calls]
  const zgsOnly =
    list.length > 0 &&
    list.every((c) => typeof (c as { method?: unknown })?.method === 'string' && (c as { method: string }).method.startsWith('zgs_'))
  if (!zgsOnly) return deny(403)
  if (!(await isKnownNode(target))) return deny(403)

  let up: Response
  try {
    up = await fetch(`http://${target}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(TIMEOUT_MS)]),
    })
  } catch {
    return deny(502)
  }
  return new Response(up.body, {
    status: up.status,
    headers: { 'content-type': up.headers.get('content-type') ?? 'application/json', 'x-0gdrive-relay': '1' },
  })
}
