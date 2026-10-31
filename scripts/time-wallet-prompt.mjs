// Usage: node scripts/time-wallet-prompt.mjs (testnet; funds a throwaway wallet from .env PRIVATE_KEY, refunds it)
// Times everything that happens before the wallet is asked to sign, for
// a 1-item action (folder rename) and a 2-item action (file move into a
// new folder). A fresh funded wallet builds a small drive; then the signer
// is "armed": its next sendTransaction records the time and aborts.
import { ethers } from 'ethers'
import axios from 'axios'
import { readFileSync } from 'node:fs'
import { DriveStore, getNetworkConfig } from '../core/dist/index.js'
import { refund } from './lib/refund.mjs'

const funderKey = /^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(readFileSync(new URL('../.env', import.meta.url), 'utf8'))[1]
const network = getNetworkConfig('testnet', 'turbo')
const provider = new ethers.JsonRpcProvider(network.rpcUrl)
const funder = new ethers.Wallet(funderKey, provider)

// log every HTTP call (JSON-RPC method or storage-node method) with timing
let t0 = 0, log = null
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const start = performance.now()
  let what = String(url).replace(/^https?:\/\//, '').slice(0, 40)
  try {
    const body = JSON.parse(init?.body ?? 'null')
    const methods = (Array.isArray(body) ? body : [body]).map((b) => b?.method).filter(Boolean)
    if (methods.length) what += ' ' + methods.join(',')
  } catch {}
  try { return await realFetch(url, init) } finally {
    if (log) log.push(`${String(Math.round(start - t0)).padStart(6)}ms +${String(Math.round(performance.now() - start)).padStart(5)}ms  ${what}`)
  }
}

const fileMeta = (id, name) => ({ id, name, size: 1024, mime: 'application/pdf', uploadedAt: Date.now(),
  encryption: 'aes256', rootHashes: ['0x' + 'ab'.repeat(32)], txHashes: ['0x' + 'cd'.repeat(32)], network: 'testnet:turbo' })
const record = (start, what) => { if (log) log.push(`${String(Math.round(start - t0)).padStart(6)}ms +${String(Math.round(performance.now() - start)).padStart(5)}ms  ${what}`) }
const describe = (url, body) => {
  let what = String(url).replace(/^https?:\/\//, '').slice(0, 28)
  try {
    const b = typeof body === 'string' ? JSON.parse(body) : body instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(body)) : body
    const m = (Array.isArray(b) ? b : [b]).map((x) => x?.method).filter(Boolean)
    if (m.length) what += ' ' + m.join(',')
  } catch {}
  return what
}
const baseGet = ethers.FetchRequest.createGetUrlFunc()
ethers.FetchRequest.registerGetUrl(async (req, signal) => {
  const start = performance.now()
  try { return await baseGet(req, signal) } finally { record(start, describe(req.url, req.body)) }
})
axios.interceptors.request.use((c) => { c.metadata = performance.now(); return c })
axios.interceptors.response.use((r) => { record(r.config.metadata, describe(r.config.url, r.config.data)); return r })
let armed = false
class ArmedWallet extends ethers.Wallet {
  async sendTransaction(tx) {
    if (armed) { armed = false; throw new Error(`PROMPT@${Math.round(performance.now() - t0)}`) }
    return super.sendTransaction(tx)
  }
}
const wallet = new ArmedWallet(ethers.Wallet.createRandom().privateKey, provider)
await (await funder.sendTransaction({ to: wallet.address, value: ethers.parseEther('0.3') })).wait()
console.log('funded', wallet.address)

const masterKey = crypto.getRandomValues(new Uint8Array(32))
let cache = { events: [], toBlock: (await provider.getBlockNumber()) - 5 }
const store = new DriveStore(network, wallet, masterKey, {
  eventCache: { load: () => cache, save: (events, toBlock) => { cache = { events, toBlock } } },
})
try {
  await store.createFolder('Docs')
  await store.putFileRecords('Inbox', [fileMeta('f1', 'a.pdf')])
  console.log('drive built')

  async function timed(label, fn) {
    log = []; t0 = performance.now(); armed = true
    try { await fn(); console.log(label, 'NO PROMPT?') } catch (e) {
      console.log(`\n== ${label}: wallet prompt after ${e.message.startsWith('PROMPT@') ? e.message.slice(7) + ' ms' : 'ERROR ' + e.message}`)
    }
    armed = false
    console.log(log.join('\n')); log = null
  }
  await timed('rename folder (1 item)', () => store.renameFolder('Docs', 'Docs2'))
  await timed('rename folder again', () => store.renameFolder('Docs', 'Docs3'))
  await timed('move file into a new folder (index + 2 folders, batch)', () =>
    store.moveRecords('Inbox', [{ id: 'f1', to: 'New' }]))
  await timed('trash folder (index + trash, batch)', () => store.trashFolder('Inbox'))
} finally {
  await refund(wallet, funder.address)
}
