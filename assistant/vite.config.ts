import { defineConfig } from 'vite'

// The assistant is its own app on its own origin, shown inside the drive as
// an iframe: the browser's same-origin rule keeps it away from the drive's
// keys and files. Port 3000 because the 0G Router only answers browsers on
// allowlisted origins: https://*.0g.ai, http://localhost:3000 and :5173
// (checked 2026-10-29) — production must serve it from a *.0g.ai host.
// No React plugin: its dev preamble is an inline script, which the page's
// CSP (index.html) doesn't allow.
export default defineConfig({
  server: { port: 3000, strictPort: true },
  preview: { port: 3000, strictPort: true },
  build: { target: 'es2022' },
})
