// Proof of concept: the drive's V2 storage path from a real browser, through
// the testnet relayer (core/v2relayer.ts). The page runs on its own origin,
// so every call crosses CORS as the drive's would. Per engine:
//   - the storage key derives from the drive recovery signature, in the page
//   - an encrypted file uploads (parts in parallel, two connections dropped
//     on the way), with the page's clock 30 minutes off
//   - the same bytes again are a dedup
//   - an encrypted root manifest uploads last, and the listing finds it as
//     the account's newest file
//   - the file downloads, cut midway and resumed, and hashes back the same
//   - both are deleted and leave the listing
// WebKit at phone size, Chromium at desktop size. Funded: the first run
// deposits 0.05 testnet 0G into the storage account from .env's PRIVATE_KEY
// (the vault has no withdraw; files are deleted at the end, so rent is tiny).
//   node scripts/test-v2-relayer.mjs [MiB, default 16]
import { webkit, chromium } from 'playwright'
import { ethers } from 'ethers'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RECOVERY_SIGN_MESSAGE } from '../core/dist/recovery.js'
import { V2_TESTNET, deriveStorageKey, depositForUser, storageBalance } from '../core/dist/v2relayer.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MiB = Number(process.argv[2] ?? 16)
const ORIGIN = 'https://v2-poc.0gdrive.test'
const t0 = Date.now()
const at = () => `[${((Date.now() - t0) / 1000).toFixed(0)}s]`
let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${at()} ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// the storage account: the funding wallet's recovery signature, as a drive user's would be
const privateKey = /^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(readFileSync(resolve(root, '.env'), 'utf8'))?.[1]
if (!privateKey) throw new Error('PRIVATE_KEY missing from .env')
const provider = new ethers.JsonRpcProvider(V2_TESTNET.rpc, V2_TESTNET.chainId, { staticNetwork: true })
const wallet = new ethers.Wallet(privateKey, provider)
const recoverySig = await wallet.signMessage(RECOVERY_SIGN_MESSAGE)
const account = deriveStorageKey(recoverySig).address
let balance = await storageBalance(V2_TESTNET, account)
console.log(`${at()} storage account ${account}, balance ${ethers.formatEther(balance)} 0G`)
if (balance < ethers.parseEther('0.01')) {
  console.log(`${at()} depositing 0.05 0G from ${wallet.address}`)
  await depositForUser(V2_TESTNET, wallet, account, ethers.parseEther('0.05'))
  balance = await storageBalance(V2_TESTNET, account)
  console.log(`${at()} balance now ${ethers.formatEther(balance)} 0G`)
}

