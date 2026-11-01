// WalletConnect: a wallet on another device (or in an app on this phone)
// approves for this page through WalletConnect's relay. It's offered as one
// more entry in the wallet picker, an EIP-1193 provider like an extension's,
// so the rest of the app doesn't know the difference.
//
// We use WalletConnect's plain protocol client (@walletconnect/universal-
// provider), not Reown's AppKit modal: no analytics, a few hundred kB less,
// and our own QR code and wallet list (WalletConnectDialog). The library
// loads only when this option is used (picked, or reconnecting a session).
// Reads (balances, receipts…) go to our own RPC, not WalletConnect's; only
// requests that need the wallet go through the relay.
//
// Needs VITE_WALLETCONNECT_PROJECT_ID (from dashboard.reown.com). Without it
// the option isn't offered.

import { getNetworkConfig, type NetworkConfig } from '@0gdrive/core'
import type { Eip1193, WalletOption } from './wallet'

type UniversalProvider = import('@walletconnect/universal-provider').default

export const WALLETCONNECT_ID = 'walletconnect'
const PROJECT_ID = (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined)?.trim() || ''

export function walletConnectAvailable(): boolean {
  return PROJECT_ID !== ''
}

// requests the wallet itself answers (everything else is a plain RPC read)
const WALLET_METHODS = [
  'eth_sendTransaction',
  'personal_sign',
  'eth_signTypedData_v4',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
]
const NETWORKS = [getNetworkConfig('testnet', 'turbo'), getNetworkConfig('mainnet', 'turbo')]

// ─── Wallet apps (phone) ──────────────────────────────────────────────
// On a phone there's nothing to scan: a link hands the connection to the
// wallet app. Links are the wallets' own universal links, as listed in
// WalletConnect's wallet registry (explorer-api.walletconnect.com/v3/wallets,
// mobile.universal; checked 2026-11-01): `${link}/wc?uri=…` connects;
// `${link}` alone brings the app forward to approve a request. (OKX isn't
// here: its registry link has a non-standard form we couldn't verify; it
// pairs through "Copy the connection link".)

export interface WalletApp {
  id: string
  name: string
  link: string
}

export const WALLET_APPS: WalletApp[] = [
  { id: 'metamask', name: 'MetaMask', link: 'https://metamask.app.link' },
  { id: 'trust', name: 'Trust Wallet', link: 'https://link.trustwallet.com' },
  { id: 'binance', name: 'Binance Wallet', link: 'https://app.binance.com/cedefi' },
  { id: 'bitget', name: 'Bitget Wallet', link: 'https://bkapp.vip' },
]

export function connectLink(app: WalletApp, uri: string): string {
  return `${app.link}/wc?uri=${encodeURIComponent(uri)}`
}

const APP_KEY = '0gdrive:wc-app'

function rememberApp(id: string | null): void {
  try {
    if (id) localStorage.setItem(APP_KEY, id)
    else localStorage.removeItem(APP_KEY)
  } catch {
    // per-browser convenience only
  }
}

// ─── State the dialog shows ───────────────────────────────────────────

export interface WcState {
  /** connecting: the pairing link to show as a QR code / hand to an app */
  uri: string | null
  /** connecting, after the user picked a wallet app on this phone */
  waitingFor: string | null
  /** requests sent to the wallet and not answered yet */
  pending: number
  /** the connected wallet's name, as it reports it */
  peer: string | null
}

let state: WcState = { uri: null, waitingFor: null, pending: 0, peer: null }
const listeners = new Set<() => void>()

