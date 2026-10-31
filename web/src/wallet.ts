import { ethers } from 'ethers'
import type { NetworkConfig } from '@0gdrive/core'

/** An EIP-1193 wallet provider (an extension's `window.ethereum`). */
export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
  on?(event: string, handler: (arg: never) => void): void
  removeListener?(event: string, handler: (arg: never) => void): void
  isMetaMask?: boolean
}

declare global {
  interface Window {
    ethereum?: Eip1193
  }
}

export interface WalletState {
  address: string
  balance: string // 0G
  chainId: number
  signer: ethers.JsonRpcSigner
}

// ─── Discovery (EIP-6963) ─────────────────────────────────────────────
// Each installed extension announces itself, so with several installed the
// user picks one instead of getting whichever claimed window.ethereum.
// Wallets that don't announce still work through window.ethereum.

export interface WalletOption {
  id: string // EIP-6963 rdns (e.g. io.metamask), or 'injected'
  name: string
  icon?: string // data:image/… URI from the wallet itself
  provider: Eip1193
}

interface AnnounceDetail {
  info: { uuid: string; name: string; icon: string; rdns: string }
  provider: Eip1193
}

const announced = new Map<string, WalletOption>()
const changeListeners = new Set<() => void>()
let snapshot: WalletOption[] = []
const LAST_KEY = '0gdrive:wallet'

export function lastUsedWallet(): string | null {
  try {
    return localStorage.getItem(LAST_KEY)
  } catch {
    return null
  }
}

function rebuild(notify = true): void {
  const list = [...announced.values()]
  if (list.length === 0 && typeof window !== 'undefined' && window.ethereum) {
    list.push({ id: 'injected', name: window.ethereum.isMetaMask ? 'MetaMask' : 'Browser wallet', provider: window.ethereum })
  }
  const last = lastUsedWallet()
  snapshot = list.sort((a, b) => Number(b.id === last) - Number(a.id === last) || a.name.localeCompare(b.name))
  if (notify) changeListeners.forEach((l) => l())
}

if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', (e) => {
    const { info, provider } = (e as CustomEvent<AnnounceDetail>).detail ?? {}
    if (!info?.rdns || typeof info.name !== 'string' || typeof provider?.request !== 'function') return
    announced.set(info.rdns, {
      id: info.rdns,
      name: info.name.slice(0, 40),
      // only image data URIs: an <img> can't run script from those
      icon: typeof info.icon === 'string' && info.icon.startsWith('data:image/') ? info.icon : undefined,
      provider,
    })
    rebuild()
  })
  window.dispatchEvent(new Event('eip6963:requestProvider'))
  rebuild()
}

/** Installed wallets, the last-used one first. */
export function walletOptions(): WalletOption[] {
  // a wallet that injects window.ethereum after this module loaded
  if (snapshot.length === 0 && typeof window !== 'undefined' && window.ethereum) rebuild(false)
  return snapshot
}

/** walletOptions() without the late-injection check, for useSyncExternalStore. */
export function walletSnapshot(): WalletOption[] {
  return snapshot
}

