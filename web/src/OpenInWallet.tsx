// On a phone with no wallet in the browser, a way in: open this page in a
// wallet app's own browser, which has the wallet built in (our wallet code
// works there unchanged). Links are the wallets' documented ones:
//   MetaMask  https://link.metamask.io/dapp/{site without https://}
//             (docs.metamask.io → MetaMask Connect → Use deeplinks)
//   Trust     https://link.trustwallet.com/open_url?coin_id=60&url={url}
//             (developer.trustwallet.com → Deep linking)
//   OKX       https://web3.okx.com/download?deeplink={okx://wallet/dapp/url?dappUrl={url}}
//             (web3.okx.com → App universal link)
//   Coinbase  https://go.cb-w.com/dapp?cb_url={url}
//             (docs.cdp.coinbase.com → Wallet SDK → Deep link)
// Plain <a> links: universal links open the app only from a real tap.

import { useState } from 'react'

export interface WalletAppLink {
  name: string
  href: string
}

export function walletAppLinks(pageUrl: string): WalletAppLink[] {
  const enc = encodeURIComponent(pageUrl)
  return [
    { name: 'MetaMask', href: `https://link.metamask.io/dapp/${pageUrl.replace(/^https?:\/\//, '')}` },
    { name: 'Trust Wallet', href: `https://link.trustwallet.com/open_url?coin_id=60&url=${enc}` },
    {
      name: 'OKX Wallet',
      href: `https://web3.okx.com/download?deeplink=${encodeURIComponent(`okx://wallet/dapp/url?dappUrl=${enc}`)}`,
    },
    { name: 'Coinbase Wallet', href: `https://go.cb-w.com/dapp?cb_url=${enc}` },
  ]
}

/** A touch device (phone or tablet): no wallet extensions there. */
export function isTouchDevice(): boolean {
  try {
    return window.matchMedia('(pointer: coarse)').matches
  } catch {
    return false
  }
}

export function OpenInWallet() {
  const [copied, setCopied] = useState(false)
  const url = window.location.href
  return (
    <div className="open-in-wallet">
      <p className="hero-hint">
        Phone browsers have no wallet built in. Open 0GDrive in your wallet app's browser instead:
      </p>
      <div className="wallet-apps">
        {walletAppLinks(url).map((w) => (
          <a key={w.name} className="btn wallet-app" href={w.href} rel="noopener">
            {w.name}
          </a>
        ))}
      </div>
      <p className="muted small-print">
        Another wallet?{' '}
        <button
          className="link"
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(url).then(() => setCopied(true), () => undefined)
          }}
        >
          {copied ? 'Link copied' : 'Copy this page’s link'}
        </button>{' '}
        and open it in its browser. The wallet app is a separate browser: your drive opens there as on a new device.
      </p>
    </div>
  )
}