function setState(patch: Partial<WcState>): void {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export function wcState(): WcState {
  return state
}

export function subscribeWc(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Where "Open wallet" goes to approve a request: the wallet's own link back, else the app picked. */
export function walletAppLink(): string | null {
  const meta = client?.session?.peer.metadata
  const own = meta?.redirect?.universal || meta?.redirect?.native
  if (own) return own
  try {
    const id = localStorage.getItem(APP_KEY)
    return WALLET_APPS.find((a) => a.id === id)?.link ?? null
  } catch {
    return null
  }
}

// ─── Diagnostics (?debug=wc) ──────────────────────────────────────────
// A phone has no console to read: with ?debug=wc in the address the page
// shows WalletConnect's own log and ours (WalletConnectDebug), so a
// screenshot says where a connection stops.

const DEBUG = typeof location !== 'undefined' && new URLSearchParams(location.search).get('debug') === 'wc'
const debugLines: string[] = []
const debugStart = Date.now()

export function wcDebugEnabled(): boolean {
  return DEBUG
}

export function wcDebugLog(): readonly string[] {
  return debugLines
}

function trace(msg: string): void {
  if (!DEBUG) return
  debugLines.push(`${((Date.now() - debugStart) / 1000).toFixed(1)}s ${msg}`)
  if (debugLines.length > 300) debugLines.shift()
  listeners.forEach((l) => l())
}

if (DEBUG) {
  // the library logs through the console
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      trace(`[${level}] ${args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ').slice(0, 400)}`)
    }
  }
}

function safeJson(value: unknown): string {
  try {
    return value instanceof Error ? `${value.name}: ${value.message}` : JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// ─── Starting over ────────────────────────────────────────────────────
// What WalletConnect saves in this browser can get stuck: on an iPhone
// (Chrome) connecting hung before any pairing link, while a private tab
// (nothing saved) worked. "Start a new connection" clears it, only it.

const WC_DB = 'WALLET_CONNECT_V2_INDEXED_DB'
const WC_STORE = 'keyvaluestorage'

/** Forget everything WalletConnect saved in this browser (the next connect pairs from scratch). */
export async function resetWalletConnect(): Promise<void> {
  trace('reset: clearing saved WalletConnect data')
  try {
    // older versions kept it in localStorage
    for (const key of Object.keys(localStorage)) if (key.startsWith('wc@')) localStorage.removeItem(key)
  } catch {
    // not available: nothing saved there
  }
  rememberApp(null)
  await new Promise<void>((resolve) => {
    // a stuck database mustn't hold the reset either
    const done = setTimeout(resolve, 3000)
    const finish = () => {
      clearTimeout(done)
      resolve()
    }
    try {
      const open = indexedDB.open(WC_DB)
      // no database yet: nothing to clear (and don't create one)
      open.onupgradeneeded = () => open.transaction?.abort()
      open.onerror = finish
      open.onblocked = finish
      open.onsuccess = () => {
        const db = open.result
        if (!db.objectStoreNames.contains(WC_STORE)) {
          db.close()
          return finish()
        }
        const tx = db.transaction(WC_STORE, 'readwrite')
        tx.objectStore(WC_STORE).clear()
        tx.oncomplete = tx.onerror = tx.onabort = () => {
          trace(`reset: saved data cleared (${tx.error ? `error ${tx.error.message}` : 'ok'})`)
          db.close()
          finish()
        }
      }
    } catch {
      finish()
    }
  })
}

// ─── The client ───────────────────────────────────────────────────────

let client: UniversalProvider | null = null
let loading: Promise<UniversalProvider> | null = null
let defaultChain = NETWORKS[0].chainId
let cancelConnect: (() => void) | null = null
let linkTimer: ReturnType<typeof setTimeout> | undefined

const handlers = new Map<string, Set<(arg: never) => void>>()
const emit = (event: string, arg: unknown) => handlers.get(event)?.forEach((h) => h(arg as never))

/** The app's network: the chain requests go to. */
export function setWalletConnectNetwork(network: NetworkConfig): void {
  defaultChain = network.chainId
}

const INIT_TIMEOUT_MS = 20_000
// a pairing link normally comes within a second or two
const LINK_TIMEOUT_MS = 20_000

/** WalletConnect itself didn't get going: "Start a new connection" is the way out. */
export const WC_STUCK = 'WC_STUCK'

function stuck(message: string): Error {
  trace(`stuck: ${message}`)
  return Object.assign(new Error(message), { code: WC_STUCK })
}

function load(): Promise<UniversalProvider> {
  loading ??= (async () => {
    trace('loading the WalletConnect library')
    const { default: Provider } = await import('@walletconnect/universal-provider')
    trace('starting WalletConnect')
    const init = Provider.init({
      projectId: PROJECT_ID,
      telemetryEnabled: false,
      logger: DEBUG ? 'debug' : 'error',
      metadata: {
        name: '0GDrive',
        description: 'Your encrypted drive on 0G Storage',
        url: location.origin,
        icons: [`${location.origin}/0g-webclip.png`],
        // no redirect: a wallet would open it as a new page, leaving the
        // user's tab (and its uploads) behind; they switch back themselves
      },
    })
    let initTimer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      initTimer = setTimeout(() => reject(stuck('WalletConnect didn’t start.')), INIT_TIMEOUT_MS)
    })
    const p = await Promise.race([init, timeout]).finally(() => clearTimeout(initTimer))
    const s = p.session
    trace(s ? `started; saved session with ${s.peer.metadata.name}, chains ${chainsOf(s.namespaces).join(' ')}, expires ${new Date(s.expiry * 1000).toISOString()}` : 'started; no saved session')
    const relayer = p.client?.core.relayer
    relayer?.on('relayer_connect', () => trace('relay connected'))
    relayer?.on('relayer_disconnect', () => trace('relay disconnected'))
    relayer?.on('relayer_error', (e: unknown) => trace(`relay error ${safeJson(e)}`))
    p.on('display_uri', (uri: string) => {
      trace('pairing link ready')
      clearTimeout(linkTimer)
      setState({ uri })
    })
    p.on('accountsChanged', (accounts: string[]) => emit('accountsChanged', accounts))
    p.on('chainChanged', (chain: string | number) => {
      // the provider also reports its own default-chain bookkeeping
      if (Number(chain) !== defaultChain) emit('chainChanged', `0x${Number(chain).toString(16)}`)
    })
    // ended in the wallet: like an extension revoking this site
    p.on('session_delete', () => {
      trace('session ended by the wallet')
      setState({ peer: null })
      emit('accountsChanged', [])
    })
    client = p
    if (p.session) useAppChain(p)
    setState({ peer: p.session?.peer.metadata.name ?? null })
    return p
  })()
  loading.catch((e) => {
    trace(`start failed: ${safeJson(e)}`)
    loading = null
  })
  return loading
}