export function subscribeWallets(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

export function hasWallet(): boolean {
  return walletOptions().length > 0
}

// ─── Choosing one ─────────────────────────────────────────────────────
// chooseWallet() resolves directly with one wallet installed; with several
// it opens <WalletPicker> and resolves with the choice (null if dismissed).

let pending: ((w: WalletOption | null) => void) | null = null
const pickerListeners = new Set<() => void>()

export function chooseWallet(): Promise<WalletOption | null> {
  const options = walletOptions()
  if (options.length <= 1) return Promise.resolve(options[0] ?? null)
  pending?.(null)
  return new Promise((resolve) => {
    pending = resolve
    pickerListeners.forEach((l) => l())
  })
}

export function pickerOpen(): boolean {
  return pending !== null
}

export function subscribePicker(listener: () => void): () => void {
  pickerListeners.add(listener)
  return () => pickerListeners.delete(listener)
}

/** Called by <WalletPicker>. */
export function resolvePicker(choice: WalletOption | null): void {
  const resolve = pending
  pending = null
  pickerListeners.forEach((l) => l())
  resolve?.(choice)
}

// ─── The active wallet ────────────────────────────────────────────────

let active: Eip1193 | null = null
const accountHandlers = new Set<(accounts: string[]) => void>()
const chainHandlers = new Set<(chainId: string) => void>()
const onAccounts = (a: string[]) => accountHandlers.forEach((h) => h(a))
const onChain = (c: string) => chainHandlers.forEach((h) => h(c))

/** Make `option` the wallet the app talks to, and remember it. */
export function selectWallet(option: WalletOption): Eip1193 {
  if (active !== option.provider) {
    active?.removeListener?.('accountsChanged', onAccounts as never)
    active?.removeListener?.('chainChanged', onChain as never)
    active = option.provider
    active.on?.('accountsChanged', onAccounts as never)
    active.on?.('chainChanged', onChain as never)
  }
  try {
    localStorage.setItem(LAST_KEY, option.id)
  } catch {
    // per-browser convenience only
  }
  return active
}

/** The connected wallet's provider. */
export function activeProvider(): Eip1193 | null {
  return active
}

/** Pick a wallet (if several), connect it and switch it to `network`. */
export async function connectWallet(
  network: NetworkConfig
): Promise<WalletState | null> {
  if (!hasWallet()) {
    throw new Error('No Ethereum wallet detected. Install a wallet extension such as MetaMask or Rabby to use 0GDrive.')
  }
  const option = await chooseWallet()
  if (!option) return null
  const eth = selectWallet(option)
  const provider = new ethers.BrowserProvider(eth)
  await provider.send('eth_requestAccounts', [])
  setDisconnected(false)
  await ensureNetwork(network, eth, provider)
  const signer = await provider.getSigner()
  return await readWalletState(signer, network)
}

// ─── Staying connected, switching, disconnecting ──────────────────────
// Any change of wallet or account reloads the page: everything the app
// holds belongs to one account (drive, key, recovery state, open dialogs,
// uploads), and a fresh page is the one reset that can't miss any of it.
// The reload then reconnects quietly (reconnectWallet).

const DISCONNECTED_KEY = '0gdrive:disconnected'

function setDisconnected(on: boolean): void {
  try {
    if (on) localStorage.setItem(DISCONNECTED_KEY, '1')
    else localStorage.removeItem(DISCONNECTED_KEY)
  } catch {
    // per-browser convenience only
  }
}

/**
 * Reconnect the last-used wallet without a prompt, if it still lets this
 * site see an account (eth_accounts never opens the wallet) and is on
 * `network` (switching would prompt — that's left to "Connect wallet").
 * Null after "Disconnect", or when there's nothing to reconnect.
 */
export async function reconnectWallet(network: NetworkConfig): Promise<WalletState | null> {
  try {
    if (localStorage.getItem(DISCONNECTED_KEY)) return null
  } catch {
    return null
  }
  const last = lastUsedWallet()
  if (!last) return null
  let option = walletOptions().find((o) => o.id === last)
  if (!option) {
    // extensions announce themselves just after the page loads
    await new Promise((r) => setTimeout(r, 300))
    option = walletOptions().find((o) => o.id === last)
  }
  if (!option) return null
  const accounts = (await option.provider.request({ method: 'eth_accounts' })) as string[] | undefined
  if (!accounts?.length) return null
  if (Number(await option.provider.request({ method: 'eth_chainId' })) !== network.chainId) return null
  const eth = selectWallet(option)
  const signer = await new ethers.BrowserProvider(eth).getSigner(accounts[0])
  return await readWalletState(signer, network)
}

/**
 * Let the user pick a wallet (if several) and an account in it, then
 * reload into that account. Resolves false when they cancel or keep the
 * same wallet and account (nothing to do).
 */
export async function switchWallet(network: NetworkConfig, current: string): Promise<boolean> {
  const option = await chooseWallet()
  if (!option) return false
  let accounts: string[]
  try {
    // asks the wallet to show its account choice (MetaMask, Rabby, …)
    await option.provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] })
    accounts = (await option.provider.request({ method: 'eth_accounts' })) as string[]
  } catch (err) {
    if ((err as { code?: number }).code === 4001) return false // closed the wallet's window
    // no permissions API: a plain connect request
    accounts = (await option.provider.request({ method: 'eth_requestAccounts' })) as string[]
  }
  if (!accounts?.length) return false
  if (option.provider === active && accounts[0].toLowerCase() === current.toLowerCase()) return false
  const eth = selectWallet(option)
  await ensureNetwork(network, eth, new ethers.BrowserProvider(eth))
  setDisconnected(false)
  location.reload()
  return true
}

/** Forget the connection on this device (and in the wallet, where it lets
 *  a site do that), then reload to the start screen. */
export async function disconnectWallet(): Promise<void> {
  setDisconnected(true)
  try {
    await active?.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] })
  } catch {
    // not supported by every wallet: the flag above keeps this device disconnected
  }
  location.reload()
}

export async function readWalletState(
  signer: ethers.JsonRpcSigner,
  network: NetworkConfig
): Promise<WalletState> {
  const address = await signer.getAddress()
  const provider = signer.provider as ethers.BrowserProvider
  const networkInfo = await provider.getNetwork()
  const balanceWei = await provider.getBalance(address)
  if (Number(networkInfo.chainId) !== network.chainId) {
    throw new Error(
      `Wallet is on chain ${networkInfo.chainId}, expected ${network.chainId} (${network.chainName}).`
    )
  }
  return {
    address,
    balance: ethers.formatEther(balanceWei),
    chainId: Number(networkInfo.chainId),
    signer,
  }
}

async function ensureNetwork(
  network: NetworkConfig,
  eth: Eip1193,
  provider: ethers.BrowserProvider
): Promise<void> {
  const current = await provider.getNetwork()
  if (Number(current.chainId) === network.chainId) return

  try {
    await eth.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: network.chainIdHex }],
    })
  } catch (err) {
    const code = (err as { code?: number }).code
    if (code === 4902 || code === -32603) {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: network.chainIdHex,
            chainName: network.chainName,
            nativeCurrency: network.nativeCurrency,
            rpcUrls: [network.rpcUrl],
            blockExplorerUrls: [network.explorerTxUrl.replace(/\/tx\/$/, '')],
          },
        ],
      })
    } else {
      throw err
    }
  }
}

/** Account changes in the active wallet (follows a later wallet switch). */
export function onAccountsChanged(handler: (accounts: string[]) => void): () => void {
  accountHandlers.add(handler)
  return () => accountHandlers.delete(handler)
}

export function onChainChanged(handler: (chainId: string) => void): () => void {
  chainHandlers.add(handler)
  return () => chainHandlers.delete(handler)
}
