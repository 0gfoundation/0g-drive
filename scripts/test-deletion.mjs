// Real deletion on 0G Storage V2: DriveStore with the V2 backend against the
// testnet relayer, a fresh storage account funded from the .env wallet.
// Delete forever and Empty trash delete the files' bytes; trash past its
// days is deleted forever (records trashed before dates get today's);
// the leftover sweep deletes a stored file nothing references, keeps every
// recorded file and the drive's own listings (the drive loads intact), skips
// files newer than its grace, and deletes nothing when a listing can't be
// read. Every file of the account is deleted at the end.
// Usage: npm run test:deletion  (reads PRIVATE_KEY from env or .env)
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
  storageBalance,
  TRASH_PATH,
  folderTag,
} from '../core/dist/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const privateKey =
  process.env.PRIVATE_KEY ?? /^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(readFileSync(resolve(root, '.env'), 'utf8'))?.[1]
if (!privateKey) {
  console.error('Usage: npm run test:deletion (needs PRIVATE_KEY env or .env)')
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

const provider = new ethers.JsonRpcProvider(V2_TESTNET.rpc)
const funder = new ethers.Wallet(privateKey, provider)
const account = ethers.Wallet.createRandom() // the storage account (the app derives it from the recovery signature)
const relayer = new RelayerClient(V2_TESTNET)
console.log(`Storage account: ${account.address}`)

const DEPOSIT = ethers.parseEther(process.env.V2_DEPOSIT ?? '0.05')
await depositForUser(V2_TESTNET, funder, account.address, DEPOSIT)
console.log(`${stamp()} deposited ${ethers.formatEther(DEPOSIT)} 0G`)

const masterKey = crypto.getRandomValues(new Uint8Array(32))
const newStore = (key = masterKey) =>
  new DriveStore(new V2Backend(new RelayerClient(V2_TESTNET), account, key))

const fileKeys = new Map()
const bytesOf = new Map()
/** Upload files into a folder the way the app does: blobs, then their records in one change. */
async function upload(store, path, files) {
  const metas = []
  const res = await store.backend.uploadFiles(
    files.map((f) => {
      const key = crypto.getRandomValues(new Uint8Array(32))
      fileKeys.set(f.id, key)
      bytesOf.set(f.id, f.bytes)
      return { data: f.bytes, encryption: { type: 'aes256', key } }
    }),
    {
      finalize: async (refs) => {
        files.forEach((f, i) =>
          metas.push({
            id: f.id,
            name: f.name,
            size: f.bytes.length,
            mime: 'application/octet-stream',
            uploadedAt: Date.now(),
            encryption: 'aes256',
            ...refs[i],
            network: 'testnet:v2',
          })
        )
        return { records: await store.prepareFileRecords(path, metas), extras: [] }
      },
    }
  )
  return { res, metas }
}
async function listAll() {
  const out = []
  for (let before; ; ) {
    const page = await relayer.list(account.address, { limit: 100, before })
    out.push(...page.files)
    if (!page.next || page.files.length === 0) return out
    before = page.next
  }
}
const strip = (h) => h.replace(/^0x/i, '').toLowerCase()
const hashesOf = (metas) => metas.flatMap((m) => m.rootHashes.map(strip))
const stored = async () => new Set((await listAll()).map((f) => strip(f.dataHash)))
/** Until every hash is gone from the account's listing (deletes run in the background), or 60 s. */
async function goneSoon(hashes) {
  const end = Date.now() + 60_000
  for (;;) {
    const now = await stored()
    const left = hashes.filter((h) => now.has(h))
    if (left.length === 0 || Date.now() > end) return left
    await new Promise((r) => setTimeout(r, 3000))
  }
}
const file = (id, text) => ({ id, name: `${id}.txt`, bytes: new TextEncoder().encode(text) })

try {
  const store = newStore()
  await store.loadDrive()
  const { metas } = await upload(store, '', [file('a', 'alpha'), file('b', 'bravo'), file('c', 'charlie'), file('d', 'delta'), file('e', 'echo')])
  const [a, b, c, d, e] = metas
  check('5 files uploaded', (await stored()).size >= 5)

  // delete forever
  await store.removeFileRecord('', a.id, true)
  let drive = await store.loadDrive()
  check('trashed files carry the time they were trashed', typeof drive.trash.files.find((f) => f.id === a.id)?.trashedAt === 'number')
  await store.purgeFromTrash(a.id)
  check('delete forever: its bytes are deleted from 0G', (await goneSoon(hashesOf([a]))).length === 0)

  // empty trash: everything in trash at once
  await store.removeFileRecords('', [b.id, c.id], true)
  drive = await store.loadDrive()
  await store.removeFileRecords(TRASH_PATH, drive.trash.files.map((f) => f.id), false)
  drive = await store.loadDrive()
  check('empty trash: trash is empty', (drive.trash?.files.length ?? 0) === 0)
  check('…and both files are deleted from 0G', (await goneSoon(hashesOf([b, c]))).length === 0)

  // expiry: nothing young expires; past its days it's deleted forever
  await store.removeFileRecord('', d.id, true)
  check('a file trashed just now does not expire', (await store.expireTrash()).length === 0)
  const expired = await store.expireTrash(0)
  drive = await store.loadDrive()
  check('past its days: deleted forever, records and bytes', expired.length === 1 && expired[0].id === d.id && (drive.trash?.files.length ?? 0) === 0 && (await goneSoon(hashesOf([d]))).length === 0)
  // a record trashed before dates were kept (no trashedAt) gets today's date, and stays:
  // put e in trash without a date, as an older version of the app did
  await store.removeFileRecord('', e.id, true)
  drive = await store.loadDrive()
  const t = drive.trash
  t.files = t.files.map(({ trashedAt: _t, ...rest }) => rest)
  t.version += 1
  await store.backend.writeManifests([], [store.manifestItem(t, folderTag(TRASH_PATH))], [], '')
  drive = await store.loadDrive()
  const wasUndated = drive.trash.files.every((f) => f.trashedAt === undefined)
  const none = await store.expireTrash()
  drive = await store.loadDrive()
  check('a record trashed before dates gets today’s date and stays', wasUndated && none.length === 0 && typeof drive.trash.files[0]?.trashedAt === 'number', JSON.stringify(drive.trash.files.map((f) => f.trashedAt)))

  // a leftover: stored by the account, recorded nowhere (as a failed deletion leaves)
  const leftover = await relayer.upload(account, new Blob([crypto.getRandomValues(new Uint8Array(4096))]))
  const leftoverHash = strip(leftover.dataHash)
  check('a leftover file is stored', (await stored()).has(leftoverHash))
  check('the sweep keeps files newer than its grace (a day)', (await newStore().sweepLeftovers()) === 0 && (await stored()).has(leftoverHash))

  // a listing that can't be read: nothing deleted
  const blind = newStore()
  await blind.refresh()
  const read = blind.backend.readManifest.bind(blind.backend)
  let calls = 0
  blind.backend.readManifest = (key) => (++calls === 2 ? Promise.reject(new Error('probe: unreadable')) : read(key))
  const refused = await blind.sweepLeftovers(0).then(() => 'swept', (err) => err.message)
  check('a listing that can’t be read: the sweep deletes nothing', refused === 'probe: unreadable' && (await stored()).has(leftoverHash), refused)

  const before = await stored()
  const swept = await newStore().sweepLeftovers(0)
  const after = await goneSoon([leftoverHash])
  check('the sweep deletes the leftover', swept === 1 && after.length === 0, `${swept} deleted`)
  const now = await stored()
  check('…and nothing else: e’s bytes and the drive’s listings stay', now.has(hashesOf([e])[0]) && now.size === before.size - 1, `${before.size} → ${now.size} files`)
  drive = await newStore().loadDrive()
  check('the drive loads intact after the sweep', drive.trash?.files.length === 1 && drive.trash.files[0].id === e.id)
} catch (err) {
  failed++
  console.log(`${stamp()} ERROR ${err.stack ?? err}`)
} finally {
  const left = await listAll().catch(() => [])
  let deleted = 0
  for (const f of left) await relayer.delete(account, strip(f.dataHash)).then(() => deleted++, () => undefined)
  console.log(`${stamp()} deleted ${deleted}/${left.length} test files`)
}

console.log(`\n${passed}/${passed + failed} checks passed`)
console.log(failed ? 'DELETION TEST FAILED' : 'DELETION TEST PASSED ✓')
process.exit(failed ? 1 : 0)
