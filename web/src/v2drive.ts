// The drive on 0G Storage V2 (docs/decisions.md D18, D19): the relayer,
// the wallet's drive account and its card, setup, and reads that need no
// account (share links). The app keeps no V1 drive code.
import {
  RelayerClient,
  RelayerError,
  V2Backend,
  V2_TESTNET,
  UnstableSignatureError,
  depositForUser,
  deriveStorageKey,
  downloadV2,
  findDrive,
  findDriveByKey,
  makeCard,
  signBinding,
  signForKeys,
  storageBalance,
  unlockCardByPassword,
  unlockCardBySignature,
  verifyCard,
  type AccountCard,
  type DepositCache,
  type DownloadOpts,
} from '@0gdrive/core'

export const V2 = V2_TESTNET
export const relayer = new RelayerClient(V2)
/** what records stored on V2 say they're on */
export const V2_RECORD_NETWORK = 'testnet:v2'
/** the first deposit at setup (an upload needs about a week of rent up front) */
export const FIRST_DEPOSIT = '0.1'

/** The wallet's scanned deposits, kept so a page load only scans new blocks. */
function depositCacheFor(address: string): DepositCache {
  const key = `0gdrive:v2deposits:${address.toLowerCase()}`
  return {
    load() {
      try {
        const raw = localStorage.getItem(key)
        return raw ? JSON.parse(raw) : null
      } catch {
        return null
      }
    },
    save(value) {
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch {
        // best effort
      }
    },
  }
}

/** The wallet's drive on V2 (its account and card), or null when it has none. */
export function lookupDrive(address: string, ownWallet = true) {
  return findDrive(V2, relayer, address, ownWallet ? depositCacheFor(address) : undefined)
}

/** The wallet's drive from the drive key on this device (no deposit scan), or null. */
export function lookupDriveByKey(address: string, masterKey: Uint8Array) {
  return findDriveByKey(V2, relayer, address, masterKey)
}

/** Does this drive key belong to that drive? */
export function keyMatches(masterKey: Uint8Array, card: AccountCard): boolean {
  return deriveStorageKey(masterKey).address.toLowerCase() === card.account
}

export function backendFor(masterKey: Uint8Array, card?: AccountCard | null) {
  return new V2Backend(relayer, deriveStorageKey(masterKey), masterKey, card ? { card } : {})
}

export const balanceOf = (masterKey: Uint8Array) => storageBalance(V2, deriveStorageKey(masterKey).address)

/** A deposit the wallet couldn't make or refused, in words (ethers' own message carries the whole transaction). */
export class DepositError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DepositError'
  }
}

const fmt0G = async (wei: bigint) => `${(await import('ethers')).formatEther(wei)} 0G`

async function walletBalance(signer: Parameters<typeof depositForUser>[1]): Promise<bigint | null> {
  try {
    return (await signer.provider?.getBalance(await signer.getAddress())) ?? null
  } catch {
    return null
  }
}

async function tooLittle(signer: Parameters<typeof depositForUser>[1], amount: bigint): Promise<DepositError> {
  const balance = await walletBalance(signer)
  return new DepositError(
    `Your wallet doesn’t have enough 0G for the ${await fmt0G(amount)} deposit and its network fee` +
      (balance === null ? '' : ` (it has ${await fmt0G(balance)})`) +
      '. Add 0G to this wallet, then try again.'
  )
}

/** Before setup asks for more signatures: a wallet holding less than the deposit can't finish it. */
async function checkCanDeposit(signer: Parameters<typeof depositForUser>[1], amount: bigint) {
  const balance = await walletBalance(signer)
  if (balance !== null && balance < amount) throw await tooLittle(signer, amount)
}

/** The vault deposit from the wallet (one transaction), its wallet errors in words. */
async function depositFromWallet(signer: Parameters<typeof depositForUser>[1], account: string, amount: bigint) {
  try {
    return await depositForUser(V2, signer, account, amount)
  } catch (err) {
    const { isError } = await import('ethers')
    const msg = String((err as Error)?.message ?? err)
    if (isError(err, 'INSUFFICIENT_FUNDS') || /insufficient funds/i.test(msg)) throw await tooLittle(signer, amount)
    if (isError(err, 'ACTION_REJECTED') || /user (rejected|denied)/i.test(msg)) throw new DepositError('The deposit was rejected in your wallet.')
    throw err
  }
}

/** Fund the drive's storage account from the wallet (one transaction). */
export function deposit(signer: Parameters<typeof depositForUser>[1], masterKey: Uint8Array, amount: bigint) {
  return depositFromWallet(signer, deriveStorageKey(masterKey).address, amount)
}

type Signer = Parameters<typeof depositForUser>[1] & { signMessage(message: string): Promise<string> }

/** How long the relayer may take to see the first deposit before setup gives up. */
const RELAYER_SEES_DEPOSIT_MS = 90_000

/**
 * The drive's first root, right after its first deposit. The relayer checks
 * the balance through its own view of the chain, which can still be from
 * before the deposit ("have 0 wei"), so a shortfall then is tried again for
 * a while instead of failing the setup.
 */
