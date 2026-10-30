import { defineConfig, type Connect, type Plugin } from 'vite'
import { Readable } from 'node:stream'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import react from '@vitejs/plugin-react'
import path from 'path'
import { GET as modelsGET } from './api/models'
import { POST as nodePOST } from './api/node'

const fsStub = path.resolve(__dirname, 'src/stubs/fs.ts')
const fsPromisesStub = path.resolve(__dirname, 'src/stubs/fs-promises.ts')

// Pipes a web Response from one of the api/ handlers into a Node response
function send(res: import('node:http').ServerResponse, out: Promise<Response>) {
  out
    .then((up) => {
      res.statusCode = up.status
      up.headers.forEach((v, k) => res.setHeader(k, v))
      if (!up.body) return res.end()
      Readable.fromWeb(up.body as import('node:stream/web').ReadableStream).on('error', () => res.destroy()).pipe(res)
    })
    .catch(() => {
      if (!res.headersSent) res.statusCode = 502
      res.end()
    })
}

// /_models/<host>/<path>: the AI worker's fallback route for model files, and
// /_node/<ip>:<port>: the storage-node relay — the same handlers that run as
// Vercel functions in production (api/models.ts, api/node.ts)
const apiRoutes: Connect.NextHandleFunction = (req, res, next) => {
  const ctrl = new AbortController()
  res.on('close', () => ctrl.abort())
  if (req.url?.startsWith('/_models/')) {
    if (req.method !== 'GET') {
      res.statusCode = 404
      return res.end()
    }
    const url = `http://localhost/api/models?path=${encodeURIComponent(req.url.slice('/_models/'.length))}`
    const headers = typeof req.headers.range === 'string' ? { range: req.headers.range } : undefined
    return send(res, modelsGET(new Request(url, { headers, signal: ctrl.signal })))
  }
  if (req.url?.startsWith('/_node/')) {
    if (req.method !== 'POST') {
      res.statusCode = 404
      return res.end()
    }
    const url = `http://localhost/api/node?target=${encodeURIComponent(req.url.slice('/_node/'.length))}`
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () =>
      send(res, nodePOST(new Request(url, { method: 'POST', body: Buffer.concat(chunks), signal: ctrl.signal })))
    )
    return
  }
  next()
}

const apiProxy = (): Plugin => ({
  name: '0gdrive-api-routes',
  configureServer: (server) => void server.middlewares.use(apiRoutes),
  configurePreviewServer: (server) => void server.middlewares.use(apiRoutes),
})

export default defineConfig({
  plugins: [
    apiProxy(),
    react(),
    nodePolyfills({
      include: ['crypto', 'buffer', 'stream', 'util', 'events', 'path'],
      globals: { Buffer: true, process: true },
      protocolImports: true,
    }),
  ],
  resolve: {
    alias: [
      // fs stubs — SDK imports fs but browser code paths never call it
      { find: 'node:fs/promises', replacement: fsPromisesStub },
      { find: 'node:fs', replacement: fsStub },
      { find: /^fs$/, replacement: fsStub },
    ],
  },
  build: {
    target: 'esnext',
  },
  optimizeDeps: {
    // pre-bundle the lazily imported AI/PDF libraries up front: discovering
    // them on first use makes the dev server re-optimize and reload the
    // page — mid-upload
    include: ['pdfjs-dist', '@huggingface/transformers'],
  },
})
