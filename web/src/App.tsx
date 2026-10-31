import { useCallback, useEffect, useRef, useState } from 'react'
import {
  bytesToHex,
  createMasterKey,
  decryptDownloaded,
  downloadFile,
  generateFileKey,
  getMasterKeyHex,
  getNetworkConfig,
  enableShareKey,
  getProfile,
  hexToBytes,
  importMasterKey,
  unwrapFileKey,
  uploadBrowserFile,
  uploadBatch,
  wrapFileKey,
  wrapFileKeyToPubKey,
  buildShareLink,
  buildEncryptedShareLink,
  downloadEncryptedShare,
  downloadSharedFile,
  parseShareLink,
  getDriveKeyBackup,
  hasDriveKeyBackup,
  restoreDriveKeyBySignature,
  unlockBackupWithPassword,
  setRecoveryPassword,
  setupDriveSecurity,
  unlockShareKey,
  DriveStore,
  TRASH_PATH,
  fileNameProblem,
  type DriveState,
  type FileMeta,
  type SharePayload,
  type EncryptedSharePayload,
  type EventCache,
  type UploadEvent,
} from '@0gdrive/core'
import {
  activeProvider,
  chooseWallet,
  connectWallet,
  hasWallet,
  onAccountsChanged,
  onChainChanged,
  readWalletState,
  selectWallet,
  type WalletState,
} from './wallet'
import { Logo } from './Logo'
import { FILE_CACHE_MAX_BYTES, cachedOrDownload, fileCacheKey } from './fileCache'
import { FileThumb, PreviewModal, canPreview, makeThumbnail } from './Preview'
import { setThumbSaving } from './thumbStore'
import { AssistantPanel, highlight, isNarrow, type DriveStatus } from './Assistant'
import { SearchBox, SearchResults, SuggestionsPanel, useSmartDrive } from './SmartSearch'
import { describeModelStatus, entryForRename, getModelStatus, indexFile, modelEta, modelsLoading, smartSearchEnabled, subscribeModelStatus } from './ai/client'

const NETWORK = getNetworkConfig('testnet', 'turbo')

interface Activity {
  id: number
  ts: number
  msg: string
  percent?: number
}

interface QueueItem {
  id: string
  name: string
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

function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash
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
  label: string
  hint: string
  status?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="sec-row" data-row={id}>
      <span className="sec-label" title={hint}>{label}</span>
      <span className="sec-status">{status}</span>
      <span className="sec-act">{action}</span>
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
function Welcome({ onConnect }: { onConnect: () => void }) {
  return (
    <section className="hero welcome" aria-labelledby="welcome-title">
      <HeroIcon />
      <h1 id="welcome-title">Your files, for your eyes only.</h1>
      <p className="welcome-sub">
        Encrypted on your device before upload. Only you, and the people you share with, can open
        them. Not 0G, not the storage nodes.
      </p>
      {hasWallet() ? (
        <button className="btn primary welcome-cta" onClick={onConnect}>
          Get started
        </button>
      ) : (
        <p className="hero-hint">Install a wallet extension such as MetaMask or Rabby to start.</p>
      )}
      <p className="hero-hint">Connect to open your drive, or create one in a click.</p>
    </section>
  )
}

// ─── File type icons (inline SVG, no deps) ────────────────────────────

const ICON_COLORS: Record<string, string> = {
  image: '#4da3ff',
  video: '#b07cff',
  audio: '#4ade80',
  pdf: '#ff6b6b',
  doc: '#5eead4',
  sheet: '#facc15',
  code: '#94a3b8',
  archive: '#fb923c',
  generic: '#8b98a5',
}

function fileKind(meta: { mime: string; name: string }): keyof typeof ICON_COLORS {
  const m = meta.mime
  const ext = meta.name.split('.').pop()?.toLowerCase() ?? ''
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (['csv', 'xls', 'xlsx', 'numbers'].includes(ext) || m.includes('spreadsheet')) return 'sheet'
  if (['zip', 'tar', 'gz', 'rar', '7z'].includes(ext) || m.includes('zip') || m.includes('compressed')) return 'archive'
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'c', 'h', 'cpp', 'sh', 'json', 'yml', 'yaml', 'toml'].includes(ext) || m.includes('json')) return 'code'
  if (['doc', 'docx', 'txt', 'md', 'rtf', 'pages'].includes(ext) || m.startsWith('text/')) return 'doc'
  return 'generic'
}

function FileIcon({ meta }: { meta: { mime: string; name: string } }) {
  const kind = fileKind(meta)
  const c = ICON_COLORS[kind]
  const glyph =
    kind === 'image' ? 'M4 5h16v14H4zM4 15l4-4 3 3 4-4 5 5' :
    kind === 'video' ? 'M4 5h12v14H4zM16 10l4-2v8l-4-2' :
    kind === 'audio' ? 'M9 17V7l8-2v10M9 17a2 2 0 11-4 0 2 2 0 014 0zM17 15a2 2 0 11-4 0 2 2 0 014 0z' :
    kind === 'pdf' ? 'M7 3h7l4 4v14H7zM14 3v4h4' :
    kind === 'sheet' ? 'M7 3h7l4 4v14H7zM14 3v4h4M7 10h10M7 14h10M11 8v10' :
    kind === 'code' ? 'M9 6L4 12l5 6M15 6l5 6-5 6' :
    kind === 'archive' ? 'M6 3h12v4H6zM7 7v14h10V7M10 11h4M10 15h4' :
    kind === 'doc' ? 'M7 3h7l4 4v14H7zM14 3v4h4M9 12h6M9 16h6' :
    'M7 3h7l4 4v14H7zM14 3v4h4'
  return (
    <svg className="ficon" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={glyph} />
    </svg>
  )
}

