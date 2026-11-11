// A wallet's drive on V2, found from the wallet alone (core/v2account.ts):
// setup (recovery signature, binding signature, one deposit, the first
// root with the card), a new device finding the drive by the wallet's
// deposits and unlocking it by signature or password, a password change,
// someone else reading the sharing key, an impostor card in an account the
// wallet also funded, a shared file read with no account, and a purged
// file deleted. Every file of the test accounts is deleted at the end.
// Usage: npm run test:v2-account  (reads PRIVATE_KEY from env or .env)
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DriveStore,
  V2Backend,
  RelayerClient,
  V2_TESTNET,
  depositForUser,
  deriveStorageKey,
  signForKeys,
  signBinding,
  bindingMessage,
  makeCard,
  findDrive,
  fundedAccounts,
  unlockCardBySignature,
  unlockCardByPassword,
  downloadV2,
  TRASH_PATH,
} from '../core/dist/index.js'
import { refund } from './lib/refund.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const privateKey =
  process.env.PRIVATE_KEY ?? /^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(readFileSync(resolve(root, '.env'), 'utf8'))?.[1]
if (!privateKey) {
  console.error('Usage: npm run test:v2-account (needs PRIVATE_KEY env or .env)')
  process.exit(1)
}

const t0 = Date.now()
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(0)}s]`
let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) passed++
  else failed++
  console.log(`${stamp()} ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

const provider = new ethers.JsonRpcProvider(V2_TESTNET.rpc)
const funder = new ethers.Wallet(privateKey, provider)
const user = ethers.Wallet.createRandom().connect(provider) // the user's wallet
const FUNDING = ethers.parseEther(process.env.V2_FUNDING ?? '1')
const DEPOSIT = ethers.parseEther('0.02')
await (await funder.sendTransaction({ to: user.address, value: FUNDING })).wait()
console.log(`Wallet: ${user.address} (funded ${ethers.formatEther(FUNDING)} 0G for gas)`)

const relayer = new RelayerClient(V2_TESTNET)
const accounts = [] // storage accounts to clean up

