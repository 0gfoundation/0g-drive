import { useCallback, useEffect, useRef, useState } from 'react'
import {
  bytesToHex,
  createMasterKey,
  decryptDownloaded,
  generateFileKey,
  getMasterKeyHex,
  getNetworkConfig,
  hexToBytes,
  importMasterKey,
  unwrapFileKey,
  unwrapFileKeyWithPrivateKey,
  wrapFileKey,
  wrapFileKeyToPubKey,
  buildShareLink,
  buildEncryptedShareLink,
  parseShareLink,
  unlockShareKey,
  DriveStore,
  TRASH_PATH,
  fileNameProblem,
  timed,
  uniqueName,
  folderNameProblem,
  type AccountCard,
  type V2Backend,
  type DriveState,
  type FileMeta,
  type DownloadOpts,
  type SharePayload,
  type EncryptedSharePayload,
} from '@0gdrive/core'
import {
  activeProvider,
  chooseWallet,
  connectWallet,
  disconnectWallet,
  hasExtension,
  hasWallet,
  lastUsedWallet,
  onAccountsChanged,
  onChainChanged,
  reconnectWallet,
  selectWallet,
  switchWallet,
  type WalletState,
} from './wallet'
import { WALLETCONNECT_ID, resetWalletConnect } from './walletConnect'
import { Logo } from './Logo'
import { keepConnectionsWarm, preconnect } from './keepWarm'
import {
  FIRST_DEPOSIT,
  V2_RECORD_NETWORK,
  backendFor,
  balanceOf,
  deposit,
  isShortfall,
  uploadNeed,
  keyMatches,
  lookupDrive,
  lookupDriveByKey,
  readV2,
  restoreByPassword as unlockByPassword,
  restoreBySignature as unlockBySignature,
  setupDrive,
  setupDriveWithPassword,
  withPassword,
  UnstableSignatureError,
  DepositError,
} from './v2drive'
import { closeOnBackdrop } from './backdrop'
import { OpenInWallet, isTouchDevice } from './OpenInWallet'
import { FileIcon } from './fileIcons'
import { FILE_CACHE_MAX_BYTES, cachedOrDownload, fileCacheKey } from './fileCache'
import { FileThumb, PreviewModal, canPreview, makeThumbnail } from './Preview'
import { setThumbSaving } from './thumbStore'
import { AssistantPanel, highlight, isNarrow, type DriveStatus } from './Assistant'
import { SearchBox, SearchResults, SuggestionsPanel, useSmartDrive } from './SmartSearch'
import { openPendingSearch, pendingSearch } from './searchPending'
import { describeModelStatus, entryForRename, getModelStatus, modelErrorReason, indexFile, isPhone, isPhoto, modelEta, modelsLoading, smartSearchEnabled, subscribeModelStatus } from './ai/client'

const NETWORK = getNetworkConfig('testnet', 'turbo')
preconnect(NETWORK)

interface Activity {
  id: number
  ts: number
  msg: string
  percent?: number
}

/** What to do with uploads whose names are taken (see uploadFiles). */
type DupChoice = { kind: 'replace' | 'keep'; names: string[] } | { kind: 'skip' | 'cancel' }

/** A dropped file whose name is taken, as the dialog shows it. */
interface DupItem {
  name: string
  /** "name (1).ext": the name field starts with it */
  suggestion: string
  /** a file of that name is in the folder (not just queued, or repeated in the drop) */
  replaceable: boolean
}

interface QueueItem {
  id: string
  name: string
  /** the folder it goes to */
  path?: string
  size: number
  state: 'queued' | 'uploading' | 'approving' | 'sealing' | 'registering' | 'done' | 'error'
  message?: string
  percent?: number
}

interface FileSystemWritableLike {
  write(data: Uint8Array): Promise<void>
  close(): Promise<void>
}

declare global {
  interface Window {
    showSaveFilePicker?: (opts?: {
      suggestedName?: string
      types?: Array<{ description: string; accept: Record<string, string[]> }>
    }) => Promise<{ createWritable: () => Promise<FileSystemWritableLike> }>
  }
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString()
}

/** A storage balance (wei) for display: 4 significant digits. */
/** How long a deposit may take to show in the balance before we stop reading it. */
const DEPOSIT_SHOW_MS = 60_000
/** How often the wallet and storage balances are read again while the tab is shown. */
const BALANCE_POLL_MS = 30_000

function fmtBalance(wei: bigint): string {
  const n = Number(wei) / 1e18
  return n === 0 ? '0' : n >= 1 ? n.toFixed(3) : n.toPrecision(3)
}

function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash
}

/** What the rename dialog is renaming. */
type RenameTarget = { kind: 'file'; meta: FileMeta } | { kind: 'folder'; path: string }

/** The last segment of a folder path. */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** The folder a path sits in ('' = My drive). */
function parentOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
}

/** What the move picker is moving: a folder, or files from one folder. */
type MoveTarget = { kind: 'folder'; path: string } | { kind: 'files'; ids: string[]; from: string; label: string }

/** Folder paths in tree order (each folder followed by its subfolders). */
function treeOrder(paths: string[]): string[] {
  const out: string[] = []
  const walk = (nodes: TreeNode[]) => nodes.forEach((n) => { out.push(n.path); walk(n.children) })
  walk(buildTree(paths))
  return out
}

/** Immediate subfolders of `path` according to the drive index. */
function subFolders(drive: DriveState, path: string): string[] {
  const prefix = path === '' ? '' : path + '/'
  return drive.paths
    .filter((f) => f.startsWith(prefix) && f.slice(prefix.length).indexOf('/') === -1)
    .sort()
}

