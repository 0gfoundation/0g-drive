import { useEffect, useSyncExternalStore } from 'react'
import {
  lastUsedWallet,
  pickerOpen,
  resolvePicker,
  subscribePicker,
  subscribeWallets,
  walletSnapshot,
} from './wallet'

/** The "choose a wallet" dialog chooseWallet() opens when several are installed. */
export function WalletPicker() {
  const open = useSyncExternalStore(subscribePicker, pickerOpen)
  const wallets = useSyncExternalStore(subscribeWallets, walletSnapshot)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') resolvePicker(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null
  const last = lastUsedWallet()
  return (
    <div className="modal-backdrop" onClick={() => resolvePicker(null)}>
      <div className="modal wallet-picker" role="dialog" aria-label="Choose a wallet" onClick={(e) => e.stopPropagation()}>
        <h2>Choose a wallet</h2>
        <ul className="wallet-list">
          {wallets.map((w) => (
            <li key={w.id}>
              <button className="wallet-option" onClick={() => resolvePicker(w)} autoFocus={w === wallets[0]}>
                {w.icon ? <img src={w.icon} alt="" /> : <span className="wallet-icon-blank" aria-hidden="true" />}
                <span className="wallet-name">{w.name}</span>
                {w.id === last && <span className="wallet-last">Last used</span>}
              </button>
            </li>
          ))}
        </ul>
        <p className="muted small-print">
          Your drive belongs to your account, not to the wallet app: the same account opens it in
          any of these.
        </p>
        <div className="modal-actions">
          <button className="btn" onClick={() => resolvePicker(null)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
