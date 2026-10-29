import { defineConfig, type Connect, type Plugin } from 'vite'
import { Readable } from 'node:stream'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import react from '@vitejs/plugin-react'
import path from 'path'
import { GET as modelsGET } from './api/models'

const fsStub = path.resolve(__dirname, 'src/stubs/fs.ts')
const fsPromisesStub = path.resolve(__dirname, 'src/stubs/fs-promises.ts')

// /_models/<host>/<path>: the AI worker's fallback route for model files —
// the same handler that runs as a Vercel function in production (api/models.ts)
const modelRoute: Connect.NextHandleFunction = (req, res, next) => {
  if (!req.url?.startsWith('/_models/')) return next()
  if (req.method !== 'GET') {
    res.statusCode = 404
    return res.end()
  }
  const ctrl = new AbortController()
  res.on('close', () => ctrl.abort())
  const url = `http://localhost/api/models?path=${encodeURIComponent(req.url.slice('/_models/'.length))}`
  const headers = typeof req.headers.range === 'string' ? { range: req.headers.range } : undefined
  modelsGET(new Request(url, { headers, signal: ctrl.signal }))
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

const modelProxy = (): Plugin => ({
  name: '0gdrive-model-route',
  configureServer: (server) => void server.middlewares.use(modelRoute),
  configurePreviewServer: (server) => void server.middlewares.use(modelRoute),
})

export default defineConfig({
  plugins: [
    modelProxy(),
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
