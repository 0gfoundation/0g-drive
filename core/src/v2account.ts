import { ethers } from 'ethers'
import { deriveStorageKey, type RelayerClient, type V2Network } from './v2relayer.js'
import { readAccountCard } from './v2backend.js'
import { derivePasswordKey, gcmUnwrap, gcmWrap } from './recovery.js'
import { bytesToHex, hexToBytes } from './keystore.js'

/**
 * A wallet's drive on V2, found from the wallet's address alone.
 *
 * The drive's storage account is derived from the drive master key
 * (deriveStorageKey), so it can't be computed from the wallet. What links
 * them is public: the wallet funds the account in the PaymentVault, whose
 * deposit event names both (only the wallet can make itself the payer),
 * and the account's newest root carries this card, signed by the wallet,
 * saying the account is its drive. The card also holds what the V1 backup
 * manifest held: the master key wrapped under the recovery signature
 * and/or a password, and the sharing public key. See D19.
 */
export interface AccountCard {
  v: 1
  /** lowercase */
  wallet: string
  /** lowercase */
  account: string
  /** the wallet's signature of bindingMessage(wallet, account) */
  binding: string
  /** sharing public key (sharekey.ts) */
  shareKey?: string
  /** M wrapped under S (recovery.ts), hex */
  wrappedUnderSignature?: string
  /** M wrapped under P, hex, with its PBKDF2 salt */
  wrappedUnderPassword?: string
  passwordSalt?: string
  updatedAt: number
}

/** Byte-identical forever for a given pair: cards signed with it are verified against it. */
export function bindingMessage(wallet: string, account: string): string {
  return (
    '0GDrive: storage account v1.\n' +
    `Wallet: ${wallet.toLowerCase()}\n` +
    `Storage account: ${account.toLowerCase()}\n` +
    'This links your wallet to your drive’s storage account. It grants no permissions and sends nothing on-chain.'
  )
}

/** The wallet signs that `account` is its drive (one prompt, at setup). */
export function signBinding(signer: { signMessage(message: string): Promise<string> }, wallet: string, account: string): Promise<string> {
  return signer.signMessage(bindingMessage(wallet, account))
}

/**
 * The card for a drive: the master key wrapped under the recovery key S
 * and/or a password. A password wrap in `previous` is kept unless a new
 * password is given.
 */
export async function makeCard(o: {
  wallet: string
  account: string
  binding: string
  masterKey: Uint8Array
  recoveryKey?: Uint8Array
  password?: string
  shareKey?: string
  previous?: AccountCard | null
}): Promise<AccountCard> {
  const card: AccountCard = {
    v: 1,
    wallet: o.wallet.toLowerCase(),
    account: o.account.toLowerCase(),
    binding: o.binding,
    updatedAt: Date.now(),
  }
  const shareKey = o.shareKey ?? o.previous?.shareKey
  if (shareKey) card.shareKey = shareKey
  if (o.recoveryKey) card.wrappedUnderSignature = await gcmWrap(o.recoveryKey, o.masterKey)
  else if (o.previous?.wrappedUnderSignature) card.wrappedUnderSignature = o.previous.wrappedUnderSignature
  if (o.password) {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    card.wrappedUnderPassword = await gcmWrap(await derivePasswordKey(o.password, salt), o.masterKey)
    card.passwordSalt = bytesToHex(salt)
  } else if (o.previous?.wrappedUnderPassword && o.previous.passwordSalt) {
    card.wrappedUnderPassword = o.previous.wrappedUnderPassword
    card.passwordSalt = o.previous.passwordSalt
  }
  return card
}

const ERC1271_MAGIC = '0x1626ba7e'

/**
 * Is `card` the drive card of `wallet` for `account`: its binding signed
 * by the wallet (a plain signature, or ERC-1271 for a contract account)?
 */
