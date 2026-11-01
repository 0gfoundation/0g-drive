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

// ─── The client ───────────────────────────────────────────────────────

let client: UniversalProvider | null = null
let loading: Promise<UniversalProvider> | null = null
let defaultChain = NETWORKS[0].chainId
let cancelConnect: (() => void) | null = null

const handlers = new Map<string, Set<(arg: never) => void>>()
const emit = (event: string, arg: unknown) => handlers.get(event)?.forEach((h) => h(arg as never))

/** The app's network: the chain requests go to. */
export function setWalletConnectNetwork(network: NetworkConfig): void {
  defaultChain = network.chainId
}

const INIT_TIMEOUT_MS = 20_000

function load(): Promise<UniversalProvider> {
  loading ??= (async () => {
    const { default: Provider } = await import('@walletconnect/universal-provider')
    const init = Provider.init({
      projectId: PROJECT_ID,
      telemetryEnabled: false,
      logger: 'error',
      metadata: {
        name: '0GDrive',
        description: 'Your encrypted drive on 0G Storage',
        url: location.origin,
        icons: [`${location.origin}/0g-webclip.png`],
        // no redirect: a wallet would open it as a new page, leaving the
        // user's tab (and its uploads) behind; they switch back themselves
      },
    })
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('WalletConnect didn’t answer. Check your connection and try again.')), INIT_TIMEOUT_MS)
    )
    const p = await Promise.race([init, timeout])
    p.on('display_uri', (uri: string) => setState({ uri }))
    p.on('accountsChanged', (accounts: string[]) => emit('accountsChanged', accounts))
    p.on('chainChanged', (chain: string | number) => {
      // the provider also reports its own default-chain bookkeeping
      if (Number(chain) !== defaultChain) emit('chainChanged', `0x${Number(chain).toString(16)}`)
    })
    // ended in the wallet: like an extension revoking this site
    p.on('session_delete', () => {
      setState({ peer: null })
      emit('accountsChanged', [])
    })
    client = p
    if (p.session) useAppChain(p)
    setState({ peer: p.session?.peer.metadata.name ?? null })
    return p
  })()
  loading.catch(() => (loading = null))
  return loading
}

/** Pair with a wallet: shows the QR code / app links until it approves or the user cancels. */
async function connect(p: UniversalProvider): Promise<void> {
  const rpcMap = Object.fromEntries(NETWORKS.flatMap((n) => [[`${n.chainId}`, n.rpcUrl], [`eip155:${n.chainId}`, n.rpcUrl]]))
  const chains = [defaultChain, ...NETWORKS.map((n) => n.chainId).filter((c) => c !== defaultChain)]
  const cancelled = new Promise<never>((_, reject) => {
    cancelConnect = () => reject(Object.assign(new Error('Connection cancelled'), { code: 4001 }))
  })
  try {
    await Promise.race([
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
    cancelConnect = null
    setState({ uri: null, waitingFor: null })
  }
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

function chainOf(p: UniversalProvider): string {
  // the session may list chains in the wallet's order: ask for the app's
  const approved = Object.values(p.session?.namespaces ?? {}).flatMap((ns) => ns.chains ?? ns.accounts.map((a) => a.split(':').slice(0, 2).join(':')))
  const want = `eip155:${defaultChain}`
  return approved.includes(want) ? want : (approved[0] ?? want)
}

/** Point the provider's own default chain at the app's (eth_chainId, eth_accounts follow it). */
function useAppChain(p: UniversalProvider): void {
  // not approved: left alone, ensureNetwork asks the wallet to switch
  // (moving to another chain here would fire chainChanged → a reload)
  if (chainOf(p) === `eip155:${defaultChain}`) p.setDefaultChain(chainOf(p))
}

async function request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
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
  if (!WALLET_METHODS.includes(method)) return p.request({ method, params }, chainOf(p))
  setState({ pending: state.pending + 1 })
  try {
    return await p.request({ method, params }, chainOf(p))
  } finally {
    setState({ pending: state.pending - 1 })
  }
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