async function saveFirstRoot(masterKey: Uint8Array, card: AccountCard, deposited: boolean, onStep: (step: string) => void) {
  const deadline = Date.now() + RELAYER_SEES_DEPOSIT_MS
  for (;;) {
    try {
      return await backendFor(masterKey, card).saveCard(card)
    } catch (err) {
      if (!deposited || !isShortfall(err) || Date.now() > deadline) throw err
      onStep('Waiting for 0G Storage to see your deposit…')
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
}

/**
 * Set up a drive for this key: the recovery signature (twice: the wallet
 * must sign it the same way), the signature linking the wallet to the
 * storage account, the first deposit (skipped when the account already
 * has a balance: a setup interrupted after it), then the first root,
 * carrying the card.
 */
export async function setupDrive(
  signer: Signer,
  address: string,
  masterKey: Uint8Array,
  firstDeposit: bigint,
  onStep: (step: string) => void
): Promise<AccountCard> {
  const account = deriveStorageKey(masterKey).address
  onStep('Waiting for signature (1 of 3)…')
  const { recoveryKey, shareKey } = await signForKeys(signer, address, true)
  const needsDeposit = (await storageBalance(V2, account)) === 0n
  if (needsDeposit) await checkCanDeposit(signer, firstDeposit)
  onStep('Waiting for signature (3 of 3)…')
  const binding = await signBinding(signer, address, account)
  if (needsDeposit) {
    onStep('Approve the deposit in your wallet…')
    await depositFromWallet(signer, account, firstDeposit)
  }
  onStep('Saving your drive…')
  const card = await makeCard({ wallet: address, account, binding, masterKey, recoveryKey, shareKey: shareKey.pubKey })
  await saveFirstRoot(masterKey, card, needsDeposit, onStep)
  return card
}

/**
 * Set up a drive whose key is recoverable only by password (and key file):
 * for wallets whose signatures change from one signing to the next, which
 * can't hold a signature-locked key. One signature (the link from the
 * wallet to the storage account, checked the way finding the drive checks
 * it: a smart account not yet deployed is refused here, before the
 * deposit), then the first deposit and the first root. No share key.
 */
export async function setupDriveWithPassword(
  signer: Signer,
  address: string,
  masterKey: Uint8Array,
  password: string,
  firstDeposit: bigint,
  onStep: (step: string) => void
): Promise<AccountCard> {
  const account = deriveStorageKey(masterKey).address
  const needsDeposit = (await storageBalance(V2, account)) === 0n
  if (needsDeposit) await checkCanDeposit(signer, firstDeposit)
  onStep('Waiting for signature…')
  const binding = await signBinding(signer, address, account)
  const draft = { v: 1, wallet: address.toLowerCase(), account: account.toLowerCase(), binding }
  if (!(await verifyCard(V2, draft, address, account))) {
    throw new Error(
      'Your wallet’s signature can’t be checked on 0G (a smart account that isn’t deployed yet can’t sign for it), ' +
        'so this wallet couldn’t find its drive again. Your drive was not created. Make one transaction from this wallet first, or use a different wallet.'
    )
  }
  if (needsDeposit) {
    onStep('Approve the deposit in your wallet…')
    await depositFromWallet(signer, account, firstDeposit)
  }
  onStep('Saving your drive…')
  const card = await makeCard({ wallet: address, account, binding, masterKey, password })
  await saveFirstRoot(masterKey, card, needsDeposit, onStep)
  return card
}

/** The drive key from the card with the wallet's recovery signature. */
export async function restoreBySignature(signer: Signer, address: string, card: AccountCard): Promise<Uint8Array> {
  const { recoveryKey } = await signForKeys(signer, address)
  return unlockCardBySignature(card, recoveryKey)
}

/** The drive key from the card with its password: as typed, then trimmed (passwords used to be set untrimmed). */
export async function restoreByPassword(card: AccountCard, password: string): Promise<Uint8Array> {
  if (!card.wrappedUnderPassword) throw new Error('This drive has no recovery password — it can only be restored with its wallet or key file.')
  for (const pw of new Set([password, password.trim()])) {
    try {
      return await unlockCardByPassword(card, pw)
    } catch {
      // try the next form
    }
  }
  throw new Error('Wrong recovery password.')
}

/** A new card with a new password (the signature recovery and the binding kept: no prompt). */
export async function withPassword(card: AccountCard, masterKey: Uint8Array, password: string): Promise<AccountCard> {
  return makeCard({ wallet: card.wallet, account: card.account, binding: card.binding, masterKey, password, previous: card })
}

/** A shared or record-named file's bytes: reads need no account. */
export function readV2(rootHashes: string[], opts?: DownloadOpts) {
  return downloadV2(relayer, rootHashes, opts)
}

/**
 * What an upload needs in the storage balance before it starts: about a
 * week of rent (testnet: ~38.9 0G per TB per month), doubled for margin.
 * The relayer has the final word (PAYER_SHORTFALL).
 */
export function uploadNeed(bytes: number): bigint {
  const weiPerByteWeek = ((38.9e18 / 1e12) * 7) / 30
  return BigInt(Math.ceil(bytes * weiPerByteWeek * 2))
}

/** The relayer refused for lack of storage balance. */
export function isShortfall(err: unknown): boolean {
  if (err instanceof RelayerError) return err.reason === 'PAYER_SHORTFALL' || err.status === 402
  return /PAYER_SHORTFALL/.test(String((err as Error)?.message ?? err))
}

export { UnstableSignatureError }