async function saveBytes(
  data: Uint8Array,
  name: string,
  mime: string
): Promise<void> {
  const blob = new Blob([data as unknown as BlobPart], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * One line of the sidebar's Security list. The rows share one grid, so
 * labels, statuses and actions each line up in their own column.
 */
function SecRow({
  id,
  label,
  hint,
  status,
  action,
}: {
  id: string
  /** none: the section's heading names the row (its cells then span two columns) */
  label?: string
  hint: string
  status?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="sec-row" data-row={id}>
      {label && <span className="sec-label" title={hint}>{label}</span>}
      <span className={label ? 'sec-status' : 'sec-status sec-wide'} title={label ? undefined : hint}>
        {status}
      </span>
      <span className="sec-act">{action}</span>
    </div>
  )
}

const FOLDED_KEY = '0gdrive:folded-sections'

/** The sidebar sections folded on this device (all open at first). */
function loadFolded(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]')
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

/**
 * A sidebar section whose heading folds it. Folded, the heading carries a
 * one-line summary (the balance, what's missing), so nothing that needs
 * attention is hidden; the body stays in the page, hidden.
 */
function SideSection({
  id,
  title,
  summary,
  folded,
  onToggle,
  children,
}: {
  id: string
  title: string
  summary?: React.ReactNode
  folded: boolean
  onToggle: (id: string) => void
  children: React.ReactNode
}) {
  return (
    <div className={`sidebar-sec${folded ? ' folded' : ''}`} data-guide={id}>
      <button className="sec-heading sec-fold" aria-expanded={!folded} aria-controls={`sec-body-${id}`} onClick={() => onToggle(id)}>
        <svg className="sec-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
        <span className="sec-title">{title}</span>
        {folded && summary ? <span className="sec-summary">{summary}</span> : null}
      </button>
      <div className="sec-body" id={`sec-body-${id}`} hidden={folded}>
        {children}
      </div>
    </div>
  )
}

const SecOff = ({ children }: { children: React.ReactNode }) => <span className="sec-off">{children}</span>

function SecOk({ children }: { children: React.ReactNode }) {
  return (
    <span className="sec-ok">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
      {children}
    </span>
  )
}

// ─── Folder tree helpers ──────────────────────────────────────────────

interface TreeNode {
  name: string
  path: string
  children: TreeNode[]
}

function buildTree(folders: string[]): TreeNode[] {
  const root: TreeNode[] = []
  for (const f of [...folders].sort()) {
    const parts = f.split('/')
    let level = root
    let path = ''
    for (const p of parts) {
      path = path ? path + '/' + p : p
      let node = level.find((n) => n.name === p)
      if (!node) {
        node = { name: p, path, children: [] }
        level.push(node)
      }
      level = node.children
    }
  }
  return root
}

// ─── Hero art and the welcome panel ─────────────────────────────────

function HeroIcon() {
  return (
    <svg className="hero-icon" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="og-grad" x1="0" y1="0" x2="48" y2="48">
          <stop offset="0" stopColor="#b75fff" />
          <stop offset="1" stopColor="#4932c4" />
        </linearGradient>
      </defs>
      <path d="M14 16a9 9 0 0 1 17.6-2.6A7.5 7.5 0 0 1 38 20.5c0 4.1-3.4 7.5-7.5 7.5H16a6.5 6.5 0 0 1-2-12.7z"
        fill="url(#og-grad)" opacity="0.16" />
      <path d="M14 16a9 9 0 0 1 17.6-2.6A7.5 7.5 0 0 1 38 20.5c0 4.1-3.4 7.5-7.5 7.5H16a6.5 6.5 0 0 1-2-12.7z"
        stroke="url(#og-grad)" strokeWidth="1.8" />
      <path d="M18 24h12v9a3 3 0 0 1-3 3h-6a3 3 0 0 1-3-3z" fill="url(#og-grad)" opacity="0.9" />
      <path d="M21 28h6M21 31h6" stroke="#0a0a0c" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

/** First screen before a wallet is connected: what 0GDrive is for, and the way in. */
function Welcome({ onConnect, busy, error }: { onConnect: () => void; busy: 'reconnecting' | 'connecting' | null; error: string | null }) {
  // WalletConnect's saved data can get stuck (a private tab worked where the
  // normal one hung): after an error, or a wait this long, offer to start over
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    setSlow(false)
    if (!busy) return
    const t = setTimeout(() => setSlow(true), 8000)
    return () => clearTimeout(t)
  }, [busy])
  const [resetting, setResetting] = useState(false)
  const startOver = async () => {
    setResetting(true)
    await resetWalletConnect()
    location.reload()
  }
  const offerStartOver = lastUsedWallet() === WALLETCONNECT_ID && (!!error || slow)
  return (
    <section className="hero welcome" aria-labelledby="welcome-title">
      <HeroIcon />
      <h1 id="welcome-title">Your files, for your eyes only.</h1>
      <p className="welcome-sub">
        Encrypted on your device before upload. Only you, and the people you share with, can open
        them. Not 0G, not the storage nodes.
      </p>
      {hasWallet() ? (
        <button className="btn primary welcome-cta" onClick={onConnect} disabled={busy !== null}>
          {busy === 'reconnecting'
            ? 'Reconnecting…'
            : busy === 'connecting'
              ? 'Connecting…'
              : hasExtension() ? 'Get started' : isTouchDevice() ? 'Connect your wallet app' : 'Get started with a phone wallet'}
        </button>
      ) : (
        !isTouchDevice() && <p className="hero-hint">Install a wallet extension such as MetaMask or Rabby to start.</p>
      )}
      {error && <p className="error-text welcome-error" role="alert">⚠ {error}</p>}
      {offerStartOver && (
        <p className="welcome-start-over">
          {slow && !error ? 'Taking too long? ' : ''}
          <button className="btn small" onClick={startOver} disabled={resetting}>
            {resetting ? 'Starting over…' : 'Start a new connection'}
          </button>
        </p>
      )}
      {/* a phone browser: WalletConnect (above) or the wallet app's own browser */}
      {!hasExtension() && isTouchDevice() && <OpenInWallet alternative={hasWallet()} />}
      <p className="hero-hint">Connect to open your drive, or create one in a click.</p>
    </section>
  )
}

// ─── Action icons (inline SVG, no deps; file-type icons: fileIcons.tsx) ──

const ACTION_ICONS = {
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  share: 'M15 5l5 5-5 5M20 10H10a6 6 0 00-6 6v3',
  trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13',
  restore: 'M4 12a8 8 0 108-8 8 8 0 00-6 2.7M4 4v4h4',
  close: 'M6 6l12 12M18 6L6 18',
  rename: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  move: 'M3 6h6l2 2h10v11H3zM10 14h7M14 11l3 3-3 3',
} as const

/** Button content: icon always, label hidden on narrow screens. */
/** Select-all checkbox: checked when every file is selected, a dash when
 *  only some are; a click selects all, or clears when all are selected. */
function SelectAllBox({ total, selected, onChange }: { total: number; selected: number; onChange: () => void }) {
  return (
    <input
      type="checkbox"
      ref={(el) => {
        if (el) el.indeterminate = selected > 0 && selected < total
      }}
      checked={total > 0 && selected === total}
      onChange={onChange}
      aria-label="select all"
    />
  )
}

function ActionLabel({ icon }: { icon: keyof typeof ACTION_ICONS }) {
  return (
    <svg className="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ACTION_ICONS[icon]} />
    </svg>
  )
}

function FolderGlyph({ open }: { open?: boolean }) {
  return (
    <svg className="tree-folder-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={open ? 'M3 7V5h6l2 2h10v3' : 'M3 7V5h6l2 2h9a1 1 0 011 1v1'} />
      <path d={open ? 'M3 10h18l-2 10H5z' : 'M3 7l2 12h14l2-10H3z'} />
    </svg>
  )
}

function TreeRow({
  node, depth, currentPath, expanded, onToggle, onSelect, onRename, onMove, onRemove, disabled,
}: {
  node: TreeNode
  depth: number
  currentPath: string
  expanded: string[]
  onToggle(p: string): void
  onSelect(p: string): void
  onRename(p: string): void
  onMove(p: string): void
  onRemove(p: string): void
  disabled: boolean
}) {
  const isOpen = expanded.includes(node.path)
  const isSelected = currentPath === node.path
  return (
    <div>
      <div className={`tree-row${isSelected ? ' selected' : ''}`} style={{ paddingLeft: 6 + depth * 14 }}>
        <button
          className={`tree-caret${node.children.length === 0 ? ' spacer' : ''}`}
          onClick={() => node.children.length > 0 && onToggle(node.path)}
          aria-label={isOpen ? 'collapse' : 'expand'}
        >
          {node.children.length > 0 ? (isOpen ? '▾' : '▸') : ''}
        </button>
        <button className="tree-label" onClick={() => onSelect(node.path)} title={node.path}>
          <FolderGlyph open={isOpen} />
          <span className="tree-name">{node.name}</span>
        </button>
        <button className="tree-act tree-rename" disabled={disabled} onClick={() => onRename(node.path)}
          title="Rename folder" aria-label="Rename folder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={ACTION_ICONS.rename} />
          </svg>
        </button>
        <button className="tree-act tree-move" disabled={disabled} onClick={() => onMove(node.path)}
          title="Move folder" aria-label="Move folder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={ACTION_ICONS.move} />
          </svg>
        </button>
        <button className="tree-act tree-remove" disabled={disabled} onClick={() => onRemove(node.path)}
          title="Move folder (and contents) to trash">
          🗑
        </button>
      </div>
      {isOpen &&
        node.children.map((ch) => (
          <TreeRow key={ch.path} node={ch} depth={depth + 1} currentPath={currentPath}
            expanded={expanded} onToggle={onToggle} onSelect={onSelect} onRename={onRename} onMove={onMove} onRemove={onRemove}
            disabled={disabled} />
        ))}
    </div>
  )
}

// ─── Recipient view (opened via a share link; no wallet needed) ───────

function ShareView({
  mode,
  payload,
  onExit,
  log,
}: {
  mode: 'link' | 'encrypted'
  payload: SharePayload | EncryptedSharePayload
  onExit: () => void
  log: (msg: string) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const p = payload as SharePayload & EncryptedSharePayload
  /** opened with a wallet signature (derived sharing key) vs. a pasted raw key (legacy links) */
  const viaWallet = mode === 'encrypted' && p.d === 1

  /** The recipient's sharing private key, from this device or a wallet signature. */
  const walletShareKey = async (): Promise<Uint8Array | null> => {
    if (!hasWallet()) {
      throw new Error('No Ethereum wallet detected. Open this link in a browser with the recipient’s wallet.')
    }
    const option = await chooseWallet()
    if (!option) return null
    setBusy('Connecting wallet…')
    const { BrowserProvider } = await import('ethers')
    const provider = new BrowserProvider(selectWallet(option))
    await provider.send('eth_requestAccounts', [])
    const signer = await provider.getSigner()
    const address = await signer.getAddress()
    if (address.toLowerCase() !== p.to.toLowerCase()) {
      throw new Error(`This file was shared with ${shortHash(p.to)}, but your wallet is on ${shortHash(address)}. Switch accounts and try again.`)
    }
    setBusy('Waiting for signature…')
    const key = await unlockShareKey(signer, address)
    if (p.p && key.pubKey.toLowerCase() !== p.p.toLowerCase()) {
      throw new Error(
        'Your wallet produced a different sharing key than this link was made for. ' +
        'Ask the sender for a new link; if it happens again, your wallet may not sign deterministically.'
      )
    }
    return key.privateKey
  }

  const save = async () => {
    setError(null)
    try {
      const privateKey = viaWallet ? await walletShareKey() : keyInput.trim()
      if (privateKey === null) return // wallet picker dismissed
      // links made before the drive moved to V2 name V1 files (with their txSeqs), which are gone
      if (p.q?.length) throw new Error('This link is from 0GDrive’s previous storage network, which is no longer used. Ask the sender for a new link.')
      setBusy('Downloading…')
      const fileKey = mode === 'link' ? p.k : await unwrapFileKeyWithPrivateKey(privateKey, p.w)
      const res = await readV2(p.r, {
        decryption: { symmetricKey: fileKey },
        onProgress: (msg) => log(`${p.n}: ${msg}`),
      })
      if (!res.decrypted) throw new Error('decryption failed')
      await saveBytes(res.data, p.n, p.m)
      log(`shared file "${p.n}" downloaded.`)
      setBusy(null)
    } catch (err) {
      setError((err as Error).message)
      setBusy(null)
    }
  }

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <Logo className="logo-mark" />
          <span className="brand-name">Drive</span>
          <span className="network-badge">shared file</span>
        </div>
        <button className="btn small" onClick={onExit}>
          Open my drive →
        </button>
      </header>
      <main className="main">
        <section className="share-card">
          <h2>📄 {p.n}</h2>
          <p className="muted">
            {fmtSize(p.z)} · {p.m} · shared via {mode === 'link' ? 'secret link' : 'encrypted link'}
          </p>
          {viaWallet && (
            <p className="muted">
              Shared with {shortHash(p.to)}. Your wallet signs a 0GDrive message to unlock it
              (no transaction, nothing sent on-chain) — not needed again on this device.
            </p>
          )}
          {mode === 'encrypted' && !viaWallet && (
            <div className="key-import-row">
              <input
                className="key-input"
                placeholder="recipient private key (0x…) to decrypt"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
              />
            </div>
          )}
          {error && <p className="error-text">⚠ {error}</p>}
          <button
            className="btn primary"
            disabled={busy !== null || (mode === 'encrypted' && !viaWallet && !/^0x[0-9a-fA-F]{64}$/.test(keyInput.trim()))}
            onClick={() => void save()}
          >
            {busy ?? (viaWallet ? 'Unlock with wallet & download' : 'Download file')}
          </button>
          <p className="muted">
            Files are fetched from 0G Storage and decrypted in your browser.
            {mode === 'encrypted' && ' This share is key-wrapped — only the recipient can decrypt.'}
          </p>
        </section>
      </main>
      <footer className="footer">0GDrive · {NETWORK.chainName}</footer>
    </div>
  )
}

const MIN_PASSWORD = 12

/** A drive's key from its card's password wrap, found from the drive's wallet address alone. */
async function unlockWithPassword(
  address: string,
  password: string,
  onUnlocking?: () => void
): Promise<{ masterKey: Uint8Array; card: AccountCard }> {
  const found = await lookupDrive(address, false)
  if (!found) throw new Error('No drive found for this address.')
  onUnlocking?.()
  return { masterKey: await unlockByPassword(found.card, password), card: found.card }
}

// ─── Main app ─────────────────────────────────────────────────────────

export default function App() {
  const [wallet, setWallet] = useState<WalletState | null>(null)
  const walletAddressRef = useRef<string | null>(null)
  const [reconnecting, setReconnecting] = useState(true)
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [walletMenu, setWalletMenu] = useState(false)
  const [masterKeyHex, setMasterKeyHex] = useState<string | null>(null)
  const [hasBackup, setHasBackup] = useState<boolean | null>(null)
  const [backupCheckError, setBackupCheckError] = useState<string | null>(null)
  const [restoreBusy, setRestoreBusy] = useState<string | null>(null)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [restorePassword, setRestorePassword] = useState('')
  const [showPasswordRestore, setShowPasswordRestore] = useState(false)
  /** whether the drive's card has a password wrap (null: unknown) */
  const [hasPassword, setHasPassword] = useState<boolean | null>(null)
  const [pwDialog, setPwDialog] = useState(false)
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [pwError, setPwError] = useState<string | null>(null)
  /** the wallet whose signatures changed at setup: offered a password-only drive */
  const [unstableFor, setUnstableFor] = useState<string | null>(null)
  const [setupPw1, setSetupPw1] = useState('')
  const [setupPw2, setSetupPw2] = useState('')
  /** a password-only drive just set up: export its key file */
  const [keyFileNudge, setKeyFileNudge] = useState(false)
  /** drive opened with its recovery password, without the wallet: no writes */
  const [readOnly, setReadOnly] = useState(false)
  const readOnlyRef = useRef(false)
  const [lostOpen, setLostOpen] = useState(false)
  const [lostAddress, setLostAddress] = useState('')
  const [lostPassword, setLostPassword] = useState('')
  const [lostBusy, setLostBusy] = useState<string | null>(null)
  const [lostError, setLostError] = useState<string | null>(null)
  const [drive, setDrive] = useState<DriveState | null>(null)
  const [currentPath, setCurrentPath] = useState('')
  const [view, setView] = useState<'drive' | 'trash'>('drive')
  const [activities, setActivities] = useState<Activity[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [addressCopied, setAddressCopied] = useState(false)
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [keyImport, setKeyImport] = useState('')
  /** the drive's card (its storage account, recovery wraps, sharing key); null: this wallet has no drive yet */
  const [card, setCard] = useState<AccountCard | null>(null)
  /** the storage account's balance (wei), once read */
  const [balance, setBalance] = useState<bigint | null>(null)
  const [depositBusy, setDepositBusy] = useState<string | null>(null)
  const [folded, setFolded] = useState<Set<string>>(loadFolded)
  const setSectionFolded = useCallback((id: string, fold: boolean) => {
    setFolded((prev) => {
      if (prev.has(id) === fold) return prev
      const next = new Set(prev)
      if (fold) next.add(id)
      else next.delete(id)
      try {
        localStorage.setItem(FOLDED_KEY, JSON.stringify([...next]))
      } catch {
        // storage blocked: folding lasts this visit
      }
      return next
    })
  }, [])
  const toggleSection = useCallback((id: string) => setSectionFolded(id, !folded.has(id)), [folded, setSectionFolded])
  const [shareFor, setShareFor] = useState<FileMeta | null>(null)
  const [renameFor, setRenameFor] = useState<RenameTarget | null>(null)
  /** an upload whose names are taken, waiting for Replace / Keep both / Skip / Cancel */
  const [dupAsk, setDupAsk] = useState<{ items: DupItem[]; taken: Set<string>; resolve: (c: DupChoice) => void } | null>(null)
  /** the names typed in that dialog, one per item */
  const [dupNames, setDupNames] = useState<string[]>([])
  const [renameTo, setRenameTo] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)
  const [moveFor, setMoveFor] = useState<MoveTarget | null>(null)
  const [moveDest, setMoveDest] = useState<string | null>(null)
  /** folders added with "New folder here", created by the move itself */
  const [movePending, setMovePending] = useState<string[]>([])
  const [moveNewName, setMoveNewName] = useState<string | null>(null)
  const [moveError, setMoveError] = useState<string | null>(null)
  const [previewFor, setPreviewFor] = useState<FileMeta | null>(null)
  const [shareMode, setShareMode] = useState<'A' | 'B'>('A')
  const [shareRecipient, setShareRecipient] = useState('')
  const [shareLink, setShareLink] = useState<string | null>(null)
  const [shareBusy, setShareBusy] = useState<string | null>(null)
  const [shareError, setShareError] = useState<string | null>(null)
  const [shared, setShared] = useState<
    { mode: 'link' | 'encrypted'; payload: SharePayload | EncryptedSharePayload } | null
  >(null)
  const [expandedFolders, setExpandedFolders] = useState<string[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [navOpen, setNavOpen] = useState(false)
  const [assistOpen, setAssistOpen] = useState(false)
  const [layout, setLayout] = useState<'list' | 'grid'>(() => {
    try {
      return localStorage.getItem('0gdrive:layout') === 'grid' ? 'grid' : 'list'
    } catch {
      return 'list'
    }
  })
  const activityId = useRef(0)
  const storeRef = useRef<DriveStore | null>(null)

  const log = useCallback((msg: string, percent?: number) => {
    setActivities((prev) =>
      [{ id: ++activityId.current, ts: Date.now(), msg, percent }, ...prev].slice(0, 60)
    )
  }, [])

  // share link on load
  useEffect(() => {
    const parsed = parseShareLink(window.location.hash)
    if (parsed) setShared({ mode: parsed.mode, payload: parsed.payload })
  }, [])

  // expand tree ancestors when navigating into a deep folder
  useEffect(() => {
    if (currentPath === '') return
    const ancestors: string[] = []
    let p = ''
    for (const seg of currentPath.split('/')) {
      p = p ? p + '/' + seg : seg
      ancestors.push(p)
    }
    setExpandedFolders((prev) => [...new Set([...prev, ...ancestors])])
  }, [currentPath])

  const toggleFolder = useCallback((p: string) => {
    setExpandedFolders((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
    )
  }, [])

  // selection doesn't survive navigation between folders/views
  useEffect(() => {
    setSelectedIds([])
  }, [currentPath, view])

  const reloadDrive = useCallback(async () => {
    const store = storeRef.current
    if (!store) return
    setBusy('Syncing drive from chain…')
    try {
      setDrive(await store.loadDrive())
    } catch (err) {
      log(`Drive sync failed: ${(err as Error).message}`)
    } finally {
      setBusy(null)
    }
  }, [log])

  /** The drive as its card says: found (or just set up) for this wallet, or none (null). */
  const adoptCard = useCallback((c: AccountCard | null) => {
    setCard(c)
    setHasBackup(c !== null)
    setHasPassword(c === null ? false : Boolean(c.wrappedUnderPassword))
  }, [])

  const refreshBalance = useCallback((masterKey: Uint8Array) => {
    balanceOf(masterKey).then(setBalance, (err) => console.warn('[drive] balance', err))
  }, [])

  /**
   * The wallet's 0G in the header, read again. With `before`, read until it
   * differs (after a transaction: the RPC may still answer from before it),
   * for up to DEPOSIT_SHOW_MS.
   */
  const refreshWalletBalance = useCallback(async (signer: WalletState['signer'], before?: string) => {
    const deadline = Date.now() + DEPOSIT_SHOW_MS
    const { formatEther } = await import('ethers')
    for (;;) {
      const now = await signer.provider
        .getBalance(await signer.getAddress())
        .then(formatEther)
        .catch(() => null)
      if (now !== null) setWallet((w) => (w && w.signer === signer ? { ...w, balance: now } : w))
      if ((now !== null && (before === undefined || now !== before)) || Date.now() > deadline) return
      await new Promise((r) => setTimeout(r, 2000))
    }
  }, [])

  /**
   * After a deposit: read the balance until it shows the deposit. The public
   * RPC is load-balanced, and a backend still behind the deposit's block
   * answers with the old balance.
   */
  const awaitDeposit = useCallback(async (masterKey: Uint8Array, before: bigint | null) => {
    const deadline = Date.now() + DEPOSIT_SHOW_MS
    for (;;) {
      const now = await balanceOf(masterKey).catch((err) => (console.warn('[drive] balance', err), null))
      if (now !== null) setBalance(now)
      if ((now !== null && (before === null || now > before)) || Date.now() > deadline) return
      await new Promise((r) => setTimeout(r, 2000))
    }
  }, [])

  const initDrive = useCallback(
    async (signer: WalletState['signer'], masterKey: Uint8Array, address: string, driveCard: AccountCard | null) => {
      await openPendingSearch(address, masterKey)
      const store = new DriveStore(backendFor(masterKey, driveCard), { pendingSearch })
      storeRef.current = store
      refreshBalance(masterKey)
      setBusy('Loading drive from 0G…')
      try {
        setDrive(await store.loadDrive())
        log('Drive loaded from 0G Storage.')
      } catch (err) {
        log(`Drive load failed: ${(err as Error).message}`)
      } finally {
        setBusy(null)
      }
    },
    [log, refreshBalance]
  )

  const checkBackup = useCallback(
    async (address: string) => {
      setHasBackup(null)
      setBackupCheckError(null)
      setHasPassword(null)
      try {
        const local = getMasterKeyHex(address)
        // the deposit scan finds the drive from the wallet alone; with the key on this
        // device, its account's newest root names the drive too (if the scan missed it)
        const found = (await lookupDrive(address)) ?? (local ? await lookupDriveByKey(address, hexToBytes(local)) : null)
        adoptCard(found?.card ?? null)
        // a key on this device for another drive (e.g. one replaced on another device): restore this one instead
        if (found && local && !keyMatches(hexToBytes(local), found.card)) {
          setMasterKeyHex(null)
          setRestoreError('The drive key on this device belongs to a different drive. Restore this wallet’s drive below.')
        }
      } catch (err) {
        // unknown is not "no drive": offering setup here could replace an existing drive
        setBackupCheckError((err as Error).message ?? String(err))
      }
    },
    [adoptCard]
  )

  const adoptWallet = useCallback(
    (state: WalletState) => {
      walletAddressRef.current = state.address
      setWallet(state)
      setMasterKeyHex(getMasterKeyHex(state.address))
      log(`Connected ${shortHash(state.address)} · balance ${Number(state.balance).toFixed(4)} 0G`)
      void checkBackup(state.address)
    },
    [log, checkBackup]
  )

  const connect = useCallback(async () => {
    setConnectError(null)
    setConnecting(true)
    try {
      const state = await connectWallet(NETWORK)
      if (!state) return // picker dismissed
      adoptWallet(state)
    } catch (err) {
      const e = err as { code?: number | string; shortMessage?: string; message: string; error?: { message?: string } }
      log(`Wallet error: ${e.message}`)
      // closed the wallet's window or the WalletConnect dialog: nothing to report
      if (e.code !== 4001 && e.code !== 'ACTION_REJECTED') {
        // ethers wraps what it can't classify; the wallet's own words are inside
        setConnectError(`Couldn’t connect: ${e.error?.message ?? e.shortMessage ?? e.message}`)
      }
    } finally {
      setConnecting(false)
    }
  }, [log, adoptWallet])

  // keep the app's and the wallet's RPC connections open while connected
  const connected = wallet !== null && !readOnly
  useEffect(() => (connected ? keepConnectionsWarm(NETWORK, activeProvider) : undefined), [connected])

  // back into the last-used wallet without a click, if it still allows it
  useEffect(() => {
    // a wallet that never answers mustn't hold the start button
    const giveUp = setTimeout(() => setReconnecting(false), 10_000)
    reconnectWallet(NETWORK)
      .then((state) => {
        if (state && !readOnlyRef.current && !walletAddressRef.current) adoptWallet(state)
      })
      .catch((err) => console.warn('[wallet] reconnect failed', err))
      .finally(() => {
        clearTimeout(giveUp)
        setReconnecting(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Uploads or another action still running: say so before a reload drops them. */
  const confirmLeave = (what: string) =>
    (busy === null && queue.every((q) => q.state === 'done' || q.state === 'error')) ||
    window.confirm(`Something is still in progress (${busy ?? 'uploads'}). ${what} anyway? It will stop.`)

  const switchAccount = useCallback(async () => {
    setWalletMenu(false)
    if (!wallet || !confirmLeave('Switch wallet')) return
    try {
      await switchWallet(NETWORK, wallet.address)
    } catch (err) {
      log(`Wallet error: ${(err as Error).message}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, busy, queue, log])

  useEffect(() => {
    if (!walletMenu) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !(e.target as Element).closest?.('.address-wrap')) setWalletMenu(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [walletMenu])

  const disconnect = useCallback(() => {
    setWalletMenu(false)
    if (!confirmLeave('Disconnect')) return
    void disconnectWallet()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queue])

  // the drive opens once its card is found and this device's key is its key
  useEffect(() => {
    if (wallet && masterKeyHex && card && keyMatches(hexToBytes(masterKeyHex), card) && !busy && !storeRef.current) {
      void initDrive(wallet.signer, hexToBytes(masterKeyHex), wallet.address, card)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet?.address, masterKeyHex, card])

  // Both balances read again every BALANCE_POLL_MS while this tab is shown
  // (the wallet may spend outside the drive; rent lowers the storage
  // balance), and on coming back to it (e.g. from the faucet).
  const walletSigner = wallet?.signer
  useEffect(() => {
    const signer = walletSigner
    if (!signer || readOnly) return
    const read = () => {
      if (document.visibilityState !== 'visible') return
      void refreshWalletBalance(signer)
      if (masterKeyHex) refreshBalance(hexToBytes(masterKeyHex))
    }
    const timer = setInterval(read, BALANCE_POLL_MS)
    document.addEventListener('visibilitychange', read)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', read)
    }
  }, [walletSigner, readOnly, masterKeyHex, refreshWalletBalance, refreshBalance])

  useEffect(() => {
    const offChain = onChainChanged(() => window.location.reload())
    // another account in the wallet: start over in it (a fresh page is the
    // one reset that can't leave the previous account's state behind; it
    // reconnects quietly). The event also fires when a wallet first
    // connects — same account, nothing to do.
    const offAccounts = onAccountsChanged((accounts) => {
      if (readOnlyRef.current || !walletAddressRef.current) return
      if (accounts[0]?.toLowerCase() === walletAddressRef.current.toLowerCase()) return
      window.location.reload()
    })
    return () => {
      offChain()
      offAccounts()
    }
  }, [log])

  /**
   * Set up this wallet's drive for the key on this device (created now when
   * there is none): 3 signatures and the first deposit, then the first root.
   * Run again after an interruption, it finishes (an account already funded
   * isn't funded twice).
   */
  const createDrive = useCallback(async () => {
    if (!wallet) return
    setRestoreBusy('Waiting for signature…')
    setRestoreError(null)
    try {
      if (!getMasterKeyHex(wallet.address)) createMasterKey(wallet.address)
      const keyHex = getMasterKeyHex(wallet.address)!
      const { parseEther } = await import('ethers')
      const c = await setupDrive(wallet.signer, wallet.address, hexToBytes(keyHex), parseEther(FIRST_DEPOSIT), setRestoreBusy)
      setMasterKeyHex(keyHex)
      adoptCard(c)
      log(`Drive created: recovery, share key and a ${FIRST_DEPOSIT} 0G storage deposit (3 signatures, 1 transaction).`)
      void refreshWalletBalance(wallet.signer, wallet.balance)
    } catch (err) {
      if (err instanceof UnstableSignatureError) setUnstableFor(wallet.address)
      setRestoreError((err as Error).message)
      log(`Drive setup failed: ${(err as Error).message}`)
    } finally {
      setRestoreBusy(null)
    }
  }, [wallet, log, adoptCard, refreshWalletBalance])

  /**
   * For a wallet whose signatures change: the drive with its key locked to a
   * password only (D19): 1 signature and the first deposit, no share key.
   */
  const createDriveWithPassword = useCallback(async () => {
    if (!wallet) return
    if (setupPw1.length < MIN_PASSWORD) {
      setRestoreError(`Use at least ${MIN_PASSWORD} characters — a few unrelated words is easiest to remember.`)
      return
    }
    if (setupPw1 !== setupPw2) {
      setRestoreError('The two passwords don’t match.')
      return
    }
    setRestoreBusy('Waiting for signature…')
    setRestoreError(null)
    try {
      if (!getMasterKeyHex(wallet.address)) createMasterKey(wallet.address)
      const keyHex = getMasterKeyHex(wallet.address)!
      const { parseEther } = await import('ethers')
      const c = await setupDriveWithPassword(wallet.signer, wallet.address, hexToBytes(keyHex), setupPw1, parseEther(FIRST_DEPOSIT), setRestoreBusy)
      setMasterKeyHex(keyHex)
      adoptCard(c)
      setUnstableFor(null)
      setSetupPw1('')
      setSetupPw2('')
      setKeyFileNudge(true)
      log(`Drive created with a recovery password and a ${FIRST_DEPOSIT} 0G storage deposit (1 signature, 1 transaction).`)
      void refreshWalletBalance(wallet.signer, wallet.balance)
    } catch (err) {
      setRestoreError((err as Error).message)
      log(`Drive setup failed: ${(err as Error).message}`)
    } finally {
      setRestoreBusy(null)
    }
  }, [wallet, setupPw1, setupPw2, log, adoptCard, refreshWalletBalance])

  const restoreBySignature = useCallback(async () => {
    if (!wallet || !card) return
    setRestoreBusy('Waiting for signature…')
    setRestoreError(null)
    try {
      const masterKey = await unlockBySignature(wallet.signer, wallet.address, card)
      importMasterKey(wallet.address, bytesToHex(masterKey))
      setMasterKeyHex(bytesToHex(masterKey))
      log('Drive key restored with your wallet signature.')
    } catch (err) {
      setRestoreError((err as Error).message)
    } finally {
      setRestoreBusy(null)
    }
  }, [wallet, card, log])

  const restoreByPassword = useCallback(async () => {
    if (!wallet || !card || !restorePassword.trim()) return
    setRestoreBusy('Deriving key from password…')
    setRestoreError(null)
    try {
      const masterKey = await unlockByPassword(card, restorePassword)
      importMasterKey(wallet.address, bytesToHex(masterKey))
      setMasterKeyHex(bytesToHex(masterKey))
      log('Drive key restored via password.')
    } catch (err) {
      setRestoreError((err as Error).message)
    } finally {
      setRestoreBusy(null)
    }
  }, [wallet, card, restorePassword, log])

  const openPasswordDialog = useCallback(() => {
    setPw1('')
    setPw2('')
    setPwError(null)
    setPwDialog(true)
  }, [])

  /** A new password goes in the drive's card, stored with a new root: no wallet prompt. */
  const submitPassword = useCallback(async () => {
    const store = storeRef.current
    if (!wallet || !masterKeyHex || !card || !store) return
    if (pw1.length < MIN_PASSWORD) {
      setPwError(`Use at least ${MIN_PASSWORD} characters — a few unrelated words is easiest to remember.`)
      return
    }
    if (pw1 !== pw2) {
      setPwError('The two passwords don’t match.')
      return
    }
    setPwError(null)
    setRestoreBusy('Saving…')
    try {
      const next = await withPassword(card, hexToBytes(masterKeyHex), pw1)
      await (store.backend as V2Backend).saveCard(next)
      adoptCard(next)
      log(hasPassword ? 'Recovery password changed — the old one no longer works.' : 'Recovery password set.')
      setPwDialog(false)
      setPw1('')
      setPw2('')
    } catch (err) {
      setPwError((err as Error).message)
      log(`Set password failed: ${(err as Error).message}`)
    } finally {
      setRestoreBusy(null)
    }
  }, [wallet, masterKeyHex, card, pw1, pw2, hasPassword, log, adoptCard])

  /** Fund the drive's storage account from the wallet: one transaction. */
  const topUp = useCallback(
    async (suggested = FIRST_DEPOSIT): Promise<boolean> => {
      if (!wallet || !masterKeyHex) return false
      const amount = window.prompt('Deposit to your storage balance (0G):', suggested)?.trim()
      if (!amount) return false
      const { parseEther } = await import('ethers')
      let wei: bigint
      try {
        wei = parseEther(amount)
        if (wei <= 0n) throw new Error()
      } catch {
        log(`Not an amount: ${amount}`)
        return false
      }
      setDepositBusy('Depositing…')
      try {
        const masterKey = hexToBytes(masterKeyHex)
        const before = await balanceOf(masterKey).catch(() => null)
        await deposit(wallet.signer, masterKey, wei)
        log(`Deposited ${amount} 0G to your storage balance.`)
        setDepositBusy('Updating…')
        await Promise.all([awaitDeposit(masterKey, before), refreshWalletBalance(wallet.signer, wallet.balance)])
        return true
      } catch (err) {
        log(err instanceof DepositError ? (err as Error).message : `Deposit failed: ${(err as Error).message}`)
        return false
      } finally {
        setDepositBusy(null)
      }
    },
    [wallet, masterKeyHex, log, awaitDeposit, refreshWalletBalance]
  )

  /** Open someone's drive read-only from its address + recovery password (lost wallet). */
  const recoverWithoutWallet = useCallback(async () => {
    const address = lostAddress.trim()
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      setLostError('Enter the wallet address the drive belongs to (0x…).')
      return
    }
    setLostError(null)
    setLostBusy('Finding the drive backup…')
    try {
      const res = await unlockWithPassword(address, lostPassword, () => setLostBusy('Unlocking…'))
      const { JsonRpcProvider, VoidSigner, formatEther, getAddress } = await import('ethers')
      const provider = new JsonRpcProvider(NETWORK.rpcUrl)
      const balance = await provider.getBalance(address).then(formatEther).catch(() => '0')
      readOnlyRef.current = true
      setReadOnly(true)
      setThumbSaving(false) // possibly not the owner's device
      storeRef.current = null
      setDrive(null)
      // reads only: a VoidSigner knows the address but can't send anything
      setWallet({
        address: getAddress(address),
        balance,
        chainId: NETWORK.chainId,
        signer: new VoidSigner(address, provider) as unknown as WalletState['signer'],
      })
      adoptCard(res.card)
      // kept in memory only: this may not be the owner's own device
      setMasterKeyHex(bytesToHex(res.masterKey))
      setLostPassword('')
      log(`Drive of ${shortHash(address)} opened read-only with its recovery password.`)
    } catch (err) {
      setLostError((err as Error).message)
    } finally {
      setLostBusy(null)
    }
  }, [lostAddress, lostPassword, log, adoptCard])

  const importKey = useCallback(() => {
    if (!wallet || !keyImport.trim()) return
    try {
      importMasterKey(wallet.address, keyImport.trim())
      setMasterKeyHex(getMasterKeyHex(wallet.address))
      setKeyImport('')
      log('Drive key imported.')
    } catch (err) {
      log(`Key import failed: ${(err as Error).message}`)
    }
  }, [wallet, keyImport, log])

  const downloadKeyBackup = useCallback(() => {
    if (!masterKeyHex) return
    const blob = new Blob(
      [`0GDrive master key\nAccount: ${wallet?.address}\nKey: ${masterKeyHex}\n\nKeep this safe — without it your encrypted files cannot be read.\n`],
      { type: 'text/plain' }
    )
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `0gdrive-key-${wallet?.address.slice(0, 10)}.txt`
    a.click()
    URL.revokeObjectURL(url)
    setKeyFileNudge(false)
  }, [masterKeyHex, wallet])

  // ─── Upload queue ───────────────────────────────────────────────────

  /**
   * Upload a batch: the files, then (when every one stored) the folder
   * listing them, as one change, with no wallet prompt (the storage
   * account signs, see v2drive.ts). If any file fails, the stored ones are
   * registered with a separate change instead.
   */
  const uploadBatched = useCallback(
    async (store: DriveStore, path: string, items: QueueItem[], files: File[], replace: string[]) => {
      if (!wallet || !masterKeyHex) return
      const n = files.length
      const setItem = (i: number, patch: Partial<QueueItem>) =>
        setQueue((q) => q.map((x) => (x.id === items[i].id ? { ...x, ...patch } : x)))
      const setAll = (patch: Partial<QueueItem>, only?: (i: number) => boolean) =>
        setQueue((q) =>
          q.map((x) => {
            const i = items.findIndex((it) => it.id === x.id)
            return i >= 0 && (!only || only(i)) ? { ...x, ...patch } : x
          })
        )

      // per-file key, thumbnail, and on-device search entry (in parallel
      // with hashing; awaited — time-boxed — just before the prompt)
      const prep: { fileKey: Uint8Array; wrappedKey: string; thumb?: string; mime: string; search: Promise<FileMeta['search']> }[] = []
      for (let i = 0; i < n; i++) {
        setItem(i, { state: 'uploading', message: 'preparing…' })
        const file = files[i]
        const mime = file.type || 'application/octet-stream'
        const thumb = await makeThumbnail(file, mime, file.name)
        const fileKey = generateFileKey()
        prep.push({
          fileKey,
          wrappedKey: await wrapFileKey(hexToBytes(masterKeyHex), fileKey),
          thumb,
          mime,
          search: smartSearchEnabled() ? indexFile(file, file.name, mime, thumb) : Promise.resolve(undefined),
        })
      }

      let metas: FileMeta[] = []
      const ids = files.map(() => 'f_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10))
      const timeout = (ms: number) => new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))
      // Search entries: a one-time model download may still be running —
      // wait for it (up to 3 min, progress shown) rather than store the
      // files unindexed; once models are ready, each entry gets ≤15 s.
      const awaitSearches = async () => {
        if (!smartSearchEnabled()) return prep.map(() => undefined)
        const started = Date.now()
        const photos = files.some((f) => isPhoto(f.type))
        if (modelsLoading(photos)) {
          // wait only while the download looks close to done; otherwise the
          // files go up now and background indexing catches them later
          const unsub = subscribeModelStatus((st) => {
            if (!st.loading) return
            setAll({
              state: 'uploading',
              percent: undefined,
              message: `waiting for ${describeModelStatus(st)} to index these files`,
            })
          })
          const worthWaiting = () => {
            const st = getModelStatus()
            const elapsed = Date.now() - started
            if (!st.loading || st.error || elapsed > 180_000) return false
            const eta = modelEta(st)
            if (eta === undefined) return elapsed < 30_000 // initializing, or no speed yet
            return elapsed < 8_000 || eta <= 90
          }
          while (worthWaiting()) await timeout(1000)
          unsub()
          if (modelsLoading(photos)) return prep.map(() => undefined)
        }
        const left = Math.max(5_000, Math.min(15_000, 195_000 - (Date.now() - started)))
        return Promise.all(prep.map((p) => Promise.race([p.search, timeout(left)])))
      }

      try {
        const res = await store.backend.uploadFiles(
          files.map((file, i) => ({ data: file, encryption: { type: 'aes256' as const, key: prep[i].fileKey } })),
          {
            onItemProgress: (i, phase, f) =>
              setItem(i, {
                percent: Math.min(99, Math.round(f * 100)),
                message: phase === 'hashing' ? 'hashing & encrypting…' : 'storing segments…',
              }),
            finalize: async (refs) => {
              // entries not ready within the time box are left out — the
              // background indexing (SmartSearch.tsx) picks them up later
              const searches = await timed('indexing', awaitSearches())
              metas = files.map((file, i) => ({
                id: ids[i],
                name: file.name,
                size: file.size,
                mime: prep[i].mime,
                uploadedAt: Date.now(),
                encryption: 'aes256',
                ...refs[i],
                wrappedKey: prep[i].wrappedKey,
                network: V2_RECORD_NETWORK,
                ...(prep[i].thumb ? { thumb: prep[i].thumb } : {}),
                ...(searches[i] ? { search: searches[i] } : {}),
              }))
              const records = await store.prepareFileRecords(path, metas, replace)
              // this device's unsaved search entries of other folders ride along (optional)
              return { records, extras: await store.searchSaveItems(records).catch(() => []) }
            },
            onItem: (i, phase, msg) => {
              if (i >= n) {
                // the manifest riding in the same transaction
                if (phase === 'uploading' || phase === 'sealing') {
                  setAll({ state: 'registering', message: 'saving to your drive (no approval needed)…', percent: undefined })
                }
                return
              }
              if (phase === 'uploading') setItem(i, { state: 'uploading', message: 'storing segments…' })
              else if (phase === 'sealing') setItem(i, { state: 'sealing', message: 'sealing on 0G…', percent: undefined })
              else if (phase === 'done') setItem(i, { state: 'done', message: 'stored — registering…', percent: undefined })
              else if (phase === 'error') setItem(i, { state: 'error', message: msg ?? 'failed' })
            },
          }
        )

        const okIdx = res.files.map((r, i) => (r.ok ? i : -1)).filter((i) => i >= 0)
        res.files.forEach((r, i) => {
          if (!r.ok) log(`${files[i].name} failed: ${isShortfall(r.error) ? 'your storage balance ran out — deposit, then upload it again' : r.error}`)
        })
        if (res.recordsStored) {
          setAll({ state: 'done', message: 'in your drive ✓' }, (i) => okIdx.includes(i))
          log(`${n} file${n === 1 ? '' : 's'} stored in your drive.`)
        } else if (okIdx.length > 0) {
          // some files failed (or the batched record didn't store): register
          // the stored files with a normal manifest write
          setAll({ state: 'registering', message: 'saving to your drive…', percent: undefined }, (i) => okIdx.includes(i))
          const stored = okIdx.map((i) => {
            const r = res.files[i]
            return r.ok ? { ...metas[i], ...r.ref } : metas[i]
          })
          await store.putFileRecords(path, stored, replace)
          setAll({ state: 'done', message: 'in your drive ✓' }, (i) => okIdx.includes(i))
        }
        await reloadDrive()
        refreshBalance(hexToBytes(masterKeyHex))
      } catch (err) {
        const msg = (err as Error).message
        // the files' records couldn't be saved (the files themselves stored)
        setAll({ state: 'error', message: msg, percent: undefined })
        log(`Upload failed: ${msg}`)
      }
    },
    [wallet, masterKeyHex, log, reloadDrive, refreshBalance]
  )

  /** Upload one dropped batch (already queued) into `path`. */
  const runUpload = useCallback(
    async (store: DriveStore, path: string, items: QueueItem[], files: File[], replace: string[]) => {
      if (!wallet || !masterKeyHex) return
      // an upload holds about a week of rent up front: top up first when the balance is short
      const need = uploadNeed(files.reduce((n, f) => n + f.size, 0))
      const have = await balanceOf(hexToBytes(masterKeyHex)).catch(() => null)
      if (have !== null && have < need) {
        const { formatEther } = await import('ethers')
        const fmt = (wei: bigint) => Number(formatEther(wei)).toPrecision(2)
        const ok =
          window.confirm(
            `Your storage balance (${fmt(have)} 0G) is below the ~${fmt(need)} 0G ${files.length === 1 ? 'this file needs' : 'these files need'} up front (about a week of storage). Deposit now?`
          ) && (await topUp(Number(formatEther(need * 10n > 10n ** 17n ? need * 10n : 10n ** 17n)).toString()))
        if (!ok) {
          const ids = new Set(items.map((i) => i.id))
          setQueue((q) => q.map((x) => (ids.has(x.id) ? { ...x, state: 'error', message: 'storage balance too low — deposit, then upload again', percent: undefined } : x)))
          return
        }
      }
      await uploadBatched(store, path, items, files, replace)
    },
    [wallet, masterKeyHex, uploadBatched, topUp]
  )

  // Drops never get lost: each one is queued immediately (target folder
  // captured now) and runs after the batches before it.
  const uploadChain = useRef<Promise<void>>(Promise.resolve())
  const uploadFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const store = storeRef.current
      if (!wallet || !store || !masterKeyHex) return
      const path = view === 'trash' ? '' : currentPath
      const picked = Array.from(fileList) // the input's FileList is reset right after

      // names already in the folder, still on their way there, or repeated
      // in this drop: ask what to do (names stay unique in a folder)
      const lower = (n: string) => n.toLowerCase()
      const existing = new Map((drive?.folders.get(path)?.files ?? []).map((f) => [lower(f.name), f]))
      const pending = new Set(
        queue.filter((q) => q.path === path && q.state !== 'done' && q.state !== 'error').map((q) => lower(q.name))
      )
      // the first file of each free name goes as is; the others clash
      const clashing: number[] = []
      const free = new Set<string>()
      picked.forEach((f, i) => {
        const k = lower(f.name)
        if (existing.has(k) || pending.has(k) || free.has(k)) clashing.push(i)
        else free.add(k)
      })
      let files = picked
      const replace: string[] = []
      if (clashing.length > 0) {
        const taken = new Set([...existing.keys(), ...pending, ...free])
        const suggested = new Set<string>()
        const replacing = new Set<string>()
        const items: DupItem[] = clashing.map((i) => {
          const name = picked[i].name
          const k = lower(name)
          const suggestion = uniqueName(name, new Set([...taken, ...suggested]))
          suggested.add(lower(suggestion))
          // one file per name can take an existing file's place
          const replaceable = existing.has(k) && !pending.has(k) && !replacing.has(k)
          if (replaceable) replacing.add(k)
          return { name, suggestion, replaceable }
        })
        setDupNames(items.map((it) => it.suggestion))
        const choice = await new Promise<DupChoice>((resolve) => setDupAsk({ items, taken, resolve }))
        setDupAsk(null)
        if (choice.kind === 'cancel') return
        files = picked.filter((_, i) => !clashing.includes(i))
        if (choice.kind === 'keep' || choice.kind === 'replace') {
          clashing.forEach((i, j) => {
            const f = picked[i]
            if (choice.kind === 'replace' && items[j].replaceable) {
              replace.push(existing.get(lower(f.name))!.id)
              files.push(f)
            } else {
              files.push(new File([f], choice.names[j], { type: f.type, lastModified: f.lastModified }))
            }
          })
        }
        if (files.length === 0) {
          log('Nothing uploaded: every file was skipped.')
          return
        }
      }

      const items: QueueItem[] = files.map((f) => ({
        id: 'q_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        name: f.name,
        path,
        size: f.size,
        state: 'queued',
        message: path ? `waiting · to ${path}` : 'waiting',
      }))
      setQueue((q) => [...q, ...items])
      uploadChain.current = uploadChain.current
        .then(() => runUpload(store, path, items, files, replace))
        .catch((err) => log(`Upload failed: ${(err as Error).message}`))
    },
    [wallet, masterKeyHex, currentPath, view, drive, queue, log, runUpload]
  )

  // ─── Download (owner) ───────────────────────────────────────────────

  const fileKeyFor = useCallback(
    async (meta: FileMeta): Promise<Uint8Array | null> => {
      if (!masterKeyHex) return null
      if (meta.wrappedKey) {
        try {
          return await unwrapFileKey(hexToBytes(masterKeyHex), meta.wrappedKey)
        } catch (err) {
          log(`Key unwrap failed for ${meta.name}: ${(err as Error).message}`)
          return null
        }
      }
      return hexToBytes(masterKeyHex) // pre-M3 legacy: master-key-encrypted
    },
    [masterKeyHex, log]
  )

  /** A drive file's bytes, from the drive's backend (reads need no account, so also before the drive is open). */
  const readFile = useCallback(
    (meta: FileMeta, opts?: DownloadOpts) =>
      storeRef.current ? storeRef.current.backend.download(meta, opts) : readV2(meta.rootHashes, opts),
    []
  )

  /** Download + decrypt a file into memory (preview, thumbnails, indexing).
   *  Single-fragment files are cached on this device as stored (encrypted)
   *  and decrypted after every read — see fileCache.ts. */
  const loadBytes = useCallback(
    async (meta: FileMeta, onProgress?: (msg: string, pct?: number) => void) => {
      const fileKey = meta.encryption === 'none' ? null : await fileKeyFor(meta)
      if (meta.encryption !== 'none' && !fileKey) throw new Error('cannot unwrap the file key')
      if (meta.rootHashes.length === 1 && meta.size <= FILE_CACHE_MAX_BYTES) {
        const raw = await cachedOrDownload(fileCacheKey(meta.rootHashes), async () =>
          (await readFile(meta, { onProgress })).data
        )
        if (!fileKey) return raw
        const { data, decrypted } = decryptDownloaded(raw, { symmetricKey: fileKey })
        if (!decrypted) throw new Error('decryption failed (wrong key?)')
        return data
      }
      const { data, decrypted } = await readFile(meta, {
        decryption: fileKey ? { symmetricKey: fileKey } : undefined,
        onProgress,
      })
      if (fileKey && !decrypted) throw new Error('decryption failed (wrong key?)')
      return data
    },
    [fileKeyFor, readFile]
  )

  const download = useCallback(
    async (meta: FileMeta) => {
      if (!wallet) return
      const fileKey = await fileKeyFor(meta)
      if (meta.encryption !== 'none' && !fileKey) return
      setBusy(`Downloading ${meta.name}…`)
      try {
        // streaming to disk when the browser supports it
        if (window.showSaveFilePicker) {
          const handle = await window.showSaveFilePicker({ suggestedName: meta.name })
          const writable = await handle.createWritable()
          let chain = Promise.resolve()
          await readFile(meta, {
            decryption:
              meta.encryption === 'none'
                ? undefined
                : { symmetricKey: fileKey! },
            onProgress: (msg, pct) => log(`${meta.name}: ${msg}`, pct),
            onPlainChunk: (chunk) => {
              chain = chain.then(() => writable.write(chunk))
            },
          })
          await chain
          await writable.close()
          log(`${meta.name} streamed to disk.`)
        } else {
          const { data, decrypted } = await readFile(meta, {
            decryption:
              meta.encryption === 'none'
                ? undefined
                : { symmetricKey: fileKey! },
            onProgress: (msg, pct) => log(`${meta.name}: ${msg}`, pct),
          })
          if (meta.encryption !== 'none' && !decrypted) {
            log(`⚠ ${meta.name}: decryption failed (wrong key?) — saved ciphertext.`)
          }
          await saveBytes(data, meta.name, meta.mime)
          log(`${meta.name} downloaded.`)
        }
      } catch (err) {
        log(`${meta.name} download failed: ${(err as Error).message}`)
      } finally {
        setBusy(null)
      }
    },
    [wallet, fileKeyFor, log, readFile]
  )

  // ─── Sharing ────────────────────────────────────────────────────────

  const openShare = useCallback((meta: FileMeta) => {
    setShareFor(meta)
    setShareMode('A')
    setShareRecipient('')
    setShareLink(null)
    setShareError(null)
  }, [])

  const doShare = useCallback(async () => {
    if (!shareFor || !masterKeyHex) return
    setShareBusy('Preparing…')
    setShareError(null)
    setShareLink(null)
    try {
      const fileKey = await fileKeyFor(shareFor)
      if (!fileKey) throw new Error('cannot unwrap file key')
      const base = window.location.origin + window.location.pathname

      if (shareMode === 'A') {
        const link = base + buildShareLink({
          v: 1, n: shareFor.name, m: shareFor.mime, z: shareFor.size,
          r: shareFor.rootHashes, q: [],
          k: bytesToHex(fileKey),
        })
        setShareLink(link)
        log(`Share link created for ${shareFor.name}.`)
      } else {
        const recipient = shareRecipient.trim()
        if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
          throw new Error('enter a valid recipient address')
        }
        setShareBusy('Looking up recipient share key…')
        const found = await lookupDrive(recipient, false)
        if (!found) {
          throw new Error('this address has no 0GDrive yet (the recipient needs to open 0GDrive and create one)')
        }
        const shareKey = found.card.shareKey
        if (!shareKey) {
          throw new Error('this address’s drive was set up with a recovery password only, so it can’t receive files by address: send a share link instead')
        }
        setShareBusy('Wrapping key…')
        const wrapped = await wrapFileKeyToPubKey(shareKey, fileKey)
        const link = base + buildEncryptedShareLink({
          v: 1, n: shareFor.name, m: shareFor.mime, z: shareFor.size,
          r: shareFor.rootHashes, q: [],
          w: wrapped, to: recipient, d: 1, p: shareKey,
        })
        setShareLink(link)
        log(`Encrypted share created for ${shortHash(recipient)}.`)
      }
    } catch (err) {
      setShareError((err as Error).message)
    } finally {
      setShareBusy(null)
    }
  }, [shareFor, shareMode, shareRecipient, masterKeyHex, fileKeyFor, log])

  // ─── Drive ops (unchanged from M2) ───────────────────────────────────

  const trashFile = useCallback(
    async (meta: FileMeta) => {
      const store = storeRef.current
      if (!store) return
      if (view === 'trash' && !window.confirm(`Delete "${meta.name}" forever? The file is deleted from 0G Storage; links you shared stop working.`)) return
      setBusy(view === 'trash' ? `Deleting ${meta.name}…` : `Moving ${meta.name} to trash…`)
      try {
        if (view === 'trash') {
          await store.purgeFromTrash(meta.id)
          log(`${meta.name} deleted forever.`)
        } else {
          await store.removeFileRecord(currentPath, meta.id, true)
          log(`${meta.name} moved to trash.`)
        }
        await reloadDrive()
      } catch (err) {
        log(`Trash failed: ${(err as Error).message}`)
      } finally {
        setBusy(null)
      }
    },
    [currentPath, view, log, reloadDrive]
  )

  const openRename = useCallback((meta: FileMeta) => {
    setRenameFor({ kind: 'file', meta })
    setRenameTo(meta.name)
    setRenameError(null)
  }, [])

  const openFolderRename = useCallback((path: string) => {
    setRenameFor({ kind: 'folder', path })
    setRenameTo(baseName(path))
    setRenameError(null)
    setNavOpen(false)
  }, [])

  const submitRename = useCallback(async () => {
    const store = storeRef.current
    const target = renameFor
    if (!store || !target) return
    const name = renameTo.trim()
    const oldName = target.kind === 'file' ? target.meta.name : baseName(target.path)
    if (name === oldName) {
      setRenameFor(null)
      return
    }
    setRenameError(null)
    setBusy(`Renaming ${oldName}…`)
    try {
      if (target.kind === 'file') {
        const search = await entryForRename(target.meta.search, name)
        await store.renameFile(currentPath, target.meta.id, name, search)
        log(`Renamed ${oldName} → ${name}.`)
      } else {
        const newPath = await store.renameFolder(target.path, name)
        log(`Renamed folder ${target.path} → ${newPath}.`)
        // the open folder and expanded tree rows follow the new path
        const moved = (p: string) =>
          p === target.path ? newPath : p.startsWith(target.path + '/') ? newPath + p.slice(target.path.length) : p
        setCurrentPath(moved)
        setExpandedFolders((prev) => prev.map(moved))
      }
      setRenameFor(null)
      await reloadDrive()
    } catch (err) {
      setRenameError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }, [renameFor, renameTo, currentPath, log, reloadDrive])

  const restoreFile = useCallback(
    async (meta: FileMeta) => {
      const store = storeRef.current
      if (!store) return
      setBusy(`Restoring ${meta.name}…`)
      try {
        const renamed = await store.restoreFromTrash(meta.id)
        log(
          renamed.length > 0
            ? `${meta.name} restored to ${meta.originalPath || 'drive root'} as “${renamed[0].to}”: a file named “${meta.name}” is already there.`
            : `${meta.name} restored to ${meta.originalPath || 'drive root'}.`
        )
        await reloadDrive()
      } catch (err) {
        log(`Restore failed: ${(err as Error).message}`)
      } finally {
        setBusy(null)
      }
    },
    [log, reloadDrive]
  )

  // ─── Batch selection operations ──────────────────────────────────────

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }, [])

  const openMove = useCallback((target: MoveTarget) => {
    setMoveFor(target)
    setMoveDest(null)
    setMovePending([])
    setMoveNewName(null)
    setMoveError(null)
    setNavOpen(false)
  }, [])

  const submitMove = useCallback(async () => {
    const store = storeRef.current
    const target = moveFor
    const dest = moveDest
    if (!store || !target || dest === null) return
    const where = dest === '' ? 'My drive' : dest
    setMoveError(null)
    setBusy(target.kind === 'folder' ? `Moving ${target.path}…` : `Moving ${target.label}…`)
    try {
      if (target.kind === 'folder') {
        const newPath = await store.moveFolder(target.path, dest)
        log(`Moved folder ${target.path} → ${newPath}.`)
        // the open folder and expanded tree rows follow the new path
        const moved = (p: string) =>
          p === target.path ? newPath : p.startsWith(target.path + '/') ? newPath + p.slice(target.path.length) : p
        setCurrentPath(moved)
        setExpandedFolders((prev) => [...prev.map(moved), dest])
      } else {
        await store.moveRecords(target.from, target.ids.map((id) => ({ id, to: dest })), { refuseNameClash: true })
        log(`Moved ${target.label} to ${where}.`)
        setSelectedIds([])
      }
      setMoveFor(null)
      await reloadDrive()
    } catch (err) {
      setMoveError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }, [moveFor, moveDest, log, reloadDrive])

  const trashSelected = useCallback(async () => {
    const store = storeRef.current
    if (!store || selectedIds.length === 0) return
    const n = selectedIds.length
    if (!window.confirm(`Move ${n} file${n === 1 ? '' : 's'} to trash?`)) return
    setBusy(`Moving ${n} file${n === 1 ? '' : 's'} to trash…`)
    try {
      await store.removeFileRecords(view === 'trash' ? TRASH_PATH : currentPath, selectedIds, view !== 'trash')
      log(`${n} file${n === 1 ? '' : 's'} moved to trash.`)
      setSelectedIds([])
      await reloadDrive()
    } catch (err) {
      log(`Batch trash failed: ${(err as Error).message}`)
    } finally {
      setBusy(null)
    }
  }, [storeRef, selectedIds, currentPath, view, log, reloadDrive])

  const restoreSelected = useCallback(async () => {
    const store = storeRef.current
    if (!store || selectedIds.length === 0) return
    const n = selectedIds.length
    setBusy(`Restoring ${n} file${n === 1 ? '' : 's'}…`)
    try {
      const renamed = await store.restoreRecords(selectedIds)
      log(`${n} file${n === 1 ? '' : 's'} restored.`)
      for (const r of renamed) log(`“${r.from}” restored as “${r.to}”: a file with its name is already in that folder.`)
      setSelectedIds([])
      await reloadDrive()
    } catch (err) {
      log(`Batch restore failed: ${(err as Error).message}`)
    } finally {
      setBusy(null)
    }
  }, [storeRef, selectedIds, log, reloadDrive])

  const newFolder = useCallback(async () => {
    const store = storeRef.current
    if (!store) return
    const name = window.prompt('New folder name:')
    if (!name?.trim()) return
    const path = currentPath === '' ? name.trim() : currentPath + '/' + name.trim()
    setBusy(`Creating folder ${name}…`)
    try {
      await store.createFolder(path)
      log(`Folder ${path} created.`)
      await reloadDrive()
    } catch (err) {
      log(`Create folder failed: ${(err as Error).message}`)
    } finally {
      setBusy(null)
    }
  }, [currentPath, log, reloadDrive])

  const removeFolder = useCallback(
    async (path: string) => {
      const store = storeRef.current
      if (!store) return
      // count files in this folder and all descendants for the confirm
      const count =
        drive?.paths
          .filter((f) => f === path || f.startsWith(path + '/'))
          .reduce((n, f) => n + (drive.folders.get(f)?.files.length ?? 0), 0) ?? 0
      const msg =
        count > 0
          ? `Move "${path}" and ${count} file${count === 1 ? '' : 's'} to trash?`
          : `Delete the empty folder "${path}"?`
      if (!window.confirm(msg)) return
      setBusy(`Moving ${path} to trash…`)
      try {
        await store.trashFolder(path)
        log(`Folder ${path} moved to trash${count > 0 ? ` (${count} files)` : ''}.`)
        if (currentPath === path || currentPath.startsWith(path + '/')) {
          setView('drive')
          setCurrentPath('')
        }
        await reloadDrive()
      } catch (err) {
        log(`Folder trash failed: ${(err as Error).message}`)
      } finally {
        setBusy(null)
      }
    },
    [drive, currentPath, log, reloadDrive]
  )

  const uploading = queue.some((q) => q.state !== 'done' && q.state !== 'error')
  const smart = useSmartDrive({
    drive, storeRef, currentPath, loadBytes, reloadDrive, log, setBusy, readOnly,
    paused: busy !== null || uploading || previewFor !== null,
  })

  /** what the assistant may know about this drive: on/off facts only — no address, names or keys */
  const assistantStatus = (): DriveStatus => ({
    screen: drive ? 'drive' : 'start',
    walletConnected: !!wallet && !readOnly,
    network: `${NETWORK.chainName} (Storage V2)`,
    driveOpen: !!masterKeyHex,
    readOnly,
    recovery: hasBackup ? 'on' : hasBackup === false ? 'off' : wallet && !backupCheckError ? 'checking' : 'unknown',
    password: hasPassword ? 'set' : hasPassword === false ? 'not-set' : 'unknown',
    shareKey: card?.shareKey ? 'published' : hasBackup === false ? 'not-published' : hasBackup === null ? 'checking' : 'unknown',
    onDeviceAi: !smart.enabled ? 'off' : smart.model.loading ? 'loading' : smart.model.error ? 'error' : 'ready',
    view,
    uploading: queue.some((q) => q.state !== 'done' && q.state !== 'error'),
    // the storage balance pays for the drive; the wallet only for deposits
    lowBalance: !!wallet && !readOnly && balance !== null && balance < 10n ** 16n,
  })
  // what the Security section still lacks, for its folded heading (the rows' own words)
  const securityGaps: string[] = []
  if (card && !card.wrappedUnderSignature && !card.wrappedUnderPassword) securityGaps.push('Recovery off')
  if (hasPassword === false) securityGaps.push('Password not set')
  if (card?.wrappedUnderSignature && !card.shareKey) securityGaps.push('Share key not published')

  const showForAssistant = (target: string) =>
    highlight(target, (sidebar, section) => {
      if (target === 'lost-wallet') setLostOpen(true)
      if (section) setSectionFolded(section, false)
      if (isNarrow()) {
        // on a phone the panel covers the page: get out of the way
        setAssistOpen(false)
        if (sidebar) setNavOpen(true)
      }
    })

  // the mobile drawer closes once the user has navigated somewhere
  useEffect(() => {
    setNavOpen(false)
  }, [view, currentPath])

  useEffect(() => {
    if (!navOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navOpen])

  // ─── Render ─────────────────────────────────────────────────────────

  if (shared) {
    return (
      <ShareView
        mode={shared.mode}
        payload={shared.payload}
        onExit={() => {
          window.location.hash = ''
          setShared(null)
        }}
        log={log}
      />
    )
  }

  const pathSegments = currentPath === '' ? [] : currentPath.split('/')
  const chooseLayout = (l: 'list' | 'grid') => {
    setLayout(l)
    try {
      localStorage.setItem('0gdrive:layout', l)
    } catch {
      // per-browser convenience only
    }
  }

  const fileActions = (f: FileMeta) =>
    view === 'trash' ? (
      readOnly ? null : (
      <>
        <button className="btn small" disabled={busy !== null} onClick={() => restoreFile(f)} title="Restore" aria-label="Restore">
          <ActionLabel icon="restore" />
        </button>
        <button className="btn small danger" disabled={busy !== null} onClick={() => trashFile(f)} title="Delete forever" aria-label="Delete forever">
          <ActionLabel icon="close" />
        </button>
      </>
      )
    ) : (
      <>
        <button className="btn small" disabled={busy !== null} onClick={() => download(f)} title="Download" aria-label="Download">
          <ActionLabel icon="download" />
        </button>
        <button
          className="btn small"
          disabled={busy !== null || !f.wrappedKey}
          title={f.wrappedKey ? 'Share this file' : 'Legacy file — re-upload to enable sharing'}
          onClick={() => openShare(f)}
          aria-label="Share"
        >
          <ActionLabel icon="share" />
        </button>
        {!readOnly && (
          <button className="btn small" disabled={busy !== null} title="Move to…" aria-label="Move to…"
            onClick={() => openMove({ kind: 'files', ids: [f.id], from: currentPath, label: f.name })}>
            <ActionLabel icon="move" />
          </button>
        )}
        {!readOnly && (
          <button className="btn small" disabled={busy !== null} onClick={() => openRename(f)} title="Rename" aria-label="Rename">
            <ActionLabel icon="rename" />
          </button>
        )}
        {!readOnly && (
          <button className="btn small danger" disabled={busy !== null} onClick={() => trashFile(f)} title="Move to trash" aria-label="Move to trash">
            <ActionLabel icon="trash" />
          </button>
        )}
      </>
    )

  const shownFiles =
    view === 'trash'
      ? drive?.trash?.files ?? []
      : drive?.folders.get(currentPath)?.files ?? []
  const toggleAll = () =>
    setSelectedIds(selectedIds.length === shownFiles.length ? [] : shownFiles.map((f) => f.id))

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          {drive && (
            <button
              className="nav-toggle"
              onClick={() => setNavOpen((o) => !o)}
              aria-label="Folders and settings"
              aria-expanded={navOpen}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
            </button>
          )}
          <Logo className="logo-mark" />
          <span className="brand-name">Drive</span>
          <span className="network-badge">
            {NETWORK.chainName} · Storage V2
          </span>
        </div>
        <div className="header-right">
          {readOnly && (
            <>
              <span className="network-badge ro-badge" title="Opened with the recovery password — no wallet connected">
                read-only
              </span>
              <button className="btn small" onClick={() => window.location.reload()} title="Close this drive (its key is not kept on this device)">
                Exit
              </button>
            </>
          )}
          {wallet && !readOnly && (
            <span className="balance" title={`${wallet.balance} 0G`}>
              <span className="balance-label">Balance: </span>
              {Number(wallet.balance).toFixed(4)} 0G
            </span>
          )}
          {wallet ? (
            <span className="address-wrap">
            <span className="address" title={wallet.address}>
              {shortHash(wallet.address)}
              <button
                className="copy-btn"
                onClick={() => {
                  void navigator.clipboard.writeText(wallet.address).then(() => {
                    setAddressCopied(true)
                    setTimeout(() => setAddressCopied(false), 1500)
                  })
                }}
                title={addressCopied ? 'Copied' : 'Copy address'}
                aria-label={addressCopied ? 'Address copied' : 'Copy wallet address'}
              >
                {addressCopied ? (
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                ) : (
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="8" y="8" width="12" height="12" rx="2" />
                    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
                  </svg>
                )}
              </button>
              {!readOnly && (
                <button
                  className="copy-btn wallet-menu-btn"
                  onClick={() => setWalletMenu((o) => !o)}
                  title="Switch wallet or disconnect"
                  aria-label="Wallet menu"
                  aria-haspopup="menu"
                  aria-expanded={walletMenu}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                </button>
              )}
            </span>
            {walletMenu && (
              <div className="wallet-menu" role="menu">
                <button role="menuitem" onClick={() => void switchAccount()}>
                  Switch wallet or account
                </button>
                <button role="menuitem" className="danger" onClick={disconnect}>
                  Disconnect
                </button>
              </div>
            )}
            </span>
          ) : (
            <button className="btn primary" onClick={connect} disabled={reconnecting} data-guide="connect">
              {reconnecting ? 'Connecting…' : 'Connect wallet'}
            </button>
          )}
        </div>
      </header>

      {!hasExtension() && !isTouchDevice() && (
        <div className="banner warn">
          No Ethereum wallet detected. Install a wallet extension such as <strong>MetaMask</strong> or{' '}
          <strong>Rabby</strong> to use 0GDrive{hasWallet() ? ', or connect the wallet app on your phone with WalletConnect' : ''}.
        </div>
      )}

      {!wallet && (
        <div className="banner key lost-wallet">
          {!lostOpen ? (
            <div>
              Lost access to your wallet?{' '}
              <button className="link" onClick={() => setLostOpen(true)}>
                Open your drive with its recovery password
              </button>
            </div>
          ) : (
            <div>
              <strong>Open a drive with its recovery password.</strong> Read-only: browse,
              preview and download your files. No wallet needed, nothing sent on-chain.
              <form
                className="banner-actions"
                onSubmit={(e) => {
                  e.preventDefault()
                  void recoverWithoutWallet()
                }}
              >
                <input
                  className="key-input"
                  placeholder="drive's wallet address 0x…"
                  value={lostAddress}
                  onChange={(e) => setLostAddress(e.target.value)}
                  autoComplete="off"
                />
                <input
                  className="key-input"
                  type="password"
                  placeholder="recovery password"
                  value={lostPassword}
                  onChange={(e) => setLostPassword(e.target.value)}
                  autoComplete="current-password"
                />
                <button className="btn primary" type="submit" disabled={lostBusy !== null || !lostAddress.trim() || !lostPassword}>
                  {lostBusy ?? 'Open drive'}
                </button>
                <button className="btn" type="button" onClick={() => { setLostOpen(false); setLostError(null) }}>
                  Cancel
                </button>
              </form>
              {lostError && <p className="error-text">⚠ {lostError}</p>}
            </div>
          )}
        </div>
      )}

      {readOnly && (
        <div className="banner">
          <strong>Read-only.</strong> This drive was opened with its recovery password: you can
          browse, preview, download and share files. Uploading or changing anything needs the
          drive’s wallet. Export the key file from the sidebar to keep a copy of the drive key.
        </div>
      )}

      {wallet && !readOnly && !(masterKeyHex && card) && (
        <div className="banner key">
          {hasBackup === null && backupCheckError ? (
            <div>
              <strong>Couldn't check this account for an existing drive.</strong> The
              chain query failed ({backupCheckError}). Retry before creating a new drive —
              a new drive would not open an existing one.
              <div className="banner-actions">
                <button className="btn primary" onClick={() => wallet && void checkBackup(wallet.address)}>
                  Retry
                </button>
              </div>
            </div>
          ) : hasBackup === null ? (
            <div>
              <strong>Looking for your drive…</strong> (checking this wallet’s storage
              deposits on 0G)
            </div>
          ) : hasBackup && card && !card.wrappedUnderSignature ? (
            <div>
              <strong>This wallet has a drive on 0G, locked with a recovery password.</strong> Enter
              it to open the drive on this device, or import its key file.
              <form
                className="banner-actions"
                onSubmit={(e) => {
                  e.preventDefault()
                  void restoreByPassword()
                }}
              >
                <input
                  className="key-input"
                  placeholder="recovery password"
                  type="password"
                  value={restorePassword}
                  onChange={(e) => setRestorePassword(e.target.value)}
                  autoComplete="current-password"
                />
                <button className="btn primary" type="submit" disabled={restoreBusy !== null || !restorePassword.trim()}>
                  {restoreBusy ?? 'Restore my drive'}
                </button>
              </form>
              {restoreError && <p className="error-text">⚠ {restoreError}</p>}
              <details>
                <summary className="muted">advanced: import a key file</summary>
                <div className="banner-actions">
                  <input
                    className="key-input"
                    placeholder="paste 0x… backup key"
                    value={keyImport}
                    onChange={(e) => setKeyImport(e.target.value)}
                  />
                  <button className="btn" onClick={importKey}>Import</button>
                </div>
              </details>
            </div>
          ) : hasBackup ? (
            <div>
              <strong>This wallet has a drive on 0G.</strong> Restore it on this device with one
              wallet signature — no files, no passwords needed.
              <div className="banner-actions">
                <button className="btn primary" disabled={restoreBusy !== null} onClick={restoreBySignature}>
                  {restoreBusy ?? 'Restore my drive'}
                </button>
                <button
                  className="btn"
                  onClick={() => setShowPasswordRestore(!showPasswordRestore)}
                >
                  Use password instead
                </button>
              </div>
              {showPasswordRestore && (
                <div className="banner-actions">
                  <input
                    className="key-input"
                    placeholder="recovery password"
                    type="password"
                    value={restorePassword}
                    onChange={(e) => setRestorePassword(e.target.value)}
                  />
                  <button className="btn" disabled={restoreBusy !== null || !restorePassword.trim()} onClick={restoreByPassword}>
                    Restore
                  </button>
                </div>
              )}
              {restoreError && <p className="error-text">⚠ {restoreError}</p>}
              <details>
                <summary className="muted">advanced: import a key file</summary>
                <div className="banner-actions">
                  <input
                    className="key-input"
                    placeholder="paste 0x… backup key"
                    value={keyImport}
                    onChange={(e) => setKeyImport(e.target.value)}
                  />
                  <button className="btn" onClick={importKey}>Import</button>
                </div>
              </details>
            </div>
          ) : (
            <div>
              <strong>{masterKeyHex ? 'Finish creating your drive.' : 'Create your drive.'}</strong> A key is
              generated in this browser; files are encrypted with it before ever leaving your device.
              Setup asks your wallet for 3 signatures (recovery and sharing, then linking your wallet to
              your drive) and one deposit of {FIRST_DEPOSIT} 0G to your storage balance, which pays for
              the space your files take.
              <div className="banner-actions">
                <button className="btn primary" disabled={restoreBusy !== null} onClick={() => void createDrive()}>
                  {restoreBusy ?? (masterKeyHex ? 'Finish setup' : 'Create my drive')}
                </button>
                {!masterKeyHex && (
                  <>
                    <input
                      className="key-input"
                      placeholder="or import an existing 0x… key"
                      value={keyImport}
                      onChange={(e) => setKeyImport(e.target.value)}
                    />
                    <button className="btn" onClick={importKey}>Import</button>
                  </>
                )}
              </div>
              {restoreError && <p className="error-text">⚠ {restoreError}</p>}
              {unstableFor === wallet.address && (
                <form
                  className="password-setup"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void createDriveWithPassword()
                  }}
                >
                  <strong>Set up with a recovery password instead.</strong> Your drive key is locked
                  with this password and kept with your drive on 0G: it’s how you open the drive on
                  another device (or with its key file). Nobody can reset it. Setup asks for 1 signature
                  (linking your wallet to your drive) and the {FIRST_DEPOSIT} 0G deposit. Others can’t
                  send you files by your address; share links still work.
                  <div className="banner-actions">
                    <input
                      className="key-input"
                      type="password"
                      placeholder={`recovery password (at least ${MIN_PASSWORD} characters)`}
                      value={setupPw1}
                      onChange={(e) => setSetupPw1(e.target.value)}
                      autoComplete="new-password"
                    />
                    <input
                      className="key-input"
                      type="password"
                      placeholder="type it again"
                      value={setupPw2}
                      onChange={(e) => setSetupPw2(e.target.value)}
                      autoComplete="new-password"
                    />
                    <button className="btn primary" type="submit" disabled={restoreBusy !== null || !setupPw1 || !setupPw2}>
                      {restoreBusy ?? 'Create with password'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
        </div>
      )}

      {wallet && !readOnly && masterKeyHex && card && keyFileNudge && (
        <div className="banner key">
          <strong>Your drive is ready.</strong> It opens on another device only with its recovery
          password or its key file: export the key file and keep it somewhere safe.
          <div className="banner-actions">
            <button className="btn primary" onClick={downloadKeyBackup}>Export key file</button>
            <button className="btn" onClick={() => setKeyFileNudge(false)}>Later</button>
          </div>
        </div>
      )}

      <main className="main">
        <div className="layout">
        {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}
        <aside className={`sidebar${navOpen ? ' open' : ''}`}>
          {drive ? (
            <>
              <nav className="nav">
                <button
                  className={`nav-item${view === 'drive' && currentPath === '' ? ' active' : ''}`}
                  onClick={() => { setView('drive'); setCurrentPath('') }}
                >
                  <FolderGlyph />
                  <span>My Drive</span>
                </button>
                {buildTree(drive.paths).map((node) => (
                  <TreeRow
                    key={node.path}
                    node={node}
                    depth={1}
                    currentPath={view === 'drive' ? currentPath : ''}
                    expanded={expandedFolders}
                    onToggle={toggleFolder}
                    onSelect={(p) => { setView('drive'); setCurrentPath(p) }}
                    onRename={openFolderRename}
                    onMove={(p) => openMove({ kind: 'folder', path: p })}
                    onRemove={removeFolder}
                    disabled={busy !== null || readOnly}
                  />
                ))}
                <button
                  className={`nav-item${view === 'trash' ? ' active' : ''}`}
                  onClick={() => setView('trash')}
                  data-guide="trash"
                >
                  <svg className="tree-folder-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6" /></svg>
                  <span>Trash</span>
                  {drive.trash?.files.length ? (
                    <span className="nav-count">{drive.trash.files.length}</span>
                  ) : null}
                </button>
              </nav>
              {wallet && masterKeyHex && !readOnly && (
                <SideSection
                  id="storage"
                  title="Storage"
                  summary={balance === null ? null : <span className={balance < 10n ** 16n ? 'sec-off' : undefined}>{fmtBalance(balance)} 0G</span>}
                  folded={folded.has('storage')}
                  onToggle={toggleSection}
                >
                  <div className="sec-grid">
                    <SecRow
                      id="storage"
                      hint="Your storage balance on 0G: it pays for the space your files take. Deposits come from your wallet."
                      status={
                        balance === null ? (
                          <SecOff>Checking…</SecOff>
                        ) : balance < 10n ** 16n ? (
                          <SecOff>{fmtBalance(balance)} 0G</SecOff>
                        ) : (
                          <SecOk>{fmtBalance(balance)} 0G</SecOk>
                        )
                      }
                      action={
                        <button
                          className="sec-action primary"
                          onClick={() => void topUp()}
                          disabled={depositBusy !== null}
                          aria-label="Deposit to storage balance"
                          title="1 transaction from your wallet"
                        >
                          {depositBusy ?? 'Deposit'}
                        </button>
                      }
                    />
                  </div>
                </SideSection>
              )}
              {wallet && masterKeyHex && (
                <SideSection
                  id="security"
                  title="Security"
                  summary={readOnly ? null : securityGaps.length ? <span className="sec-off">{securityGaps.join(' · ')}</span> : <SecOk>All set</SecOk>}
                  folded={folded.has('security')}
                  onToggle={toggleSection}
                >
                  <div className="sec-grid">
                    {!readOnly && (
                      <>
                        <SecRow
                          id="recovery"
                          label="Recovery"
                          hint={
                            card && !card.wrappedUnderSignature && card.wrappedUnderPassword
                              ? 'Your drive key, locked to your recovery password and kept with your drive on 0G'
                              : 'Your drive key, locked to a wallet signature and kept with your drive on 0G'
                          }
                          status={
                            card?.wrappedUnderSignature ? <SecOk>On</SecOk> : card?.wrappedUnderPassword ? <SecOk>Password only</SecOk> : <SecOff>Off</SecOff>
                          }
                        />
                        <SecRow
                          id="password"
                          label="Password"
                          hint="Opens your drive read-only if you lose this wallet"
                          status={hasPassword ? <SecOk>Set</SecOk> : <SecOff>{hasPassword === null && hasBackup ? 'Unknown' : 'Not set'}</SecOff>}
                          action={
                            <button
                              className="sec-action"
                              onClick={openPasswordDialog}
                              disabled={restoreBusy !== null}
                              aria-label={hasPassword ? 'Change recovery password' : 'Set recovery password'}
                            >
                              {hasPassword ? 'Change' : 'Set'}
                            </button>
                          }
                        />
                        <SecRow
                          id="share-key"
                          label="Share key"
                          hint="Lets others send you encrypted files that open with a wallet signature"
                          status={card?.shareKey ? <SecOk>Published</SecOk> : <SecOff>Not published</SecOff>}
                        />
                      </>
                    )}
                    <SecRow
                      id="key-file"
                      label="Key file"
                      hint="A copy of your drive key to keep offline"
                      action={
                        <button className="sec-action" onClick={downloadKeyBackup} aria-label="Export key file">
                          Export
                        </button>
                      }
                    />
                  </div>
                  {restoreError && !readOnly && <p className="error-text sec-error">⚠ {restoreError}</p>}
                </SideSection>
              )}
              <SideSection
                id="on-device-ai"
                title="On-device AI"
                summary={
                  !smart.enabled ? (
                    <span className="sec-off">Off</span>
                  ) : smart.model.loading ? (
                    <span className="sec-off">Loading…</span>
                  ) : smart.model.error ? (
                    <span className="sec-off">Names only</span>
                  ) : (
                    <SecOk>On</SecOk>
                  )
                }
                folded={folded.has('on-device-ai')}
                onToggle={toggleSection}
              >
                <label className="sec-item sec-toggle">
                  <input
                    type="checkbox"
                    checked={smart.enabled}
                    onChange={(e) => smart.toggle(e.target.checked)}
                  />
                  <span>Smart search &amp; organize</span>
                </label>
                <div className="sec-item muted">
                  {smart.model.loading
                    ? describeModelStatus(smart.model)
                    : smart.model.error && smart.enabled
                      ? `Models failed to load (${modelErrorReason(smart.model.error)}). Search matches names only; retry from the search box.`
                      : smart.enabled
                      ? 'Runs on this device. Models (~250 MB) download once.'
                      : isPhone()
                      ? 'Off — search matches file names only. Off on phones at first: the models need about 600 MB of memory.'
                      : 'Off — search matches file names only.'}
                </div>
                {smart.enabled && !readOnly && (smart.index.remaining > 0 || smart.index.unsaved > 0 || smart.index.nameOnly > 0) && (
                  <div className="sec-item muted search-index" aria-live="polite">
                    {smart.index.remaining > 0 && (
                      <div>
                        {smart.index.working
                          ? `Indexing ${smart.index.working}… ${smart.index.remaining} to go`
                          : `${smart.index.remaining} file${smart.index.remaining === 1 ? '' : 's'} to index for search`}
                      </div>
                    )}
                    {smart.index.unsaved > 0 && (
                      <div>
                        {smart.index.unsaved} indexed on this device ·{' '}
                        <button
                          className="link"
                          disabled={busy !== null || smart.saving}
                          onClick={() => void smart.saveIndex()}
                          title="Save these files' search entries in your drive, for your other devices (no wallet prompt). They're also saved with your next change."
                        >
                          Save
                        </button>
                      </div>
                    )}
                    {smart.index.nameOnly > 0 && (
                      <div title="Their content couldn't be read (or has no text), so search matches their names only.">
                        {smart.index.nameOnly} indexed by name only
                      </div>
                    )}
                  </div>
                )}
              </SideSection>
            </>
          ) : (
            <div className="sidebar-empty">
              {wallet ? 'Setting up your drive…' : 'Connect your wallet to begin.'}
            </div>
          )}
        </aside>

        <div className="content">
        {drive && (
          <section className="toolbar">
            <SearchBox
              value={smart.query}
              onChange={smart.setQuery}
              onClear={smart.clearSearch}
              searching={smart.searching}
              model={smart.model}
              onRetry={smart.retryModels}
            />
            <nav className="breadcrumb">
              <button className="crumb" onClick={() => { setView('drive'); setCurrentPath('') }}>
                My drive
              </button>
              {view === 'drive' && pathSegments.map((seg, i) => (
                <span key={i}>
                  <span className="crumb-sep">/</span>
                  <button
                    className="crumb"
                    onClick={() => { setView('drive'); setCurrentPath(pathSegments.slice(0, i + 1).join('/')) }}
                  >
                    {seg}
                  </button>
                </span>
              ))}
              {view === 'trash' && <span className="crumb-sep">/ Trash</span>}
            </nav>
            <div className="toolbar-actions">
              {selectedIds.length > 0 && !readOnly && (
                <div className="sel-bar">
                  <span className="sel-count">{selectedIds.length} selected</span>
                  {view === 'trash' ? (
                    <button className="btn small" disabled={busy !== null} onClick={restoreSelected}>
                      Restore selected
                    </button>
                  ) : (
                    <>
                      <button className="btn small" disabled={busy !== null}
                        onClick={() => openMove({
                          kind: 'files',
                          ids: selectedIds,
                          from: currentPath,
                          label: selectedIds.length === 1
                            ? shownFiles.find((f) => f.id === selectedIds[0])?.name ?? '1 file'
                            : `${selectedIds.length} files`,
                        })}>
                        Move to…
                      </button>
                      <button className="btn small danger" disabled={busy !== null} onClick={trashSelected}>
                        Trash selected
                      </button>
                    </>
                  )}
                  <button className="btn small" onClick={() => setSelectedIds([])}>Clear</button>
                </div>
              )}
              {view === 'drive' && !readOnly && (
                <button className="btn small" disabled={busy !== null} onClick={newFolder} data-guide="new-folder">
                  + New folder
                </button>
              )}
              <button className="btn small" disabled={busy !== null} onClick={reloadDrive} data-guide="sync">
                ⟳ Sync
              </button>
              <div className="layout-toggle" role="group" aria-label="Layout">
                <button
                  className={layout === 'list' ? 'active' : ''}
                  onClick={() => chooseLayout('list')}
                  title="List view"
                  aria-pressed={layout === 'list'}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
                </button>
                <button
                  className={layout === 'grid' ? 'active' : ''}
                  onClick={() => chooseLayout('grid')}
                  title="Grid view"
                  aria-pressed={layout === 'grid'}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" /></svg>
                </button>
              </div>
            </div>
          </section>
        )}

        {queue.length > 0 && (
          <section className="queue">
            <h2>
              Uploads <span className="count">{queue.filter((q) => q.state !== 'done' && q.state !== 'error').length} active</span>
              {queue.every((q) => q.state === 'done' || q.state === 'error') && (
                <button className="btn small" onClick={() => setQueue([])}>clear</button>
              )}
            </h2>
            {queue.map((q) => (
              <div key={q.id} className={`queue-item q-${q.state}`}>
                <span className="q-name">{q.name}</span>
                <span className="q-size">{fmtSize(q.size)}</span>
                <span className={`q-state s-${q.state}`}>
                  {q.state === 'uploading' && (q.percent !== undefined ? `${q.percent}%` : 'uploading')}
                  {q.state === 'approving' && '🔐 approve in your wallet'}
                  {q.state === 'sealing' && '⏳ sealing'}
                  {q.state === 'registering' && '📝 saving to your drive'}
                  {q.state === 'done' && `✓ ${q.message ?? 'stored'}`}
                  {q.state === 'error' && `✗ ${q.message ?? 'failed'}`}
                  {q.state === 'queued' && 'queued'}
                </span>
                {(q.state === 'uploading' || q.state === 'approving') && q.message && (
                  <span className="q-msg muted">{q.message}</span>
                )}
              </div>
            ))}
          </section>
        )}

        {wallet && !readOnly && (
        <section
          className={`dropzone ${dragOver ? 'over' : ''} ${!wallet || view === 'trash' || !masterKeyHex ? 'disabled' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files)
          }}
        >
          <label className="upload-label">
            <input
              type="file"
              multiple
              disabled={!wallet || view === 'trash' || !masterKeyHex}
              onChange={(e) => {
                if (e.target.files?.length) uploadFiles(e.target.files)
                e.target.value = ''
              }}
            />
            <div className="dropzone-inner">
              <div className="dropzone-title">
                {view === 'trash'
                  ? 'Trash view — switch to My drive to upload'
                  : (
                    <>
                      <span className="dz-pointer">Drop files here or click to upload</span>
                      <span className="dz-touch">Tap to upload files</span>
                      {currentPath !== '' && ` to ${currentPath}`}
                    </>
                  )}
              </div>
              <div className="dropzone-sub">
                Per-file encryption · no wallet prompt per upload · stored on 0G Storage
              </div>
            </div>
          </label>
        </section>
        )}

        {!wallet && !readOnly ? (
          <Welcome onConnect={connect} busy={reconnecting ? 'reconnecting' : connecting ? 'connecting' : null} error={connectError} />
        ) : smart.results !== null ? (
          <SearchResults
            query={smart.resultsQuery}
            results={smart.results}
            searching={smart.searching}
            renderThumb={(m) => <FileThumb meta={m} load={loadBytes} fallback={<FileIcon meta={m} />} />}
            onOpen={(m) => (canPreview(m) ? setPreviewFor(m) : void download(m))}
            onGoToFolder={(p) => {
              smart.clearSearch()
              setView('drive')
              setCurrentPath(p)
            }}
            actions={(m) => (
              <>
                <button className="btn small" disabled={busy !== null} onClick={() => download(m)} title="Download" aria-label="Download">
                  <ActionLabel icon="download" />
                </button>
                <button
                  className="btn small"
                  disabled={busy !== null || !m.wrappedKey}
                  title={m.wrappedKey ? 'Share this file' : 'Legacy file — re-upload to enable sharing'}
                  onClick={() => openShare(m)}
                  aria-label="Share"
                >
                  <ActionLabel icon="share" />
                </button>
              </>
            )}
            onClear={smart.clearSearch}
          />
        ) : (
        <section className="files">
          {view === 'drive' && drive && smart.enabled && shownFiles.length > 0 && !readOnly && (
            <div className="ai-bar">
              <button className="btn small" disabled={busy !== null || smart.suggesting} onClick={smart.findSuggestions}>
                {smart.suggesting ? 'Thinking…' : '✨ Suggest organization'}
              </button>
            </div>
          )}
          {smart.suggestions && view === 'drive' && (
            <SuggestionsPanel
              suggestions={smart.suggestions}
              busy={busy !== null}
              onApply={smart.applySuggestions}
              onDismiss={smart.dismissSuggestions}
            />
          )}
          <h2>
            {view === 'trash' ? 'Trash' : currentPath === '' ? 'My drive' : currentPath}{' '}
            <span className="count">{shownFiles.length}</span>
          </h2>
          {shownFiles.length === 0 && view === 'drive' && drive ? (
            <div className="hero">
              <HeroIcon />
              <h3>Your drive lives on 0G Storage</h3>
              <p className="hero-sub">
                Encrypted per file · paid from your storage balance · restorable on any device with one signature
              </p>
              <p className="hero-hint">Use the upload zone above to store your first file</p>
            </div>
          ) : shownFiles.length === 0 ? (
            <p className="empty">
              {view === 'trash' ? 'Trash is empty.' : ''}
            </p>
          ) : layout === 'grid' ? (
            <>
            <label className="grid-select-all">
              <SelectAllBox total={shownFiles.length} selected={selectedIds.length} onChange={toggleAll} />
              <span>Select all</span>
            </label>
            <div className="grid">
              {shownFiles.map((f) => {
                const selected = selectedIds.includes(f.id)
                const previewable = canPreview(f)
                return (
                  <div key={f.id} className={`tile${selected ? ' tile-selected' : ''}`}>
                    <button
                      className="tile-media"
                      onClick={() => (previewable ? setPreviewFor(f) : toggleSelected(f.id))}
                      title={previewable ? `Preview ${f.name}` : f.name}
                    >
                      <FileThumb
                        meta={f}
                        load={loadBytes}
                        className="tile-thumb"
                        hiRes
                        fallback={<span className="tile-icon"><FileIcon meta={f} large /></span>}
                      />
                      {f.mime.startsWith('video/') && <span className="tile-badge" aria-hidden="true">▶</span>}
                    </button>
                    <input
                      type="checkbox"
                      className="tile-check"
                      checked={selected}
                      onChange={() => toggleSelected(f.id)}
                      aria-label={`select ${f.name}`}
                    />
                    <div className="tile-info">
                      <span className="tile-name" title={f.name}>{f.name}</span>
                      <span className="tile-meta muted">
                        {fmtSize(f.size)} · {view === 'trash' && f.originalPath ? `from ${f.originalPath}` : fmtDate(f.uploadedAt)}
                      </span>
                    </div>
                    <div className="tile-actions">{fileActions(f)}</div>
                  </div>
                )
              })}
            </div>
            </>
          ) : (
            <table>
              <thead>
                <tr>
                  <th className="th-check">
                    <SelectAllBox total={shownFiles.length} selected={selectedIds.length} onChange={toggleAll} />
                  </th>
                  <th>Name</th>
                  <th className="col-wide">Size</th>
                  <th className="col-wide">Uploaded</th>
                  <th className="col-wide">Root</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {shownFiles.map((f) => (
                  <tr key={f.id} className={selectedIds.includes(f.id) ? 'row-selected' : ''}>
                    <td className="td-check">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(f.id)}
                        onChange={() => toggleSelected(f.id)}
                        aria-label={`select ${f.name}`}
                      />
                    </td>
                    <td className="fname">
                      <FileThumb meta={f} load={loadBytes} fallback={<FileIcon meta={f} />} />
                      <span className="fname-text">
                        {canPreview(f) ? (
                          <button className="fname-btn" onClick={() => setPreviewFor(f)} title="Preview">
                            {f.name}
                          </button>
                        ) : (
                          f.name
                        )}
                        {view === 'trash' && f.originalPath && (
                          <span className="muted"> (from {f.originalPath})</span>
                        )}
                        <span className="fname-sub muted">
                          {fmtSize(f.size)} · {fmtDate(f.uploadedAt)}
                        </span>
                      </span>
                    </td>
                    <td className="col-wide">{fmtSize(f.size)}</td>
                    <td className="col-wide">{fmtDate(f.uploadedAt)}</td>
                    <td className="col-wide">
                      <span title={f.rootHashes[0]}>{shortHash(f.rootHashes[0])}</span>
                    </td>
                    <td className="row-actions">{fileActions(f)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        )}

        <section className="activity">
          <h2>Activity</h2>
          {activities.length === 0 ? (
            <p className="empty">Nothing yet.</p>
          ) : (
            <ul>
              {activities.map((a) => (
                <li key={a.id}>
                  <span className="ts">{new Date(a.ts).toLocaleTimeString()}</span>{' '}
                  {a.msg}
                  {a.percent !== undefined && <span className="pct"> {a.percent}%</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
        </div>
        </div>
      </main>

      {previewFor && (
        <PreviewModal
          meta={previewFor}
          load={loadBytes}
          onDownload={(data) => {
            void saveBytes(data, previewFor.name, previewFor.mime)
            log(`${previewFor.name} downloaded.`)
          }}
          onClose={() => setPreviewFor(null)}
        />
      )}

      {pwDialog && (
        <div className="modal-backdrop" {...closeOnBackdrop(() => restoreBusy === null && setPwDialog(false))}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault()
              void submitPassword()
            }}
          >
            <h2>{hasPassword ? 'Change recovery password' : 'Set a recovery password'}</h2>
            <p className="muted">
              Opens your drive (read-only) if you lose this wallet: on the start screen, choose
              “Open your drive with its recovery password” and enter your wallet address and this
              password.
            </p>
            <p className="muted">
              The locked backup is public, so anyone can try to guess the password: use a long one —
              several unrelated words. Nobody can reset it for you.
              {hasPassword && ' The new password replaces the current one, which stops working.'}
              {card && !card.wrappedUnderSignature && ' This drive has no wallet-signature recovery: the password (or the key file) is the only way to open it on another device.'}
            </p>
            <input
              className="key-input wide"
              type="password"
              placeholder={`new password (at least ${MIN_PASSWORD} characters)`}
              value={pw1}
              onChange={(e) => setPw1(e.target.value)}
              autoComplete="new-password"
              autoFocus
            />
            <input
              className="key-input wide"
              type="password"
              placeholder="type it again"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              autoComplete="new-password"
            />
            {pwError && <p className="error-text">⚠ {pwError}</p>}
            <div className="modal-actions">
              <button className="btn" type="button" onClick={() => setPwDialog(false)} disabled={restoreBusy !== null}>
                Cancel
              </button>
              <button className="btn primary" type="submit" disabled={restoreBusy !== null || !pw1 || !pw2}>
                {restoreBusy ?? (hasPassword ? 'Change password' : 'Set password')}
              </button>
            </div>
            <p className="muted small-print">No wallet prompt · saved with your drive on 0G</p>
          </form>
        </div>
      )}

      {dupAsk &&
        (() => {
          const { items, taken, resolve } = dupAsk
          const anyReplaceable = items.some((it) => it.replaceable)
          // the typed names: checked like Rename, against the folder and each other
          const problems = dupNames.map((raw, j) => {
            const name = raw.trim()
            const k = name.toLowerCase()
            return (
              fileNameProblem(name) ??
              (taken.has(k) ? `“${name}” is already used here.` : null) ??
              (dupNames.some((o, x) => x !== j && o.trim().toLowerCase() === k) ? 'Two files can’t get the same name.' : null)
            )
          })
          const keepOk = problems.every((p) => p === null)
          // Replace uses the typed names only for files with nothing to replace
          const replaceOk = problems.every((p, j) => p === null || items[j].replaceable)
          const names = () => dupNames.map((n) => n.trim())
          return (
            <div className="modal-backdrop" {...closeOnBackdrop(() => resolve({ kind: 'cancel' }))}>
              <form
                className="modal dup-modal"
                role="dialog"
                aria-label="Files with the same name"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.key === 'Escape' && resolve({ kind: 'cancel' })}
                onSubmit={(e) => {
                  e.preventDefault()
                  if (keepOk) resolve({ kind: 'keep', names: names() })
                }}
              >
                <h2>
                  {items.length === 1 ? `“${items[0].name}” is already here` : `${items.length} names are already here`}
                </h2>
                <p className="muted">
                  Upload them under new names (edit them below){anyReplaceable ? ', replace the files already here' : ''}, or
                  skip them.
                </p>
                <ul className="dup-list">
                  {items.map((it, j) => (
                    <li key={j}>
                      <label className="dup-from" htmlFor={`dup-name-${j}`}>
                        {it.name}
                        {it.replaceable ? '' : ' · already uploading or in this drop'}
                      </label>
                      <input
                        id={`dup-name-${j}`}
                        className="key-input wide"
                        aria-label={`New name for ${it.name}`}
                        value={dupNames[j] ?? ''}
                        maxLength={300}
                        onChange={(e) => setDupNames((ns) => ns.map((n, x) => (x === j ? e.target.value : n)))}
                        onFocus={(e) => {
                          // select the name without its extension, like Rename
                          const dot = e.target.value.lastIndexOf('.')
                          e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length)
                        }}
                        autoFocus={j === 0}
                        spellCheck={false}
                        autoComplete="off"
                      />
                      {problems[j] && <p className="error-text">⚠ {problems[j]}</p>}
                    </li>
                  ))}
                </ul>
                {anyReplaceable && (
                  <p className="muted small-print">
                    Replace moves the file{items.filter((it) => it.replaceable).length === 1 ? '' : 's'} already here to trash (you
                    can restore {items.filter((it) => it.replaceable).length === 1 ? 'it' : 'them'}), in the same change.
                  </p>
                )}
                <div className="modal-actions">
                  <button className="btn" type="button" onClick={() => resolve({ kind: 'cancel' })}>
                    Cancel
                  </button>
                  <button className="btn" type="button" onClick={() => resolve({ kind: 'skip' })}>
                    Skip
                  </button>
                  {anyReplaceable && (
                    <button
                      className="btn"
                      type="button"
                      disabled={!replaceOk}
                      onClick={() => resolve({ kind: 'replace', names: names() })}
                    >
                      Replace
                    </button>
                  )}
                  <button className="btn primary" type="submit" disabled={!keepOk}>
                    Upload with these names
                  </button>
                </div>
              </form>
            </div>
          )
        })()}

      {renameFor && (() => {
        const isFile = renameFor.kind === 'file'
        const oldName = isFile ? renameFor.meta.name : baseName(renameFor.path)
        const name = renameTo.trim()
        const ext = (n: string) => (/\.([^./]+)$/.exec(n)?.[1] ?? '').toLowerCase()
        const same = (n: string) => n.toLowerCase() === name.toLowerCase()
        let problem: string | null
        if (isFile) {
          const clash = !same(oldName) && shownFiles.some((f) => f.id !== renameFor.meta.id && same(f.name))
          problem = fileNameProblem(name) ?? (clash ? `There is already a file named “${name}” in this folder.` : null)
        } else {
          const parent = renameFor.path.includes('/') ? renameFor.path.slice(0, renameFor.path.lastIndexOf('/')) : ''
          const clash = drive && !same(oldName)
            ? subFolders(drive, parent).map(baseName).find((n) => same(n))
            : undefined
          problem = folderNameProblem(name) ?? (clash ? `There is already a folder named “${clash}” here.` : null)
        }
        const extChanged = isFile && !problem && ext(name) !== ext(oldName)
        return (
          <div className="modal-backdrop" {...closeOnBackdrop(() => busy === null && setRenameFor(null))}>
            <form
              className="modal rename-modal"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.key === 'Escape' && busy === null && setRenameFor(null)}
              onSubmit={(e) => {
                e.preventDefault()
                if (!problem) void submitRename()
              }}
            >
              <h2>{isFile ? 'Rename file' : 'Rename folder'}</h2>
              <input
                className="key-input wide"
                aria-label="New name"
                value={renameTo}
                maxLength={300}
                onChange={(e) => setRenameTo(e.target.value)}
                onFocus={(e) => {
                  // select the name without its extension, like a desktop file manager
                  const dot = isFile ? oldName.lastIndexOf('.') : -1
                  e.target.setSelectionRange(0, dot > 0 ? dot : oldName.length)
                }}
                autoFocus
                spellCheck={false}
                autoComplete="off"
              />
              {problem && name !== oldName && <p className="error-text">⚠ {problem}</p>}
              {extChanged && (
                <p className="muted">
                  {ext(name)
                    ? `The extension changes from “.${ext(oldName) || '(none)'}” to “.${ext(name)}”. `
                    : 'The name has no extension. '}
                  0GDrive keeps opening it as the type it was uploaded as; other apps may treat it differently after download.
                </p>
              )}
              {renameError && <p className="error-text">⚠ {renameError}</p>}
              <div className="modal-actions">
                <button className="btn" type="button" onClick={() => setRenameFor(null)} disabled={busy !== null}>
                  Cancel
                </button>
                <button className="btn primary" type="submit" disabled={busy !== null || !!problem || name === oldName}>
                  {busy !== null ? 'Renaming…' : 'Rename'}
                </button>
              </div>
              <p className="muted small-print">
                {isFile
                  ? 'No wallet prompt · the file itself isn’t re-uploaded · links you already shared keep the old name'
                  : 'No wallet prompt · nothing inside is re-uploaded · subfolders and files keep their place'}
              </p>
            </form>
          </div>
        )
      })()}

      {moveFor && drive && (() => {
        const close = () => busy === null && setMoveFor(null)
        const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
        const all = [...drive.paths, ...movePending]
        const children = (p: string) => all.filter((x) => parentOf(x) === p).map(baseName)
        const here = moveFor.kind === 'folder' ? parentOf(moveFor.path) : moveFor.from
        const blocked = (p: string) =>
          moveFor.kind === 'folder' && (p === moveFor.path || p.startsWith(moveFor.path + '/'))
        const moving = moveFor.kind === 'files'
          ? shownFiles.filter((f) => moveFor.ids.includes(f.id)).map((f) => f.name)
          : []
        let problem: string | null = null
        if (moveDest !== null) {
          const where = moveDest === '' ? 'My drive' : `“${moveDest}”`
          if (moveFor.kind === 'folder') {
            const clash = children(moveDest).find((n) => same(n, baseName(moveFor.path)))
            if (clash) problem = `There is already a folder named “${clash}” in ${where}.`
          } else {
            const names = (drive.folders.get(moveDest)?.files ?? []).map((f) => f.name)
            const clash = moving.find((m) => names.some((n) => same(n, m)))
            if (clash) problem = `There is already a file named “${clash}” in ${where}.`
          }
        }
        const newName = moveNewName?.trim() ?? ''
        const parentForNew = moveDest ?? here
        const newProblem = moveNewName === null || newName === ''
          ? null
          : folderNameProblem(newName) ??
            (children(parentForNew).some((n) => same(n, newName)) ? `There is already a folder named “${newName}” there.` : null)
        const addNew = () => {
          if (newName === '' || newProblem) return
          const p = parentForNew === '' ? newName : `${parentForNew}/${newName}`
          setMovePending((prev) => [...prev, p])
          setMoveDest(p)
          setMoveNewName(null)
        }
        const options = ['', ...treeOrder(all)]
        return (
          <div className="modal-backdrop" {...closeOnBackdrop(close)}>
            <form
              className="modal move-modal"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.key === 'Escape' && moveNewName === null && close()}
              onSubmit={(e) => {
                e.preventDefault()
                if (moveDest !== null && !problem) void submitMove()
              }}
            >
              <h2>Move “{moveFor.kind === 'folder' ? baseName(moveFor.path) : moveFor.label}”</h2>
              <p className="muted">Choose where it goes.</p>
              <div className="move-list" role="listbox" aria-label="Destination folder">
                {options.map((p) => {
                  const isHere = p === here
                  const disabled = isHere || blocked(p)
                  const depth = p === '' ? 0 : p.split('/').length
                  return (
                    <button
                      key={p || '(root)'}
                      type="button"
                      role="option"
                      aria-selected={moveDest === p}
                      className={`move-opt${moveDest === p ? ' selected' : ''}`}
                      style={{ paddingLeft: 10 + depth * 16 }}
                      disabled={disabled || busy !== null}
                      onClick={() => setMoveDest(p)}
                    >
                      <FolderGlyph />
                      <span className="move-name">{p === '' ? 'My drive' : baseName(p)}</span>
                      {isHere && <span className="muted move-note">current</span>}
                      {movePending.includes(p) && <span className="muted move-note">new</span>}
                    </button>
                  )
                })}
              </div>
              {moveNewName === null ? (
                <button type="button" className="btn small move-new" disabled={busy !== null}
                  onClick={() => setMoveNewName('')}>
                  + New folder in {parentForNew === '' ? 'My drive' : `“${baseName(parentForNew)}”`}
                </button>
              ) : (
                <div className="move-new-row">
                  <input
                    className="key-input"
                    aria-label="New folder name"
                    placeholder="Folder name"
                    value={moveNewName}
                    maxLength={300}
                    autoFocus
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => setMoveNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); addNew() }
                      if (e.key === 'Escape') { e.stopPropagation(); setMoveNewName(null) }
                    }}
                  />
                  <button type="button" className="btn small" disabled={newName === '' || !!newProblem} onClick={addNew}>
                    Add
                  </button>
                </div>
              )}
              {newProblem && <p className="error-text">⚠ {newProblem}</p>}
              {problem && <p className="error-text">⚠ {problem}</p>}
              {moveError && <p className="error-text">⚠ {moveError}</p>}
              <div className="modal-actions">
                <button className="btn" type="button" onClick={() => setMoveFor(null)} disabled={busy !== null}>
                  Cancel
                </button>
                <button className="btn primary" type="submit" disabled={busy !== null || moveDest === null || !!problem}>
                  {busy !== null ? 'Moving…' : 'Move here'}
                </button>
              </div>
              <p className="muted small-print">No wallet prompt · nothing is re-uploaded{movePending.length > 0 ? ' · new folders are created in the same change' : ''}</p>
            </form>
          </div>
        )
      })()}

      {shareFor && (
        <div className="modal-backdrop" {...closeOnBackdrop(() => setShareFor(null))}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Share “{shareFor.name}”</h2>
            <div className="share-modes">
              <button
                className={`btn small ${shareMode === 'A' ? 'primary' : ''}`}
                onClick={() => { setShareMode('A'); setShareLink(null) }}
              >
                Secret link
              </button>
              <button
                className={`btn small ${shareMode === 'B' ? 'primary' : ''}`}
                onClick={() => { setShareMode('B'); setShareLink(null) }}
              >
                Encrypted to recipient
              </button>
            </div>
            <p className="muted">
              {shareMode === 'A'
                ? 'Anyone with the link can download and decrypt this one file. The key rides in the URL fragment and never touches a server.'
                : 'The file key is locked to the recipient’s published share key — only their wallet can open the link (one signature, no transaction).'}
            </p>
            {shareMode === 'B' && (
              <input
                className="key-input wide"
                placeholder="recipient address 0x…"
                value={shareRecipient}
                onChange={(e) => setShareRecipient(e.target.value)}
              />
            )}
            {shareError && <p className="error-text">⚠ {shareError}</p>}
            {shareLink && (
              <div className="share-link-box">
                <input className="key-input wide" readOnly value={shareLink} onFocus={(e) => e.currentTarget.select()} />
                <button
                  className="btn primary small"
                  onClick={() => {
                    void navigator.clipboard.writeText(shareLink)
                    log('Share link copied to clipboard.')
                  }}
                >
                  Copy
                </button>
              </div>
            )}
            <div className="modal-actions">
              <button className="btn" onClick={() => setShareFor(null)}>Close</button>
              <button className="btn primary" disabled={shareBusy !== null} onClick={doShare}>
                {shareBusy ?? (shareMode === 'A' ? 'Create link' : 'Wrap & create link')}
              </button>
            </div>
          </div>
        </div>
      )}

      {!assistOpen && (
        <button className="assist-fab" onClick={() => setAssistOpen(true)} aria-label="Ask the assistant" title="Ask about 0GDrive">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-6l-4 3.5V17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
            <path d="M9.5 9.2a2.5 2.5 0 1 1 3.3 2.4c-.5.2-.8.6-.8 1.1v.3M12 15.2v.1" />
          </svg>
          <span>Ask</span>
        </button>
      )}
      <AssistantPanel open={assistOpen} onClose={() => setAssistOpen(false)} getStatus={assistantStatus} show={showForAssistant} />
      <footer className="footer">
        0GDrive · {NETWORK.chainName} ({NETWORK.chainId}) ·{' '}
        <a href={NETWORK.faucetUrl} target="_blank" rel="noreferrer">
          Get testnet 0G
        </a>
      </footer>
    </div>
  )
}