/** Pair with a wallet: shows the QR code / app links until it approves or the user cancels. */
async function connect(p: UniversalProvider): Promise<void> {
  const rpcMap = Object.fromEntries(NETWORKS.flatMap((n) => [[`${n.chainId}`, n.rpcUrl], [`eip155:${n.chainId}`, n.rpcUrl]]))
  const chains = [defaultChain, ...NETWORKS.map((n) => n.chainId).filter((c) => c !== defaultChain)]
  const cancelled = new Promise<never>((_, reject) => {
    cancelConnect = () => reject(Object.assign(new Error('Connection cancelled'), { code: 4001 }))
  })
  const noLink = new Promise<never>((_, reject) => {
    linkTimer = setTimeout(() => reject(stuck('WalletConnect didn’t start the connection.')), LINK_TIMEOUT_MS)
  })
  trace('pairing: asking for a link')
  try {
    await Promise.race([
      noLink,
      p.connect({
        optionalNamespaces: {
          eip155: {
            chains: chains.map((c) => `eip155:${c}`),
            methods: WALLET_METHODS,
            events: ['chainChanged', 'accountsChanged'],
            rpcMap,
          },
        },
      }),
      cancelled,
    ])
  } finally {
    clearTimeout(linkTimer)
    cancelConnect = null
    setState({ uri: null, waitingFor: null })
  }
  trace(`paired with ${p.session?.peer.metadata.name}, chains ${chainsOf(p.session?.namespaces).join(' ')}`)
  useAppChain(p)
  const peer = p.session?.peer.metadata.name ?? 'Wallet'
  setState({ peer })
  const app = WALLET_APPS.find((a) => peer.toLowerCase().includes(a.name.split(' ')[0].toLowerCase()))
  if (app) rememberApp(app.id)
}

/** Called by the dialog: the user closed it. */
export function cancelWalletConnect(): void {
  cancelConnect?.()
}