try {
  // ── setup, as the app does it ──
  const masterKey = crypto.getRandomValues(new Uint8Array(32))
  const account = deriveStorageKey(masterKey)
  accounts.push(account)
  const { recoveryKey, shareKey } = await signForKeys(user, user.address, true)
  const binding = await signBinding(user, user.address, account.address)
  await depositForUser(V2_TESTNET, user, account.address, DEPOSIT)
  const card = await makeCard({ wallet: user.address, account: account.address, binding, masterKey, recoveryKey, password: 'correct horse', shareKey: shareKey.pubKey })
  const backend = new V2Backend(new RelayerClient(V2_TESTNET), account, masterKey, { card })
  await backend.saveCard(card)
  check('setup: deposit and the first root with the card', true, account.address)

  // ── a new device: the wallet's address, nothing else ──
  let cache = null
  const depositCache = { load: () => cache, save: (v) => (cache = v) }
  const found = await findDrive(V2_TESTNET, new RelayerClient(V2_TESTNET), user.address, depositCache)
  check('found from the wallet alone (its deposits, the signed card)', found?.account === account.address.toLowerCase(), found?.account)
  const again = await signForKeys(user, user.address)
  const bySig = await unlockCardBySignature(found.card, again.recoveryKey)
  check('unlocked by the recovery signature', same(bySig, masterKey))
  const byPw = await unlockCardByPassword(found.card, 'correct horse')
  check('unlocked by the password', same(byPw, masterKey))
  let wrong = ''
  await unlockCardByPassword(found.card, 'wrong horse').catch((e) => (wrong = e.message))
  check('a wrong password is refused', wrong === 'wrong password', wrong)

  // the cache: a second lookup scans only new blocks
  const scannedTo = cache.toBlock
  const accs = await fundedAccounts(V2_TESTNET, user.address, depositCache)
  check('deposit cache: a second lookup resumes from its last block', cache.toBlock >= scannedTo && accs[0] === account.address.toLowerCase())

  // ── the drive works on the restored key, and keeps the card ──
  const restored = deriveStorageKey(bySig)
  const store = new DriveStore(new V2Backend(new RelayerClient(V2_TESTNET), restored, bySig))
  await store.loadDrive()
  await store.createFolder('Docs')
  const fileKey = crypto.getRandomValues(new Uint8Array(32))
  const bytes = new TextEncoder().encode('shared over V2')
  const up = await store.backend.uploadFiles([{ data: bytes, encryption: { type: 'aes256', key: fileKey } }], {
    finalize: async (refs) => ({
      records: await store.prepareFileRecords('Docs', [
        { id: 'f1', name: 'note.txt', size: bytes.length, mime: 'text/plain', uploadedAt: Date.now(), encryption: 'aes256', ...refs[0], network: 'testnet:v2' },
      ]),
      extras: [],
    }),
  })
  check('upload on the restored drive', up.recordsStored)
  const afterChanges = await findDrive(V2_TESTNET, new RelayerClient(V2_TESTNET), user.address)
  check('the card rides along with later changes', afterChanges?.card.shareKey === shareKey.pubKey && afterChanges.card.binding === binding)

  // ── a share link: the data hash and the file key, no account ──
  const ref = up.files[0].ref
  const shared = await downloadV2(new RelayerClient(V2_TESTNET), ref.rootHashes, { decryption: { symmetricKey: fileKey } })
  check('a shared file reads with no account', new TextDecoder().decode(shared.data) === 'shared over V2')

  // ── someone else looks up the user's sharing key ──
  const lookup = await findDrive(V2_TESTNET, new RelayerClient(V2_TESTNET), user.address)
  check('someone else finds the sharing key', lookup?.card.shareKey === shareKey.pubKey)

  // ── a password change keeps the signature recovery ──
  const card2 = await makeCard({ wallet: user.address, account: account.address, binding, masterKey, password: 'new horse', previous: lookup.card })
  await store.backend.saveCard(card2)
  const changed = await findDrive(V2_TESTNET, new RelayerClient(V2_TESTNET), user.address)
  const pw2 = await unlockCardByPassword(changed.card, 'new horse')
  const sig2 = await unlockCardBySignature(changed.card, again.recoveryKey)
  check('password changed; signature recovery kept', same(pw2, masterKey) && same(sig2, masterKey))

  // ── an impostor: an account the wallet funded last, claiming to be its drive ──
  const attacker = ethers.Wallet.createRandom()
  const fakeKey = crypto.getRandomValues(new Uint8Array(32))
  const fakeAccount = deriveStorageKey(fakeKey)
  accounts.push(fakeAccount)
  await depositForUser(V2_TESTNET, user, fakeAccount.address, DEPOSIT) // e.g. the user funded someone else's account
  const fakeCard = {
    v: 1,
    wallet: user.address.toLowerCase(),
    account: fakeAccount.address.toLowerCase(),
    binding: await attacker.signMessage(bindingMessage(user.address, fakeAccount.address)),
    shareKey: '0x02' + 'ee'.repeat(32),
    updatedAt: Date.now(),
  }
  await new V2Backend(new RelayerClient(V2_TESTNET), fakeAccount, fakeKey, { card: fakeCard }).saveCard(fakeCard)
  const notFooled = await findDrive(V2_TESTNET, new RelayerClient(V2_TESTNET), user.address)
  check('an impostor card is skipped (not signed by the wallet)', notFooled?.account === account.address.toLowerCase() && notFooled.card.shareKey === shareKey.pubKey, notFooled?.account)

  // ── purge: the file itself is deleted ──
  await store.removeFileRecord('Docs', 'f1')
  await store.purgeFromTrash('f1')
  await new Promise((r) => setTimeout(r, 8000))
  const listed = (await relayer.list(account.address, { limit: 100 })).files.map((f) => f.dataHash.replace(/^0x/, ''))
  check('a purged file is deleted (rent stops)', !listed.includes(ref.rootHashes[0].slice(2)), `${listed.length} files left`)
  const drive = await store.loadDrive()
  check('and gone from the drive', (drive.trash?.files ?? []).length === 0 && (drive.folders.get('Docs')?.files ?? []).length === 0)
} catch (err) {
  failed++
  console.log(`${stamp()} ERROR ${err.stack ?? err}`)
} finally {
  for (const acct of accounts) {
    const files = (await relayer.list(acct.address, { limit: 100 }).catch(() => ({ files: [] }))).files
    for (const f of files) await relayer.delete(acct, f.dataHash).catch(() => undefined)
  }
  console.log(`${stamp()} deleted the test accounts' files`)
  await refund(user, funder.address)
}

console.log(`\n${passed}/${passed + failed} checks passed`)
console.log(failed ? 'V2 ACCOUNT TEST FAILED' : 'V2 ACCOUNT TEST PASSED ✓')
process.exit(failed ? 1 : 0)