const bundle = (
  await build({
    stdin: { contents: "export * from './core/dist/v2relayer.js'; export { ethers } from 'ethers'", resolveDir: root },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    logLevel: 'error',
  })
).outputFiles[0].text
const html = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>v2 poc</title>
<p id=status>loading</p><script type=module>import * as V2 from '/v2.js'; window.V2 = V2; document.getElementById('status').textContent = 'ready'</script>`

/** Everything the page does; returns what it saw. Runs in the browser. */
async function inPage({ recoverySig, mib, partChunks }) {
  const { RelayerClient, V2_TESTNET, deriveStorageKey, hashBlob, ethers } = window.V2
  const out = { steps: [] }
  const step = (name, extra = {}) => out.steps.push({ name, ms: Math.round(performance.now() - t), ...extra })
  let t = performance.now()

  // a clock 30 minutes fast: statements must still be accepted (the client follows the relayer's Date)
  const realNow = Date.now
  Date.now = () => realNow() + 30 * 60_000
  const client = new RelayerClient(V2_TESTNET)
  const key = deriveStorageKey(recoverySig)
  out.account = key.address
  const info = await client.info()
  out.chunkSize = info.chunkSize

  // the drive's files are AES-GCM ciphertext; random bytes stand in for one
  const aes = await crypto.subtle.importKey('raw', ethers.getBytes(ethers.sha256(key.privateKey)), 'AES-GCM', false, ['encrypt', 'decrypt'])
  const plain = new Uint8Array(mib << 20)
  for (let i = 0; i < plain.length; i += 65536) crypto.getRandomValues(plain.subarray(i, i + 65536))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const file = new Blob([iv, await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, plain)])

  // leftovers of an earlier, failed run
  for (const f of (await client.list(key.address)).files) await client.delete(key, f.dataHash)

  t = performance.now()
  let progressCalls = 0
  const up = await client.upload(key, file, { partChunks, parallel: 4, onProgress: () => progressCalls++ })
  step('upload', { bytes: file.size, ...up, progressCalls })

  t = performance.now()
  const again = await client.upload(key, file)
  step('upload again', { dedup: again.dedup })

  const manifest = { v: 1, files: [{ name: 'photo.enc', hash: up.dataHash, size: file.size }], updatedAt: realNow() }
  const miv = crypto.getRandomValues(new Uint8Array(12))
  const rootBlob = new Blob([new TextEncoder().encode('0GDRIVE-ROOT1'), miv, await crypto.subtle.encrypt({ name: 'AES-GCM', iv: miv }, aes, new TextEncoder().encode(JSON.stringify(manifest)))])
  t = performance.now()
  const rootUp = await client.upload(key, rootBlob)
  step('root upload', { bytes: rootBlob.size, dataHash: rootUp.dataHash })

  // find the latest root as a fresh device would: the account's newest file, decrypted
  t = performance.now()
  const listed = await client.list(key.address)
  const newest = listed.files[0]
  const rootBack = new Uint8Array(await (await client.download(newest.dataHash)).blob.arrayBuffer())
  const magic = new TextDecoder().decode(rootBack.slice(0, 13))
  const found = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rootBack.slice(13, 25) }, aes, rootBack.slice(25))))
  step('find root', { listed: listed.files.map((f) => f.dataHash), newestIsRoot: newest.dataHash === rootUp.dataHash && magic === '0GDRIVE-ROOT1', rootNamesFile: found.files[0].hash === up.dataHash })

  t = performance.now()
  const down = await client.download(up.dataHash, { size: file.size })
  const back = await hashBlob(down.blob, info.chunkSize)
  step('download', { bytes: down.blob.size, resumes: down.resumes, sameHash: back.dataHash === up.dataHash })

  t = performance.now()
  const del1 = await client.delete(key, up.dataHash)
  const del2 = await client.delete(key, rootUp.dataHash)
  const after = await client.list(key.address)
  step('delete', { deleted: [del1.deletedAt > 0, del2.deletedAt > 0], left: after.files.length })
  Date.now = realNow
  out.fitsWidth = document.documentElement.scrollWidth <= innerWidth
  return out
}

async function run(engine, label, viewport, partChunks) {
  console.log(`${at()} ---- ${label}`)
  const browser = await engine.launch()
  const context = await browser.newContext({ viewport, ...(viewport.width < 500 ? { isMobile: true, hasTouch: true } : {}) })
  const net = { puts: 0, dropped: 0, cut: 0, corsBlocked: 0 }
  await context.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/v2.js') return route.fulfill({ contentType: 'text/javascript', body: bundle })
    return route.fulfill({ contentType: 'text/html', body: html })
  })
  // drop the connection under two parts, and cut the big download after 3 MiB, once
  await context.route(`${V2_TESTNET.relayer}/**`, async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (req.method() === 'PUT' && /\/chunks\//.test(url.pathname)) {
      net.puts++
      if (net.puts === 2 || net.puts === 4) {
        net.dropped++
        return route.abort('connectionreset')
      }
    }
    if (req.method() === 'GET' && /^\/v1\/files\/[0-9a-f]{64}$/.test(url.pathname) && !req.headers().range && net.cut === 0 && net.puts > 0) {
      const res = await route.fetch()
      const body = await res.body()
      if (body.length > 4 << 20) {
        net.cut++
        return route.fulfill({ response: res, body: body.subarray(0, 3 << 20) })
      }
      return route.fulfill({ response: res, body })
    }
    return route.continue()
  })
  const page = await context.newPage()
  page.on('console', (m) => /CORS|Access-Control/i.test(m.text()) && net.corsBlocked++)
  try {
    await page.goto(ORIGIN + '/')
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready')
    const out = await page.evaluate(inPage, { recoverySig, mib: MiB, partChunks })
    const s = Object.fromEntries(out.steps.map((x) => [x.name, x]))
    const mbps = (x) => ((x.bytes / 1048576) / (x.ms / 1000)).toFixed(1)
    check(`${label}: the page derives the storage account`, out.account === account, out.account)
    check(`${label}: upload, through two dropped connections and a 30-minute clock skew`,
      !!s.upload.fileId && !s.upload.dedup && net.dropped === 2,
      `${(s.upload.bytes / 1048576).toFixed(1)} MiB in ${(s.upload.ms / 1000).toFixed(1)} s (${mbps(s.upload)} MiB/s), ${s.upload.partRequests} part requests, ${s.upload.signatures} signature(s)`)
    check(`${label}: the same bytes again are a dedup`, s['upload again'].dedup === true, `${s['upload again'].ms} ms`)
    check(`${label}: the root uploads`, !!s['root upload'].dataHash, `${s['root upload'].ms} ms`)
    check(`${label}: the listing's newest file is the root, and it names the file`, s['find root'].newestIsRoot && s['find root'].rootNamesFile,
      `${s['find root'].ms} ms, ${s['find root'].listed.length} listed`)
    check(`${label}: the download, cut after 3 MiB, resumes and hashes the same`,
      s.download.sameHash && s.download.resumes === 1 && net.cut === 1,
      `${(s.download.ms / 1000).toFixed(1)} s (${mbps(s.download)} MiB/s), ${s.download.resumes} resume(s)`)
    check(`${label}: both deleted, the listing is empty`, s.delete.deleted.every(Boolean) && s.delete.left === 0, `${s.delete.ms} ms`)
    // the browser makes the preflights itself, out of the routes' sight: every call above answering is the proof
    check(`${label}: no call blocked by CORS`, net.corsBlocked === 0)
    if (viewport.width < 500) check(`${label}: the page fits the phone`, out.fitsWidth)
  } catch (e) {
    failed++
    console.log(`${at()} ERROR ${label}: ${e.message.split('\n').slice(0, 3).join(' | ')}`)
  } finally {
    await browser.close()
  }
}

await run(webkit, 'WebKit, phone', { width: 390, height: 844 }, 4)
await run(chromium, 'Chromium, desktop', { width: 1280, height: 900 }, 16)
balance = await storageBalance(V2_TESTNET, account)
console.log(`${at()} storage balance after: ${ethers.formatEther(balance)} 0G`)
console.log(failed ? `${failed} FAILED` : 'V2 RELAYER POC PASSED ✓')
process.exitCode = failed ? 1 : 0