/** Called by the dialog: the user tapped a wallet app's link on this phone. */
export function connectingVia(app: WalletApp): void {
  rememberApp(app.id)
  setState({ waitingFor: app.name })
}

async function disconnect(p: UniversalProvider): Promise<void> {
  if (!p.session) return
  try {
    await p.disconnect()
  } catch {
    // already gone on the wallet's side
  }
  setState({ peer: null })
}

type Namespaces = NonNullable<UniversalProvider['session']>['namespaces']

function chainsOf(namespaces: Namespaces | undefined): string[] {
  return Object.values(namespaces ?? {}).flatMap((ns) => ns.chains ?? ns.accounts.map((a) => a.split(':').slice(0, 2).join(':')))
}

function chainOf(p: UniversalProvider): string {
  // the session may list chains in the wallet's order: ask for the app's
  const approved = chainsOf(p.session?.namespaces)
  const want = `eip155:${defaultChain}`
  return approved.includes(want) ? want : (approved[0] ?? want)
}

/** Point the provider's own default chain at the app's (eth_chainId, eth_accounts follow it). */
function useAppChain(p: UniversalProvider): void {
  // not approved: left alone, ensureNetwork asks the wallet to switch
  // (moving to another chain here would fire chainChanged → a reload)
  if (chainOf(p) === `eip155:${defaultChain}`) p.setDefaultChain(chainOf(p))
}

async function request(args: { method: string; params?: unknown[] }): Promise<unknown> {
  if (!DEBUG) return answer(args)
  trace(`→ ${args.method}`)
  try {
    const result = await answer(args)
    trace(`← ${args.method} ${safeJson(result).slice(0, 80)}`)
    return result
  } catch (e) {
    trace(`← ${args.method} failed: ${safeJson(e)}`)
    throw e
  }
}

async function answer({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
  const p = await load()
  switch (method) {
    case 'eth_accounts':
      return p.session ? p.request({ method }, chainOf(p)) : []
    case 'eth_chainId':
      return `0x${Number(p.session ? await p.request({ method }, chainOf(p)) : defaultChain).toString(16)}`
    case 'eth_requestAccounts':
      if (!p.session) await connect(p)
      return p.request({ method }, chainOf(p))
    case 'wallet_requestPermissions':
      // "Switch wallet or account": a fresh pairing, in which the wallet offers its accounts
      await disconnect(p)
      await connect(p)
      return [{ parentCapability: 'eth_accounts' }]
    case 'wallet_revokePermissions':
      await disconnect(p)
      rememberApp(null)
      return null
  }
  if (!p.session) throw Object.assign(new Error('Wallet not connected'), { code: 4100 })
  if (!WALLET_METHODS.includes(method)) {
    // A read: our own RPC. The library sends every method the wallet listed
    // to the wallet, and MetaMask lists reads (eth_getBalance, eth_call…);
    // in the background it never answers, so after a reload on an iPhone
    // the balance read hung the reconnect, then every connect.
    const rpc = NETWORKS.find((n) => `eip155:${n.chainId}` === chainOf(p))?.rpcUrl
    if (rpc) return readRpc(rpc, method, params)
    return p.request({ method, params }, chainOf(p))
  }
  setState({ pending: state.pending + 1 })
  try {
    return await p.request({ method, params }, chainOf(p))
  } finally {
    setState({ pending: state.pending - 1 })
  }
}

let rpcId = 0

async function readRpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  if (!res.ok) throw new Error(`RPC ${res.status} for ${method}`)
  const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } }
  // reverts keep their code and data, as ethers expects from a provider
  if (body.error) throw Object.assign(new Error(body.error.message), body.error)
  return body.result
}

const provider: Eip1193 = {
  request,
  on(event, handler) {
    let set = handlers.get(event)
    if (!set) handlers.set(event, (set = new Set()))
    set.add(handler)
  },
  removeListener(event, handler) {
    handlers.get(event)?.delete(handler)
  },
}

export const walletConnectOption: WalletOption = {
  id: WALLETCONNECT_ID,
  name: 'WalletConnect',
  provider,
}