const ACTION_ICONS = {
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  share: 'M15 5l5 5-5 5M20 10H10a6 6 0 00-6 6v3',
  trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13',
  restore: 'M4 12a8 8 0 108-8 8 8 0 00-6 2.7M4 4v4h4',
  close: 'M6 6l12 12M18 6L6 18',
  rename: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
} as const

/** Button content: icon always, label hidden on narrow screens. */
function ActionLabel({ icon, label }: { icon: keyof typeof ACTION_ICONS; label?: string }) {
  return (
    <>
      <svg className="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={ACTION_ICONS[icon]} />
      </svg>
      {label && <span className="btn-label">{label}</span>}
    </>
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
  node, depth, currentPath, expanded, onToggle, onSelect, onRemove, disabled,
}: {
  node: TreeNode
  depth: number
  currentPath: string
  expanded: string[]
  onToggle(p: string): void
  onSelect(p: string): void
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
        <button className="tree-remove" disabled={disabled} onClick={() => onRemove(node.path)}
          title="Move folder (and contents) to trash">
          🗑
        </button>
      </div>
      {isOpen &&
        node.children.map((ch) => (
          <TreeRow key={ch.path} node={ch} depth={depth + 1} currentPath={currentPath}
            expanded={expanded} onToggle={onToggle} onSelect={onSelect} onRemove={onRemove}
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
      setBusy('Downloading…')
      const res =
        mode === 'link'
          ? await downloadSharedFile(payload as SharePayload, NETWORK, (msg, pct) =>
              log(`${p.n}: ${msg}`)
            )
          : await downloadEncryptedShare(
              payload as EncryptedSharePayload,
              NETWORK,
              privateKey
            )
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

/**
 * The drive key from the on-chain backup's password wrap. Tries the
 * password as typed, then trimmed (passwords used to be set untrimmed
 * and restored trimmed).
 */
async function unlockWithPassword(
  address: string,
  password: string,
  cache?: EventCache,
  onUnlocking?: () => void
): Promise<{ masterKey: Uint8Array }> {
  const backup = await getDriveKeyBackup(address, NETWORK, cache)
  if (!backup) throw new Error('No drive backup found for this address.')
  if (!backup.wrappedUnderPassword) {
    throw new Error('This drive has no recovery password — it can only be restored with its wallet or key file.')
  }
  onUnlocking?.()
  for (const pw of new Set([password, password.trim()])) {
    try {
      return { masterKey: await unlockBackupWithPassword(backup, pw) }
    } catch {
      // try the next form
    }
  }
  throw new Error('Wrong recovery password.')
}

/** The wallet's upload-event list, kept in localStorage so a page load only
 *  scans new blocks (shared by the drive, recovery and share-key checks). */
function eventCacheFor(address: string): EventCache {
  // v2: v1 caches could have skipped events (see scanUploadsCached), so
  // they're rebuilt once
  const key = `0gdrive:events:v2:${address.toLowerCase()}`
  try {
    localStorage.removeItem(`0gdrive:events:${address.toLowerCase()}`)
  } catch {
    // storage unavailable
  }
  return {
    load() {
      try {
        const raw = localStorage.getItem(key)
        return raw ? JSON.parse(raw) : null
      } catch {
        return null
      }
    },
    save(events: UploadEvent[], toBlock: number) {
      try {
        localStorage.setItem(key, JSON.stringify({ events, toBlock }))
      } catch {
        /* storage full — cache is best-effort */
      }
    },
  }
}

// ─── Main app ─────────────────────────────────────────────────────────

export default function App() {
  const [wallet, setWallet] = useState<WalletState | null>(null)
  const [masterKeyHex, setMasterKeyHex] = useState<string | null>(null)
  const [hasBackup, setHasBackup] = useState<boolean | null>(null)
  const [backupCheckError, setBackupCheckError] = useState<string | null>(null)
  const [restoreBusy, setRestoreBusy] = useState<string | null>(null)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [restorePassword, setRestorePassword] = useState('')
  const [showPasswordRestore, setShowPasswordRestore] = useState(false)
  /** whether the on-chain backup has a password wrap (null: unknown) */
  const [hasPassword, setHasPassword] = useState<boolean | null>(null)
  const [pwDialog, setPwDialog] = useState(false)
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [pwError, setPwError] = useState<string | null>(null)
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
  const [profilePubKey, setProfilePubKey] = useState<string | null>(null)
  /** the published key is the legacy wallet key, not a derived sharing key */
  const [profileLegacy, setProfileLegacy] = useState(false)
  /** 'checking' | 'ok' | error message — a failed lookup is not "unpublished" */
  const [profileState, setProfileState] = useState<string>('checking')
  const [publishing, setPublishing] = useState(false)
  const [shareFor, setShareFor] = useState<FileMeta | null>(null)
  const [renameFor, setRenameFor] = useState<FileMeta | null>(null)
  const [renameTo, setRenameTo] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)
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

  const checkProfile = useCallback((address: string) => {
    setProfileState('checking')
    getProfile(address, NETWORK, eventCacheFor(address))
      .then((p) => {
        setProfilePubKey(p?.pubKey ?? null)
        setProfileLegacy(p !== null && p.kind !== 'share')
        setProfileState('ok')
      })
      .catch((err) => setProfileState((err as Error).message ?? String(err)))
  }, [])

  const initDrive = useCallback(
    async (signer: WalletState['signer'], masterKey: Uint8Array, address: string) => {
      const store = new DriveStore(NETWORK, signer, masterKey, {
        onProgress: (msg) => {
          if (msg.includes('sealed') || msg.includes('Repair')) log(msg)
        },
        eventCache: eventCacheFor(address),
      })
      storeRef.current = store
      // read-only: has this account published a share key?
      checkProfile(address)
      setBusy('Loading drive from 0G…')
      try {
        setDrive(await store.loadDrive())
        log('Drive loaded from chain.')
      } catch (err) {
        log(`Drive load failed: ${(err as Error).message}`)
      } finally {
        setBusy(null)
      }
    },
    [log, checkProfile]
  )

  const checkBackup = useCallback(
    async (address: string) => {
      setHasBackup(null)
      setBackupCheckError(null)
      setHasPassword(null)
      try {
        const exists = await hasDriveKeyBackup(address, NETWORK, eventCacheFor(address))
        setHasBackup(exists)
        if (!exists) setHasPassword(false)
        else {
          getDriveKeyBackup(address, NETWORK, eventCacheFor(address))
            .then((b) => b && setHasPassword(Boolean(b.wrappedUnderPassword)))
            .catch(() => {}) // stays unknown
        }
      } catch (err) {
        // unknown is not "no backup": offering setup / a new drive here
        // could replace an existing drive's key
        setBackupCheckError((err as Error).message ?? String(err))
      }
    },
    []
  )

  const connect = useCallback(async () => {
    try {
      const state = await connectWallet(NETWORK)
      if (!state) return // picker dismissed
      setWallet(state)
      setMasterKeyHex(getMasterKeyHex(state.address))
      log(`Connected ${shortHash(state.address)} · balance ${Number(state.balance).toFixed(4)} 0G`)
      void checkBackup(state.address)
    } catch (err) {
      log(`Wallet error: ${(err as Error).message}`)
    }
  }, [log, checkBackup])

  useEffect(() => {
    if (wallet && masterKeyHex && !busy && !storeRef.current) {
      void initDrive(wallet.signer, hexToBytes(masterKeyHex), wallet.address)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet?.address, masterKeyHex])

  useEffect(() => {
    const offChain = onChainChanged(() => window.location.reload())
    const offAccounts = onAccountsChanged(async (accounts) => {
      if (readOnlyRef.current) return // no wallet in play
      if (accounts.length === 0) {
        setWallet(null)
        setDrive(null)
        setMasterKeyHex(null)
        storeRef.current = null
        setProfilePubKey(null)
        return
      }
      try {
        const eth = activeProvider()
        if (!eth) return
        const provider = new (await import('ethers')).BrowserProvider(eth)
        const signer = await provider.getSigner()
        const state = await readWalletState(signer, NETWORK)
        setWallet(state)
        setMasterKeyHex(getMasterKeyHex(state.address))
        storeRef.current = null
        setDrive(null)
        setProfilePubKey(null)
      } catch (err) {
        log(`Wallet error: ${(err as Error).message}`)
      }
    })
    return () => {
      offChain()
      offAccounts()
    }
  }, [log])

  const generateKey = useCallback(() => {
    if (!wallet) return
    createMasterKey(wallet.address)
    setMasterKeyHex(getMasterKeyHex(wallet.address))
    log('Drive key created — enable on-chain recovery below (two signatures, one transaction).')
  }, [wallet, log])

  const enableRecovery = useCallback(async () => {
    if (!wallet || !masterKeyHex) return
    setRestoreBusy('Waiting for signature…')
    setRestoreError(null)
    try {
      // one tx (the message is signed twice, to check the wallet signs
      // deterministically): recovery backup + share key together
      const res = await setupDriveSecurity(
        NETWORK, wallet.signer, wallet.address, hexToBytes(masterKeyHex)
      )
      setHasBackup(true)
      setProfilePubKey(res.shareKey)
      setProfileLegacy(false)
      log('Drive security enabled — recovery + share key published (2 signatures, 1 tx).')
    } catch (err) {
      setRestoreError((err as Error).message)
      log(`Enable security failed: ${(err as Error).message}`)
    } finally {
      setRestoreBusy(null)
    }
  }, [wallet, masterKeyHex, log])

  const restoreBySignature = useCallback(async () => {
    if (!wallet) return
    setRestoreBusy('Waiting for signature…')
    setRestoreError(null)
    try {
      const res = await restoreDriveKeyBySignature(wallet.address, NETWORK, wallet.signer, eventCacheFor(wallet.address))
      if (!res) throw new Error('no backup found')
      importMasterKey(wallet.address, bytesToHex(res.masterKey))
      setMasterKeyHex(bytesToHex(res.masterKey))
      log('Drive key restored from on-chain backup.')
    } catch (err) {
      setRestoreError((err as Error).message)
    } finally {
      setRestoreBusy(null)
    }
  }, [wallet, log])

  const restoreByPassword = useCallback(async () => {
    if (!wallet || !restorePassword.trim()) return
    setRestoreBusy('Deriving key from password…')
    setRestoreError(null)
    try {
      const res = await unlockWithPassword(wallet.address, restorePassword, eventCacheFor(wallet.address))
      importMasterKey(wallet.address, bytesToHex(res.masterKey))
      setMasterKeyHex(bytesToHex(res.masterKey))
      log('Drive key restored via password.')
    } catch (err) {
      setRestoreError((err as Error).message)
    } finally {
      setRestoreBusy(null)
    }
  }, [wallet, restorePassword, log])

  const openPasswordDialog = useCallback(() => {
    setPw1('')
    setPw2('')
    setPwError(null)
    setPwDialog(true)
  }, [])

  const submitPassword = useCallback(async () => {
    if (!wallet || !masterKeyHex) return
    if (pw1.length < MIN_PASSWORD) {
      setPwError(`Use at least ${MIN_PASSWORD} characters — a few unrelated words is easiest to remember.`)
      return
    }
    if (pw1 !== pw2) {
      setPwError('The two passwords don’t match.')
      return
    }
    setPwError(null)
    setRestoreBusy('Waiting for signature…')
    try {
      await setRecoveryPassword(NETWORK, wallet.signer, wallet.address, hexToBytes(masterKeyHex), pw1)
      log(hasPassword ? 'Recovery password changed — the old one no longer works.' : 'Recovery password set.')
      setHasBackup(true)
      setHasPassword(true)
      setPwDialog(false)
      setPw1('')
      setPw2('')
    } catch (err) {
      setPwError((err as Error).message)
      log(`Set password failed: ${(err as Error).message}`)
    } finally {
      setRestoreBusy(null)
    }
  }, [wallet, masterKeyHex, pw1, pw2, hasPassword, log])

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
      const res = await unlockWithPassword(address, lostPassword, undefined, () => setLostBusy('Unlocking…'))
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
      setHasBackup(true)
      setHasPassword(true)
      // kept in memory only: this may not be the owner's own device
      setMasterKeyHex(bytesToHex(res.masterKey))
      setLostPassword('')
      log(`Drive of ${shortHash(address)} opened read-only with its recovery password.`)
    } catch (err) {
      setLostError((err as Error).message)
    } finally {
      setLostBusy(null)
    }
  }, [lostAddress, lostPassword, log])

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
  }, [masterKeyHex, wallet])

  const publishShareKey = useCallback(async () => {
    if (!wallet || publishing) return
    setPublishing(true)
    try {
      if (!masterKeyHex) throw new Error('drive key not loaded')
      const res = await enableShareKey(
        NETWORK, wallet.signer, wallet.address, hexToBytes(masterKeyHex), eventCacheFor(wallet.address)
      )
      setProfilePubKey(res.shareKey)
      setProfileLegacy(false)
      log('Share key published — others can now send you encrypted files, opened with a wallet signature.')
    } catch (err) {
      log(`Publish share key failed: ${(err as Error).message}`)
    } finally {
      setPublishing(false)
    }
  }, [wallet, publishing, masterKeyHex, log])

  // ─── Upload queue ───────────────────────────────────────────────────

  /**
   * One-prompt upload (networks with batchSubmit on): every file AND
   * the folder manifest listing them go into a single storage transaction.
   * The manifest's segments are uploaded only after every file is stored
   * and sealed; if any file fails, the stored ones are registered with a
   * separate manifest write instead.
   */
  const uploadBatched = useCallback(
    async (store: DriveStore, path: string, items: QueueItem[], files: File[]) => {
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
        const thumb = await makeThumbnail(file, mime)
        const fileKey = generateFileKey()
        prep.push({
          fileKey,
          wrappedKey: await wrapFileKey(hexToBytes(masterKeyHex), fileKey),
          thumb,
          mime,
          search: smartSearchEnabled() ? indexFile(file, file.name, mime, thumb) : Promise.resolve(undefined),
        })
      }

      // byte-counting views: the SDK reads each file 3× (submission hash,
      // merkle tree, segment upload) — progress = bytes read / (3 × size)
      const phaseOf: ('hash' | 'upload')[] = files.map(() => 'hash')
      const tracked = files.map((file, i) => {
        let read = 0
        return new Proxy(file, {
          get(target, prop) {
            if (prop === 'slice') {
              return (st: number, en: number, ct?: string) => {
                read += Math.max(0, en - st)
                const pct = Math.min(99, Math.round((read / (file.size * 3 || 1)) * 100))
                setItem(i, {
                  percent: pct,
                  ...(phaseOf[i] === 'hash' ? { message: 'hashing & encrypting…' } : {}),
                })
                return target.slice(st, en, ct)
              }
            }
            const v = Reflect.get(target, prop, target)
            return typeof v === 'function' ? v.bind(target) : v
          },
        }) as unknown as File
      })

      let metas: FileMeta[] = []
      const ids = files.map(() => 'f_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10))
      const timeout = (ms: number) => new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))
      // Search entries: a one-time model download may still be running —
      // wait for it (up to 3 min, progress shown) rather than store the
      // files unindexed; once models are ready, each entry gets ≤15 s.
      const awaitSearches = async () => {
        if (!smartSearchEnabled()) return prep.map(() => undefined)
        const started = Date.now()
        if (modelsLoading()) {
          // wait only while the download looks close to done; otherwise the
          // files go up now and "Index older files" catches them later
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
          if (modelsLoading()) return prep.map(() => undefined)
        }
        const left = Math.max(5_000, Math.min(15_000, 195_000 - (Date.now() - started)))
        return Promise.all(prep.map((p) => Promise.race([p.search, timeout(left)])))
      }

      try {
        const res = await uploadBatch(
          files.map((_, i) => ({ data: tracked[i], encryption: { type: 'aes256' as const, key: prep[i].fileKey } })),
          NETWORK,
          wallet.signer,
          {
            finalize: async (roots) => {
              // entries not ready within the time box are left out — the
              // folder's "Index older files" picks them up later
              const searches = await awaitSearches()
              metas = files.map((file, i) => ({
                id: ids[i],
                name: file.name,
                size: file.size,
                mime: prep[i].mime,
                uploadedAt: Date.now(),
                encryption: 'aes256',
                rootHashes: [roots[i]],
                txHashes: [], // filled from chain events on load
                wrappedKey: prep[i].wrappedKey,
                network: 'testnet:turbo',
                ...(prep[i].thumb ? { thumb: prep[i].thumb } : {}),
                ...(searches[i] ? { search: searches[i] } : {}),
              }))
              return store.prepareFileRecords(path, metas)
            },
            onProgress: (msg) => {
              if (msg.startsWith('Waiting for wallet approval')) {
                setAll({
                  state: 'approving',
                  percent: undefined,
                  message: n === 1
                    ? 'approve the storage transaction in your wallet'
                    : `approve 1 transaction for all ${n} files in your wallet`,
                })
              } else if (msg.startsWith('Transaction submitted')) {
                phaseOf.fill('upload')
                setAll({ state: 'uploading', message: 'approved — storing segments…' })
              }
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

        const okIdx = res.items.map((r, i) => (r.ok ? i : -1)).filter((i) => i >= 0)
        res.items.forEach((r, i) => {
          if (!r.ok) log(`${files[i].name} failed: ${r.error}`)
        })
        const manifestOk = res.extras.length > 0 && res.extras.every((r) => r.ok)
        if (manifestOk) {
          setAll({ state: 'done', message: 'in your drive ✓' }, (i) => okIdx.includes(i))
          log(`${n} file${n === 1 ? '' : 's'} stored and registered with 1 wallet approval.`)
        } else if (okIdx.length > 0) {
          // some files failed (or the batched record didn't store): register
          // the stored files with a normal manifest write
          setAll({ state: 'registering', message: 'registering — check your wallet', percent: undefined }, (i) => okIdx.includes(i))
          const stored = okIdx.map((i) => {
            const r = res.items[i]
            return r.ok ? { ...metas[i], txHashes: r.result.txHashes, txSeqs: r.result.txSeqs } : metas[i]
          })
          await store.putFileRecords(path, stored)
          setAll({ state: 'done', message: 'in your drive ✓' }, (i) => okIdx.includes(i))
        }
        await reloadDrive()
      } catch (err) {
        const msg = (err as Error).message
        const rejected = /user (rejected|denied)|ACTION_REJECTED/i.test(msg)
        // uploadBatch only throws before any segment is stored (hashing,
        // signing, receipt) — or the fallback registration failed
        setAll({ state: 'error', message: rejected ? 'transaction rejected in wallet' : msg, percent: undefined })
        log(`Upload failed: ${rejected ? 'transaction rejected in wallet' : msg}`)
      }
    },
    [wallet, masterKeyHex, log, reloadDrive]
  )

  /** Upload one dropped batch (already queued) into `path`. */
  const runUpload = useCallback(
    async (store: DriveStore, path: string, items: QueueItem[], files: File[]) => {
      if (!wallet || !masterKeyHex) return
      if (NETWORK.batchSubmit) {
        await uploadBatched(store, path, items, files)
        return
      }

      const metas: FileMeta[] = []
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const file = files[i]
        const setItem = (patch: Partial<QueueItem>) =>
          setQueue((q) => q.map((x) => (x.id === item.id ? { ...x, ...patch } : x)))
        try {
          setItem({ state: 'uploading', message: 'preparing…' })
          const mime = file.type || 'application/octet-stream'
          const thumb = await makeThumbnail(file, mime)
          // on-device search entry, built while the upload runs (reads the
          // original File, not the progress proxy below)
          const searchP = smartSearchEnabled()
            ? indexFile(file, file.name, mime, thumb)
            : Promise.resolve(undefined)
          const fileKey = generateFileKey()
          const wrappedKey = await wrapFileKey(hexToBytes(masterKeyHex), fileKey)
          // read-progress proxy: the SDK reads the file twice (merkle pass,
          // then segment upload) via File.slice — counting bytes gives a
          // genuine two-phase progress bar with no SDK changes.
          // The hashing pass reads exactly file.size bytes (verified), and
          // the SDK builds + sends the storage tx right after it — so the
          // moment pass 1 completes is when the wallet prompt is coming.
          let bytesRead = 0
          let phase: 'hash' | 'approve' | 'upload' = 'hash'
          const totalBytes = file.size * 2
          const progressFile = new Proxy(file, {
            get(target, prop) {
              if (prop === 'slice') {
                return (s: number, e: number, ct?: string) => {
                  bytesRead += Math.max(0, e - s)
                  const pct = Math.min(99, Math.round((bytesRead / totalBytes) * 100))
                  if (phase === 'hash' && bytesRead >= file.size) {
                    phase = 'approve'
                    setItem({
                      state: 'approving',
                      message: 'approve the storage transaction in your wallet',
                      percent: undefined,
                    })
                  } else if (phase === 'hash') {
                    setItem({ state: 'uploading', message: 'hashing & encrypting…', percent: pct })
                  } else {
                    setItem({ state: 'uploading', message: 'uploading segments…', percent: pct })
                  }
                  return target.slice(s, e, ct)
                }
              }
              const v = Reflect.get(target, prop, target)
              return typeof v === 'function' ? v.bind(target) : v
            },
          }) as unknown as File
          const result = await uploadBrowserFile(progressFile, NETWORK, wallet.signer, {
            encryption: { type: 'aes256', key: fileKey },
            onProgress: (msg) => {
              if (msg.includes('sealing')) {
                setItem({ state: 'sealing', message: 'sealing on 0G…', percent: undefined })
              } else if (msg.includes('Transaction submitted')) {
                phase = 'upload'
                setItem({ state: 'uploading', message: 'approved — storing segments…', percent: undefined })
              }
              // other phases are covered by the read-progress proxy
            },
          })
          const search = await searchP
          metas.push({
            id: 'f_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10),
            name: file.name,
            size: file.size,
            mime: file.type || 'application/octet-stream',
            uploadedAt: Date.now(),
            encryption: 'aes256',
            rootHashes: result.rootHashes,
            txHashes: result.txHashes,
            txSeqs: result.txSeqs,
            wrappedKey,
            network: 'testnet:turbo',
            ...(thumb ? { thumb } : {}),
            ...(search ? { search } : {}),
          })
          setItem({ state: 'done', message: 'stored permanently — registering in drive…' })
        } catch (err) {
          setItem({ state: 'error', message: (err as Error).message })
          log(`${item.name} failed: ${(err as Error).message}`)
        }
      }

      // batch: one manifest transaction for all successfully uploaded files
      if (metas.length > 0) {
        setQueue((q) =>
          q.map((x) =>
            metas.some((m) => m.name === x.name)
              ? { ...x, state: 'registering', message: '' }
              : x
          )
        )
        try {
          await store.putFileRecords(path, metas)
          await reloadDrive()
          setQueue((q) =>
            q.map((x) =>
              metas.some((m) => m.name === x.name)
                ? { ...x, state: 'done', message: 'in your drive ✓' }
                : x
            )
          )
        } catch (err) {
          log(`Drive registration failed: ${(err as Error).message} — files are stored but not registered; re-run "Sync" or contact support.`)
          setQueue((q) =>
            q.map((x) =>
              metas.some((m) => m.name === x.name)
                ? { ...x, state: 'error', message: 'stored, but drive registration failed' }
                : x
            )
          )
        }
      }
    },
    [wallet, masterKeyHex, log, reloadDrive, uploadBatched]
  )

  // Drops never get lost: each one is queued immediately (target folder
  // captured now) and runs after the batches before it.
  const uploadChain = useRef<Promise<void>>(Promise.resolve())
  const uploadFiles = useCallback(
    (fileList: FileList | File[]) => {
      const store = storeRef.current
      if (!wallet || !store || !masterKeyHex) return
      const path = view === 'trash' ? '' : currentPath
      const files = Array.from(fileList) // the input's FileList is reset right after
      const items: QueueItem[] = files.map((f) => ({
        id: 'q_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        name: f.name,
        size: f.size,
        state: 'queued',
        message: path ? `waiting · to ${path}` : 'waiting',
      }))
      setQueue((q) => [...q, ...items])
      uploadChain.current = uploadChain.current
        .then(() => runUpload(store, path, items, files))
        .catch((err) => log(`Upload failed: ${(err as Error).message}`))
    },
    [wallet, masterKeyHex, currentPath, view, log, runUpload]
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

  /** Download + decrypt a file into memory (preview, thumbnails, indexing).
   *  Single-fragment files are cached on this device as stored (encrypted)
   *  and decrypted after every read — see fileCache.ts. */
  const loadBytes = useCallback(
    async (meta: FileMeta, onProgress?: (msg: string, pct?: number) => void) => {
      const fileKey = meta.encryption === 'none' ? null : await fileKeyFor(meta)
      if (meta.encryption !== 'none' && !fileKey) throw new Error('cannot unwrap the file key')
      if (meta.rootHashes.length === 1 && meta.size <= FILE_CACHE_MAX_BYTES) {
        const raw = await cachedOrDownload(fileCacheKey(meta.rootHashes), async () =>
          (await downloadFile(meta.rootHashes, NETWORK, { txSeqs: meta.txSeqs, onProgress })).data
        )
        if (!fileKey) return raw
        const { data, decrypted } = decryptDownloaded(raw, { symmetricKey: fileKey })
        if (!decrypted) throw new Error('decryption failed (wrong key?)')
        return data
      }
      const { data, decrypted } = await downloadFile(meta.rootHashes, NETWORK, {
        decryption: fileKey ? { symmetricKey: fileKey } : undefined,
        txSeqs: meta.txSeqs,
        onProgress,
      })
      if (fileKey && !decrypted) throw new Error('decryption failed (wrong key?)')
      return data
    },
    [fileKeyFor]
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
          await downloadFile(meta.rootHashes, NETWORK, {
            decryption:
              meta.encryption === 'none'
                ? undefined
                : { symmetricKey: fileKey! },
            txSeqs: meta.txSeqs,
            onProgress: (msg, pct) => log(`${meta.name}: ${msg}`, pct),
            onPlainChunk: (chunk) => {
              chain = chain.then(() => writable.write(chunk))
            },
          })
          await chain
          await writable.close()
          log(`${meta.name} streamed to disk.`)
        } else {
          const { data, decrypted } = await downloadFile(meta.rootHashes, NETWORK, {
            decryption:
              meta.encryption === 'none'
                ? undefined
                : { symmetricKey: fileKey! },
            txSeqs: meta.txSeqs,
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
    [wallet, fileKeyFor, log]
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
          r: shareFor.rootHashes, q: shareFor.txSeqs ?? [],
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
        const profile = await getProfile(recipient, NETWORK)
        if (!profile) {
          throw new Error(
            'recipient has not published a share key (they need to open 0GDrive and publish one)'
          )
        }
        setShareBusy('Wrapping key…')
        const wrapped = await wrapFileKeyToPubKey(profile.pubKey, fileKey)
        const derived = profile.kind === 'share'
        const link = base + buildEncryptedShareLink({
          v: 1, n: shareFor.name, m: shareFor.mime, z: shareFor.size,
          r: shareFor.rootHashes, q: shareFor.txSeqs ?? [],
          w: wrapped, to: recipient,
          ...(derived ? { d: 1 as const, p: profile.pubKey } : {}),
        })
        setShareLink(link)
        if (!derived) {
          setShareError(
            'This recipient published an older share key: they’ll need their raw private key to open the link. ' +
            'If they open 0GDrive and update their share key, a new link opens with a wallet signature.'
          )
        }
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
      setBusy(view === 'trash' ? `Removing ${meta.name} from trash…` : `Moving ${meta.name} to trash…`)
      try {
        if (view === 'trash') {
          await store.purgeFromTrash(meta.id)
          log(`${meta.name} removed from trash (blob remains on the network).`)
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
    setRenameFor(meta)
    setRenameTo(meta.name)
    setRenameError(null)
  }, [])

  const submitRename = useCallback(async () => {
    const store = storeRef.current
    const meta = renameFor
    if (!store || !meta) return
    const name = renameTo.trim()
    if (name === meta.name) {
      setRenameFor(null)
      return
    }
    setRenameError(null)
    setBusy(`Renaming ${meta.name}…`)
    try {
      const search = await entryForRename(meta.search, name)
      await store.renameFile(currentPath, meta.id, name, search)
      log(`Renamed ${meta.name} → ${name}.`)
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
        await store.restoreFromTrash(meta.id)
        log(`${meta.name} restored to ${meta.originalPath ?? 'drive root'}.`)
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
      await store.restoreRecords(selectedIds)
      log(`${n} file${n === 1 ? '' : 's'} restored.`)
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

  const smart = useSmartDrive({ drive, storeRef, currentPath, loadBytes, reloadDrive, log, setBusy })

  /** what the assistant may know about this drive: on/off facts only — no address, names or keys */
  const assistantStatus = (): DriveStatus => ({
    screen: drive ? 'drive' : 'start',
    walletConnected: !!wallet && !readOnly,
    network: `${NETWORK.chainName} (${NETWORK.mode})`,
    driveOpen: !!masterKeyHex,
    readOnly,
    recovery: hasBackup ? 'on' : hasBackup === false ? 'off' : wallet && !backupCheckError ? 'checking' : 'unknown',
    password: hasPassword ? 'set' : hasPassword === false ? 'not-set' : 'unknown',
    shareKey:
      profilePubKey && !profileLegacy
        ? 'published'
        : profileState === 'checking'
          ? 'checking'
          : profileState !== 'ok'
            ? 'unknown'
            : profilePubKey
              ? 'outdated'
              : 'not-published',
    onDeviceAi: !smart.enabled ? 'off' : smart.model.loading ? 'loading' : smart.model.error ? 'error' : 'ready',
    view,
    uploading: queue.some((q) => q.state !== 'done' && q.state !== 'error'),
    lowBalance: !!wallet && !readOnly && Number(wallet.balance) < 0.01,
  })
  const showForAssistant = (target: string) =>
    highlight(target, (sidebar) => {
      if (target === 'lost-wallet') setLostOpen(true)
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
        <button className="btn small" disabled={busy !== null} onClick={() => restoreFile(f)} aria-label="Restore">
          <ActionLabel icon="restore" label="Restore" />
        </button>
        <button className="btn small danger" disabled={busy !== null} onClick={() => trashFile(f)} title="Remove record from trash" aria-label="Remove from trash">
          <ActionLabel icon="close" />
        </button>
      </>
      )
    ) : (
      <>
        <button className="btn small" disabled={busy !== null} onClick={() => download(f)} aria-label="Download">
          <ActionLabel icon="download" label="Download" />
        </button>
        <button
          className="btn small"
          disabled={busy !== null || !f.wrappedKey}
          title={f.wrappedKey ? 'Share this file' : 'Legacy file — re-upload to enable sharing'}
          onClick={() => openShare(f)}
          aria-label="Share"
        >
          <ActionLabel icon="share" label="Share" />
        </button>
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
            {NETWORK.chainName} · {NETWORK.mode}
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
            </span>
          ) : (
            <button className="btn primary" onClick={connect} data-guide="connect">
              Connect wallet
            </button>
          )}
        </div>
      </header>

      {!hasWallet() && (
        <div className="banner warn">
          No Ethereum wallet detected. Install a wallet extension such as <strong>MetaMask</strong> or{' '}
          <strong>Rabby</strong> to use 0GDrive.
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

      {wallet && !masterKeyHex && (
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
              <strong>Checking for an existing drive on-chain…</strong> (scanning this
              account's upload history)
            </div>
          ) : hasBackup ? (
            <div>
              <strong>This account has a drive on-chain.</strong> Restore it with one
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
              <strong>Create your drive.</strong> A key is generated in this browser;
              files are encrypted with it before ever leaving your device.
              <div className="banner-actions">
                <button className="btn primary" onClick={generateKey}>
                  Create my drive
                </button>
                <input
                  className="key-input"
                  placeholder="or import an existing 0x… key"
                  value={keyImport}
                  onChange={(e) => setKeyImport(e.target.value)}
                />
                <button className="btn" onClick={importKey}>Import</button>
              </div>
            </div>
          )}
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
              {wallet && masterKeyHex && (
                <div className="sidebar-sec" data-guide="security">
                  <div className="sec-heading">Security</div>
                  <div className="sec-grid">
                    {!readOnly && (
                      <>
                        <SecRow
                          id="recovery"
                          label="Recovery"
                          hint="Your drive key, locked to a wallet signature and backed up on-chain"
                          status={
                            hasBackup ? (
                              <SecOk>On</SecOk>
                            ) : hasBackup === null ? (
                              <SecOff>{backupCheckError ? 'Couldn’t check' : 'Checking…'}</SecOff>
                            ) : (
                              <SecOff>Off</SecOff>
                            )
                          }
                          action={
                            hasBackup === null && backupCheckError ? (
                              <button className="sec-action" onClick={() => void checkBackup(wallet.address)} title={backupCheckError}>
                                Retry
                              </button>
                            ) : hasBackup === false ? (
                              <button
                                className="sec-action primary"
                                onClick={enableRecovery}
                                disabled={restoreBusy !== null}
                                aria-label="Set up recovery"
                                title="2 signatures + 1 transaction: backs up your drive key on-chain and publishes your share key"
                              >
                                {restoreBusy?.includes('signature') ? 'Signing…' : 'Set up'}
                              </button>
                            ) : null
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
                        {hasBackup && (
                          <SecRow
                            id="share-key"
                            label="Share key"
                            hint="Lets others send you encrypted files that open with a wallet signature"
                            status={
                              profilePubKey && !profileLegacy ? (
                                <SecOk>Published</SecOk>
                              ) : profileState === 'checking' ? (
                                <SecOff>Checking…</SecOff>
                              ) : profileState !== 'ok' ? (
                                <SecOff>Couldn’t check</SecOff>
                              ) : (
                                <SecOff>{profilePubKey ? 'Outdated' : 'Not published'}</SecOff>
                              )
                            }
                            action={
                              profilePubKey && !profileLegacy ? null : profileState === 'checking' ? null : profileState !== 'ok' ? (
                                <button className="sec-action" onClick={() => checkProfile(wallet.address)} title={profileState}>
                                  Retry
                                </button>
                              ) : (
                                <button
                                  className="sec-action primary"
                                  onClick={publishShareKey}
                                  disabled={publishing}
                                  aria-label={profilePubKey ? 'Update share key' : 'Publish share key'}
                                  title="2 signatures + 1 transaction"
                                >
                                  {publishing ? 'Publishing…' : profilePubKey ? 'Update' : 'Publish'}
                                </button>
                              )
                            }
                          />
                        )}
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
                </div>
              )}
              <div className="sidebar-sec" data-guide="on-device-ai">
                <div className="sec-heading">On-device AI</div>
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
                      ? 'Models failed to load — search matches names only. Retry from the search box.'
                      : smart.enabled
                      ? 'Runs on this device. Models (~300 MB) download once.'
                      : 'Off — search matches file names only.'}
                </div>
              </div>
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
                    <button className="btn small danger" disabled={busy !== null} onClick={trashSelected}>
                      Trash selected
                    </button>
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
                  {q.state === 'registering' && '📝 registering — check your wallet'}
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
                Per-file encryption · metadata on-chain · stored on 0G Storage
              </div>
            </div>
          </label>
        </section>
        )}

        {!wallet && !readOnly ? (
          <Welcome onConnect={connect} />
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
                <button className="btn small" disabled={busy !== null} onClick={() => download(m)} aria-label="Download">
                  <ActionLabel icon="download" label="Download" />
                </button>
                <button
                  className="btn small"
                  disabled={busy !== null || !m.wrappedKey}
                  onClick={() => openShare(m)}
                  aria-label="Share"
                >
                  <ActionLabel icon="share" label="Share" />
                </button>
              </>
            )}
            onClear={smart.clearSearch}
          />
        ) : (
        <section className="files">
          {view === 'drive' && drive && smart.enabled && shownFiles.length > 0 && !readOnly && (
            <div className="ai-bar">
              {smart.unindexed.length > 0 && (
                <button className="btn small" disabled={busy !== null} onClick={smart.indexFolder}
                  title="Download, read and index these files on this device, then save the index (1 wallet approval)">
                  Index {smart.unindexed.length} older file{smart.unindexed.length === 1 ? '' : 's'} for search
                </button>
              )}
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
                Encrypted per file · metadata on-chain · restorable on any device with one signature
              </p>
              <p className="hero-hint">Use the upload zone above to store your first file</p>
            </div>
          ) : shownFiles.length === 0 ? (
            <p className="empty">
              {view === 'trash' ? 'Trash is empty.' : ''}
            </p>
          ) : layout === 'grid' ? (
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
                        fallback={<span className="tile-icon"><FileIcon meta={f} /></span>}
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
          ) : (
            <table>
              <thead>
                <tr>
                  <th className="th-check">
                    <input
                      type="checkbox"
                      checked={shownFiles.length > 0 && selectedIds.length === shownFiles.length}
                      onChange={() =>
                        setSelectedIds(
                          selectedIds.length === shownFiles.length
                            ? []
                            : shownFiles.map((f) => f.id)
                        )
                      }
                      aria-label="select all"
                    />
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
                      <a
                        href={`${NETWORK.storageScanUrl}/file/${f.rootHashes[0]}`}
                        target="_blank"
                        rel="noreferrer"
                        title={f.rootHashes[0]}
                      >
                        {shortHash(f.rootHashes[0])}
                      </a>
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
        <div className="modal-backdrop" onClick={() => restoreBusy === null && setPwDialog(false)}>
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
            <p className="muted small-print">1 signature + 1 transaction</p>
          </form>
        </div>
      )}

      {renameFor && (() => {
        const name = renameTo.trim()
        const ext = (n: string) => (/\.([^./]+)$/.exec(n)?.[1] ?? '').toLowerCase()
        const clash =
          name.toLowerCase() !== renameFor.name.toLowerCase() &&
          shownFiles.some((f) => f.id !== renameFor.id && f.name.toLowerCase() === name.toLowerCase())
        const problem = fileNameProblem(name) ?? (clash ? `There is already a file named “${name}” in this folder.` : null)
        const extChanged = !problem && ext(name) !== ext(renameFor.name)
        return (
          <div className="modal-backdrop" onClick={() => busy === null && setRenameFor(null)}>
            <form
              className="modal rename-modal"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.key === 'Escape' && busy === null && setRenameFor(null)}
              onSubmit={(e) => {
                e.preventDefault()
                if (!problem) void submitRename()
              }}
            >
              <h2>Rename file</h2>
              <input
                className="key-input wide"
                aria-label="New name"
                value={renameTo}
                maxLength={300}
                onChange={(e) => setRenameTo(e.target.value)}
                onFocus={(e) => {
                  // select the name without its extension, like a desktop file manager
                  const dot = renameFor.name.lastIndexOf('.')
                  e.target.setSelectionRange(0, dot > 0 ? dot : renameFor.name.length)
                }}
                autoFocus
                spellCheck={false}
                autoComplete="off"
              />
              {problem && name !== renameFor.name && <p className="error-text">⚠ {problem}</p>}
              {extChanged && (
                <p className="muted">
                  {ext(name)
                    ? `The extension changes from “.${ext(renameFor.name) || '(none)'}” to “.${ext(name)}”. `
                    : 'The name has no extension. '}
                  0GDrive keeps opening it as the type it was uploaded as; other apps may treat it differently after download.
                </p>
              )}
              {renameError && <p className="error-text">⚠ {renameError}</p>}
              <div className="modal-actions">
                <button className="btn" type="button" onClick={() => setRenameFor(null)} disabled={busy !== null}>
                  Cancel
                </button>
                <button className="btn primary" type="submit" disabled={busy !== null || !!problem || name === renameFor.name}>
                  {busy !== null ? 'Renaming…' : 'Rename'}
                </button>
              </div>
              <p className="muted small-print">1 transaction · the file itself isn’t re-uploaded · links you already shared keep the old name</p>
            </form>
          </div>
        )
      })()}

      {shareFor && (
        <div className="modal-backdrop" onClick={() => setShareFor(null)}>
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
