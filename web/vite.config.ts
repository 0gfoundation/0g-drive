import { defineConfig, type Connect, type Plugin } from 'vite'
import { Readable } from 'node:stream'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import react from '@vitejs/plugin-react'
import path from 'path'

const fsStub = path.resolve(__dirname, 'src/stubs/fs.ts')
const fsPromisesStub = path.resolve(__dirname, 'src/stubs/fs-promises.ts')

// /_models/<host>/<path>: the AI worker's fallback route for model files
// when the browser's own connection to the model CDNs stalls (see
// src/ai/netfetch.ts). Fetches upstream (following the CDN's redirects) and
// streams back, passing Range through so downloads resume. GET only, and
// only for the two hosts the models come from. A production host needs the
// same route (or the browser simply keeps the direct download).
const MODEL_HOSTS = new Set(['huggingface.co', 'cdn.jsdelivr.net'])
const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']

const modelRoute: Connect.NextHandleFunction = (req, res, next) => {
  if (!req.url?.startsWith('/_models/')) return next()
  const rest = req.url.slice('/_models/'.length)
  const slash = rest.indexOf('/')
  const host = slash > 0 ? rest.slice(0, slash) : ''
  if (req.method !== 'GET' || !MODEL_HOSTS.has(host)) {
    res.statusCode = 404
    return res.end()
  }
  const ctrl = new AbortController()
  res.on('close', () => ctrl.abort())
  const headers: Record<string, string> = { 'accept-encoding': 'identity' }
  if (typeof req.headers.range === 'string') headers.range = req.headers.range
  fetch(`https://${host}${rest.slice(slash)}`, { headers, redirect: 'follow', signal: ctrl.signal })
    .then((up) => {
      res.statusCode = up.status
      for (const h of PASS_HEADERS) {
        const v = up.headers.get(h)
        if (v) res.setHeader(h, v)
      }
      res.setHeader('x-0gdrive-proxy', '1')
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
