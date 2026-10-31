import { rpcProvider, type NetworkConfig } from '@0gdrive/core'
import type { Eip1193 } from './wallet'

// Opening a connection to the RPC can cost far more than using one: a user
// measured 2.1 s of DNS + TCP + TLS before a 0.26 s request. Browsers (and
// the server) close idle connections, so an action after a pause paid the
// whole setup before its wallet prompt — and the wallet paid it again for
// its own gas and fee requests. A tiny read-only request every 20 s, while
// the page is visible, keeps both connections open, and keeps an extension
// wallet's background worker from being suspended. Never a prompt.

const INTERVAL_MS = 20_000

/** Look up and connect to the RPC as the page loads. */
export function preconnect(network: NetworkConfig): void {
  const origin = new URL(network.rpcUrl).origin
  for (const rel of ['dns-prefetch', 'preconnect']) {
    const link = document.createElement('link')
    link.rel = rel
    link.href = origin
    link.crossOrigin = 'anonymous' // the RPC calls are CORS fetches
    document.head.appendChild(link)
  }
}

/** Ping the RPC directly and through `wallet` every 20 s while the page is
 *  visible, and right away when it becomes visible again. Returns a stop. */
export function keepConnectionsWarm(network: NetworkConfig, wallet: () => Eip1193 | null): () => void {
  const ping = () => {
    if (document.visibilityState !== 'visible') return
    rpcProvider(network).getBlockNumber().catch(() => undefined)
    wallet()?.request({ method: 'eth_blockNumber' }).catch(() => undefined)
  }
  const timer = setInterval(ping, INTERVAL_MS)
  document.addEventListener('visibilitychange', ping)
  return () => {
    clearInterval(timer)
    document.removeEventListener('visibilitychange', ping)
  }
}
