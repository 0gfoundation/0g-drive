import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import qrcode from 'qrcode-generator'
import {
  WALLET_APPS,
  cancelWalletConnect,
  connectLink,
  connectingVia,
  subscribeWc,
  walletAppLink,
  wcState,
} from './walletConnect'
import { isTouchDevice } from './OpenInWallet'

/** The pairing link as a QR code (SVG path, dark modules on white). */
function QrCode({ text }: { text: string }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    const n = qr.getModuleCount()
    let d = ''
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x} ${y}h1v1h-1z`
    return { size: n, path: d }
  }, [text])
  // a 4-module quiet zone, as scanners expect
  return (
    <svg className="wc-qr" viewBox={`-4 -4 ${size + 8} ${size + 8}`} role="img" aria-label="QR code to connect your wallet" shapeRendering="crispEdges">
      <rect x="-4" y="-4" width={size + 8} height={size + 8} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}

/**
 * WalletConnect, in the page: the QR code (laptop) or wallet-app links
 * (phone) while pairing, and a "approve in your wallet" bar while a request
 * waits in a wallet that isn't in this browser.
 */
export function WalletConnectDialog() {
  const s = useSyncExternalStore(subscribeWc, wcState)
  const [copied, setCopied] = useState(false)
  const [showQr, setShowQr] = useState(false)
  const touch = isTouchDevice()

  useEffect(() => {
    if (!s.uri) {
      setCopied(false)
      setShowQr(false)
      return
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelWalletConnect()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [s.uri])

  if (s.uri) {
    const copy = () => void navigator.clipboard?.writeText(s.uri!).then(() => setCopied(true), () => undefined)
    return (
      <div className="modal-backdrop" onClick={cancelWalletConnect}>
        <div className="modal wc-dialog" role="dialog" aria-label="Connect with WalletConnect" onClick={(e) => e.stopPropagation()}>
          {touch ? (
            <>
              <h2>Connect your wallet app</h2>
              {s.waitingFor ? (
                <p className="wc-waiting">
                  Approve the connection in {s.waitingFor}, then come back to this page.
                </p>
              ) : (
                <p className="muted">Pick the wallet app on this phone. It opens, asks you to connect, and you come back here.</p>
              )}
              <div className="wallet-apps">
                {WALLET_APPS.map((app) => (
                  <a key={app.id} className="btn wallet-app" href={connectLink(app, s.uri!)} rel="noopener" onClick={() => connectingVia(app)}>
                    {app.name}
                  </a>
                ))}
              </div>
              <p className="muted small-print">
                Another wallet?{' '}
                <button className="link" type="button" onClick={copy}>
                  {copied ? 'Link copied' : 'Copy the connection link'}
                </button>{' '}
                and paste it in its WalletConnect screen, or{' '}
                <button className="link" type="button" onClick={() => setShowQr((v) => !v)}>
                  {showQr ? 'hide the QR code' : 'show a QR code'}
                </button>{' '}
                to scan from another device.
              </p>
              {showQr && <QrCode text={s.uri} />}
            </>
          ) : (
            <>
              <h2>Scan with your phone’s wallet</h2>
              <QrCode text={s.uri} />
              <p className="muted">
                Open your wallet app (MetaMask, Trust, Binance, Bitget…), find its scanner, and scan
                this code. You then approve each action on your phone.
              </p>
              <p className="muted small-print">
                A desktop wallet?{' '}
                <button className="link" type="button" onClick={copy}>
                  {copied ? 'Link copied' : 'Copy the connection link'}
                </button>{' '}
                and paste it there.
              </p>
            </>
          )}
          <div className="modal-actions">
            <button className="btn" onClick={cancelWalletConnect}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (s.pending > 0) {
    const link = touch ? walletAppLink() : null
    const who = s.peer ?? 'your wallet'
    return (
      <div className="wc-approve" role="status">
        <span>{touch ? `Approve in ${who}, then come back here.` : `Approve on your phone, in ${who}.`}</span>
        {link && (
          <a className="btn primary" href={link} rel="noopener">
            Open {who}
          </a>
        )}
      </div>
    )
  }
  return null
}
