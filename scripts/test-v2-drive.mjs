// The drive on 0G Storage V2: DriveStore with the V2 backend (core/v2backend.ts)
// against the testnet relayer. A fresh storage account, funded from the
// .env wallet; folders, uploads, rename, move, trash; a restart from the
// relayer alone; two devices changing the drive at once; a wrong drive key;
// superseded versions deleted; then every file of the account deleted.
// Usage: npm run test:v2-drive  (reads PRIVATE_KEY from env or .env)
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
} from '../core/dist/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const privateKey =
  process.env.PRIVATE_KEY ?? /^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(readFileSync(resolve(root, '.env'), 'utf8'))?.[1]
if (!privateKey) {
  console.error('Usage: npm run test:v2-drive (needs PRIVATE_KEY env or .env)')
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
const names = (folder) => (folder?.files ?? []).map((f) => f.name).sort().join(', ')
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

try {
  const store = newStore()
  let drive = await store.loadDrive()
  check('a new account is an empty drive', drive.paths.length === 0 && !drive.folders.get(''))

  await store.createFolder('Docs')
  await store.createFolder('Docs/2025')
  await store.createFolder('Photos')
  drive = await store.loadDrive()
  check('folders created', drive.paths.join(',') === 'Docs,Docs/2025,Photos', drive.paths.join(','))

  const big = new Uint8Array(5 * 1024 * 1024 + 123) // 6 chunks
  for (let at = 0; at < big.length; at += 65536) crypto.getRandomValues(big.subarray(at, at + 65536))
  const small = new TextEncoder().encode('hello, V2 drive')
  const { res } = await upload(store, 'Docs', [
    { id: 'f1', name: 'big.bin', bytes: big },
    { id: 'f2', name: 'note.txt', bytes: small },
  ])
  check('two files and their records stored in one change', res.files.every((r) => r.ok) && res.recordsStored)
  drive = await store.loadDrive()
  check('the records are in the folder', names(drive.folders.get('Docs')) === 'big.bin, note.txt', names(drive.folders.get('Docs')))

  const rec = (id) => [...drive.folders.values(), drive.trash].flatMap((f) => f?.files ?? []).find((f) => f.id === id)
  const got = await store.backend.download(rec('f1'), { decryption: { symmetricKey: fileKeys.get('f1') } })
  check('download: byte-identical', got.decrypted && same(got.data, big), `${got.data.length} bytes`)
  const pieces = []
  await store.backend.download(rec('f1'), { decryption: { symmetricKey: fileKeys.get('f1') }, onPlainChunk: (c) => pieces.push(c) })
  const streamed = new Uint8Array(await new Blob(pieces).arrayBuffer())
  check('streamed download: byte-identical', same(streamed, big), `${pieces.length} pieces`)

  await store.renameFile('Docs', 'f2', 'readme.txt')
  await store.moveRecords('Docs', [{ id: 'f1', to: 'Photos' }])
  await store.renameFolder('Docs/2025', '2026')
  await store.removeFileRecord('Docs', 'f2') // to trash
  drive = await store.loadDrive()
  check(
    'rename, move, folder rename, trash',
    names(drive.folders.get('Photos')) === 'big.bin' &&
      names(drive.folders.get('Docs')) === '' &&
      names(drive.trash) === 'readme.txt' &&
      drive.paths.includes('Docs/2026'),
    `Photos: ${names(drive.folders.get('Photos'))}; trash: ${names(drive.trash)}; ${drive.paths.join(',')}`
  )

  // a restart: a new store with nothing in memory, only the relayer
  let fresh = newStore()
  drive = await fresh.loadDrive()
  check(
    'after restart: the same drive, from the relayer alone',
    drive.paths.join(',') === 'Docs,Docs/2026,Photos' && names(drive.folders.get('Photos')) === 'big.bin' && names(drive.trash) === 'readme.txt',
    drive.paths.join(',')
  )
  const again = await fresh.backend.download(rec('f2'), { decryption: { symmetricKey: fileKeys.get('f2') } })
  check('after restart: a file downloads', new TextDecoder().decode(again.data) === 'hello, V2 drive')

  // two devices, both on the same root, change different folders at the
  // same moment (the same listing changed on both keeps the later, as on V1)
  const a = newStore()
  const b = newStore()
  await a.loadDrive()
  await b.loadDrive()
  const record = (id, name) => ({ ...rec('f1'), id, name })
  await Promise.all([a.putFileRecord('Docs', record('fa', 'from-a.bin')), b.putFileRecord('Docs/2026', record('fb', 'from-b.bin'))])
  drive = await newStore().loadDrive()
  check(
    'two devices at once: both changes kept',
    names(drive.folders.get('Docs')) === 'from-a.bin' && names(drive.folders.get('Docs/2026')) === 'from-b.bin',
    `Docs: ${names(drive.folders.get('Docs'))}; Docs/2026: ${names(drive.folders.get('Docs/2026'))}`
  )

  let wrongKey = ''
  try {
    await newStore(crypto.getRandomValues(new Uint8Array(32))).loadDrive()
  } catch (err) {
    wrongKey = err.message
  }
  check('a wrong drive key fails loudly (no empty drive)', /wrong drive key/.test(wrongKey), wrongKey)

  await store.purgeFromTrash('f2')
  drive = await newStore().loadDrive()
  check('purged from trash', names(drive.trash) === '', names(drive.trash))

  // superseded versions are deleted a change later, in the background
  await new Promise((r) => setTimeout(r, 15_000))
  const listed = await listAll()
  const magic = new TextEncoder().encode('0GDrive root v2\n')
  const heads = await Promise.all(listed.map((f) => relayer.head(f.dataHash, magic.length)))
  const roots = heads.filter((h) => same(h, magic)).length
  check('superseded roots deleted: at most the current one and the one before', roots <= 2, `${roots} root(s) among ${listed.length} files`)
  // files: 2 uploads (the purged one too: purge drops the record, not the blob)
  // + current listings (index, root, 3+2 folders, trash) + one change of grace
  check('old listing versions deleted', listed.length <= 2 + 8 + 8, `${listed.length} files`)

  const balance = await storageBalance(V2_TESTNET, account.address)
  console.log(`${stamp()} storage balance left: ${ethers.formatEther(balance)} of ${ethers.formatEther(DEPOSIT)} 0G`)
} catch (err) {
  failed++
  console.log(`${stamp()} ERROR ${err.stack ?? err}`)
} finally {
  // clean up: stop paying for every file of this test account
  const left = await listAll().catch(() => [])
  let deleted = 0
  for (const f of left) await relayer.delete(account, f.dataHash).then(() => deleted++, () => undefined)
  console.log(`${stamp()} deleted ${deleted}/${left.length} test files`)
}

console.log(`\n${passed}/${passed + failed} checks passed`)
console.log(failed ? 'V2 DRIVE TEST FAILED' : 'V2 DRIVE TEST PASSED ✓')
process.exit(failed ? 1 : 0)