export async function verifyCard(net: V2Network, card: unknown, wallet: string, account: string): Promise<boolean> {
  const c = card as AccountCard | null
  if (c?.v !== 1 || typeof c.binding !== 'string') return false
  if (c.wallet !== wallet.toLowerCase() || c.account !== account.toLowerCase()) return false
  const message = bindingMessage(wallet, account)
  try {
    if (ethers.verifyMessage(message, c.binding).toLowerCase() === c.wallet) return true
  } catch {
    // not a 65-byte ECDSA signature: maybe a contract account's
  }
  const provider = new ethers.JsonRpcProvider(net.rpc, net.chainId, { staticNetwork: true })
  if ((await provider.getCode(wallet)) === '0x') return false
  const contract = new ethers.Contract(wallet, ['function isValidSignature(bytes32, bytes) view returns (bytes4)'], provider)
  return (await contract.isValidSignature(ethers.hashMessage(message), c.binding).catch(() => '0x')) === ERC1271_MAGIC
}

/** The vault's deposit event (topics: user, payer; data: amount), as seen on Galileo. */
const DEPOSIT_TOPIC = '0x850c6acf6de637840ba0b63d346a5ded6fe578532c565edb26a8d2c5db4f2680'
/** blocks per getLogs (the public RPC's limit) */
const LOG_WINDOW = 150_000

/** Where a device keeps what it has scanned of a wallet's deposits. */
export interface DepositCache {
  load(): { accounts: { account: string; block: number }[]; toBlock: number } | null
  save(value: { accounts: { account: string; block: number }[]; toBlock: number }): void
}

/** Accounts `wallet` has funded, last funded first. */
export async function fundedAccounts(net: V2Network, wallet: string, cache?: DepositCache): Promise<string[]> {
  const provider = new ethers.JsonRpcProvider(net.rpc, net.chainId, { staticNetwork: true })
  const head = await provider.getBlockNumber()
  const cached = cache?.load() ?? null
  const seen = new Map<string, number>((cached?.accounts ?? []).map((a) => [a.account, a.block]))
  const payer = ethers.zeroPadValue(wallet.toLowerCase(), 32)
  for (let from = cached ? cached.toBlock + 1 : net.vaultFromBlock; from <= head; from += LOG_WINDOW) {
    const logs = await provider.getLogs({
      address: net.paymentVault,
      topics: [DEPOSIT_TOPIC, null, payer],
      fromBlock: from,
      toBlock: Math.min(head, from + LOG_WINDOW - 1),
    })
    for (const l of logs) seen.set(ethers.getAddress(ethers.dataSlice(l.topics[1], 12)).toLowerCase(), l.blockNumber)
  }
  const accounts = [...seen].map(([account, block]) => ({ account, block })).sort((a, b) => b.block - a.block)
  cache?.save({ accounts, toBlock: head })
  return accounts.map((a) => a.account)
}

/** The wallet's drive: the last-funded account whose card the wallet signed, or null (no drive yet). */
export async function findDrive(
  net: V2Network,
  relayer: RelayerClient,
  wallet: string,
  cache?: DepositCache
): Promise<{ account: string; card: AccountCard } | null> {
  for (const account of await fundedAccounts(net, wallet, cache)) {
    const card = await readAccountCard(relayer, account)
    if (await verifyCard(net, card, wallet, account)) return { account, card: card as AccountCard }
  }
  return null
}

/** The master key from a card, and a check that it is this card's drive. */
function checked(card: AccountCard, masterKey: Uint8Array): Uint8Array {
  if (deriveStorageKey(masterKey).address.toLowerCase() !== card.account) {
    throw new Error('the unlocked drive key is not this drive’s')
  }
  return masterKey
}

/** Unlock the drive key with the recovery key S (from the wallet's recovery signature). */
export async function unlockCardBySignature(card: AccountCard, recoveryKey: Uint8Array): Promise<Uint8Array> {
  if (!card.wrappedUnderSignature) throw new Error('this drive has no signature recovery')
  return checked(card, await gcmUnwrap(card.wrappedUnderSignature, recoveryKey))
}

/** Unlock the drive key with the recovery password. Throws on a wrong one. */
export async function unlockCardByPassword(card: AccountCard, password: string): Promise<Uint8Array> {
  if (!card.wrappedUnderPassword || !card.passwordSalt) throw new Error('this drive has no recovery password')
  const key = await derivePasswordKey(password, hexToBytes(card.passwordSalt))
  return checked(card, await gcmUnwrap(card.wrappedUnderPassword, key).catch(() => {
    throw new Error('wrong password')
  }))
}
