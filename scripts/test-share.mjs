// M3 E2E: per-file keys, secret links (Mode A), wallet-gated links (Mode B),
// streaming downloads, and public profiles — all against Galileo testnet.
// Usage: node scripts/test-share.mjs  (reads PRIVATE_KEY from env or .env)
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getNetworkConfig,
  uploadData,
  downloadFile,
  generateFileKey,
  wrapFileKey,
  unwrapFileKey,
  wrapFileKeyToPubKey,
  unwrapFileKeyWithPrivateKey,
  buildShareLink,
  buildEncryptedShareLink,
  parseShareLink,
  downloadSharedFile,
  downloadEncryptedShare,
  publishProfile,
  getProfile,
} from '../core/dist/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let privateKey = process.env.PRIVATE_KEY
if (!privateKey) {
  privateKey = /^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(
    readFileSync(resolve(root, '.env'), 'utf8')
  )?.[1]
}
if (!privateKey) {
  console.error('needs PRIVATE_KEY env or .env')
  process.exit(1)
}

const network = getNetworkConfig('testnet', 'turbo')
const provider = new ethers.JsonRpcProvider(network.rpcUrl)
const sender = new ethers.Wallet(privateKey, provider)
const recipient = ethers.Wallet.createRandom() // Mode B recipient with raw key
const balanceBefore = await provider.getBalance(sender.address)
console.log(`sender:    ${sender.address}`)

let failures = 0
function check(label, cond, detail = '') {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

// ── upload with a per-file key ────────────────────────────────────────
console.log('\n— upload with per-file key —')
const masterKey = new Uint8Array(32)
crypto.getRandomValues(masterKey)
const fileKey = generateFileKey()
const wrappedKey = await wrapFileKey(masterKey, fileKey)
const data = new Uint8Array(300 * 1024) // 300KB, 2 segments (past small-file quirks)
for (let i = 0; i < data.length; i += 65536) {
  crypto.getRandomValues(data.subarray(i, Math.min(i + 65536, data.length)))
}
const result = await uploadData(data, network, sender, {
  encryption: { type: 'aes256', key: fileKey },
  onProgress: () => {},
})
console.log(`  uploaded ${data.length}B, root ${result.rootHash.slice(0, 18)}…`)

// owner reads via wrapped key
const unwrapped = await unwrapFileKey(masterKey, wrappedKey)
check('unwrap under master key', Buffer.from(unwrapped).equals(Buffer.from(fileKey)))
const ownerRead = await downloadFile([result.rootHash], network, {
  decryption: { symmetricKey: unwrapped },
  txSeqs: [result.txSeq],
})
check('owner download+decrypt', ownerRead.decrypted && ownerRead.data.length === data.length)

// ── Mode A: secret link ───────────────────────────────────────────────
console.log('\n— Mode A: secret link —')
const link = buildShareLink({
  v: 1, n: 'shared.bin', m: 'application/octet-stream', z: data.length,
  r: result.rootHashes, q: result.txSeqs, k: Buffer.from(fileKey).toString('hex').replace(/^/, '0x'),
})
const parsed = parseShareLink(link)
check('link parses as mode link', parsed?.mode === 'link')
const a = await downloadSharedFile(parsed.payload, network)
check('recipient (no keys at all) download+decrypt', a.decrypted && a.data.length === data.length)
let aEqual = a.data.length === data.length
for (let i = 0; i < data.length && aEqual; i += 997) if (a.data[i] !== data[i]) aEqual = false
check('bytes match', aEqual)

// ── Mode B: wallet-gated link ─────────────────────────────────────────
console.log('\n— Mode B: wallet-gated link —')
const recipientPub = ethers.SigningKey.computePublicKey(recipient.signingKey.publicKey, true)
const wrappedToPub = await wrapFileKeyToPubKey(recipientPub, fileKey)
const elink = buildEncryptedShareLink({
  v: 1, n: 'shared.bin', m: 'application/octet-stream', z: data.length,
  r: result.rootHashes, q: result.txSeqs, w: wrappedToPub, to: recipient.address,
})
const eparsed = parseShareLink(elink)
check('link parses as mode encrypted', eparsed?.mode === 'encrypted')
const b = await downloadEncryptedShare(eparsed.payload, network, recipient.privateKey)
check('recipient (raw key) download+decrypt', b.decrypted && b.data.length === data.length)
// wrong key must fail loudly (GCM)
let wrongKeyFails = false
try {
  await downloadEncryptedShare(eparsed.payload, network, ethers.Wallet.createRandom().privateKey)
} catch {
  wrongKeyFails = true
}
check('wrong private key rejected', wrongKeyFails)

// ── streaming download ────────────────────────────────────────────────
console.log('\n— streaming download —')
const streamChunks = []
await downloadFile([result.rootHash], network, {
  decryption: { symmetricKey: fileKey },
  txSeqs: [result.txSeq],
  onPlainChunk: (chunk) => streamChunks.push(chunk),
})
const streamed = new Uint8Array(streamChunks.reduce((n, c) => n + c.length, 0))
let off = 0
for (const c of streamChunks) { streamed.set(c, off); off += c.length }
check('streamed length matches', streamed.length === data.length)
let sEqual = streamed.length === data.length
for (let i = 0; i < data.length && sEqual; i += 997) if (streamed[i] !== data[i]) sEqual = false
check('streamed bytes match buffered decrypt', sEqual)

// ── public profile ────────────────────────────────────────────────────
console.log('\n— public profile —')
const profilePub = ethers.SigningKey.computePublicKey(sender.signingKey.publicKey, true)
await publishProfile(network, sender, sender.address, profilePub)
const fetched = await getProfile(sender.address, network)
check('profile published & retrievable', fetched?.pubKey === profilePub)

// ── report ────────────────────────────────────────────────────────────
const balanceAfter = await provider.getBalance(sender.address)
console.log(`\ncost: ${ethers.formatEther(balanceBefore - balanceAfter)} 0G`)
if (failures > 0) {
  console.error(`\n${failures} CHECKS FAILED`)
  process.exit(1)
}
console.log('\nM3 SHARE TEST PASSED ✓')
