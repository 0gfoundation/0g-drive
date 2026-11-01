// Our submission, Merkle root, segment proofs and encrypted bytes
// (core/merkle.ts) against the SDK's, across file sizes — plain and
// AES-256 encrypted. Offline: no network, no wallet.
//
//   node scripts/test-merkle.mjs
import { MemData, Blob as ZgBlob, EncryptedFile, newSymmetricHeader } from '@0gfoundation/0g-storage-ts-sdk'
import { SegmentTree, hashSegments, numPaddedSegments, readStream, segmentData, streamSize, submissionNodes } from '../core/dist/merkle.js'

const KB = 1024, MB = 1024 * KB
const sizes = [1, 15, 100, 239, 255, 256, 257, 1000, 4096, 4097, 65_536, 256 * KB - 17, 256 * KB, 256 * KB + 1,
  300_001, MB - 17, MB, MB + 5, 3_300_000, 4 * MB + 239, 9 * MB + 123, 17 * MB, 33 * MB + 7]
let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  if (!ok || process.env.VERBOSE) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const t0 = performance.now()
for (const size of sizes) {
  const data = new Uint8Array(size)
  for (let i = 0; i < size; i += 65536) crypto.getRandomValues(data.subarray(i, Math.min(i + 65536, size)))
  for (const encrypted of [false, true]) {
    const key = crypto.getRandomValues(new Uint8Array(32))
    const header = newSymmetricHeader()
    // the browser hands us a Blob; Node tests both kinds of source
    const blob = new Blob([data])
    const src = encrypted ? { data: blob, enc: { key, header: header.toBytes() } } : { data }
    const sdk = encrypted ? new EncryptedFile(new ZgBlob(blob), key, header) : new MemData(data)
    const label = `${size} B${encrypted ? ' encrypted' : ''}`

    const n = numPaddedSegments(streamSize(src))
    // two ranges, as two workers would
    const half = Math.floor(n / 2)
    const roots = new Uint8Array(n * 32)
    roots.set(await hashSegments(src, 0, half), 0)
    roots.set(await hashSegments(src, half, n), half * 32)
    const tree = await SegmentTree.build(roots)
    const nodes = await submissionNodes(src, tree)

    const [sdkTree] = await sdk.merkleTree()
    const [sub] = await sdk.createSubmission('0x', '0x0000000000000000000000000000000000000000')
    check(`${label}: root`, tree.root === sdkTree.rootHash(), `${tree.root} vs ${sdkTree.rootHash()}`)
    check(`${label}: size`, streamSize(src) === sdk.size())
    const sdkNodes = sub.data.nodes.map((x) => `${x.height}:${x.root}`).join(',')
    check(`${label}: submission nodes`, nodes.map((x) => `${x.height}:${x.root}`).join(',') === sdkNodes, sdkNodes.slice(0, 120))
    for (const i of new Set([0, 1, n - 2, n - 1, Math.floor(n / 3)].filter((i) => i >= 0 && i < n))) {
      const ours = tree.proof(i)
      const theirs = sdkTree.proofAt(i)
      check(`${label}: proof ${i}/${n}`, JSON.stringify(ours) === JSON.stringify({ lemma: theirs.lemma, path: theirs.path }))
    }
    // the bytes sent for the last data segment, as the SDK's getSegment
    const last = Math.floor((sdk.numChunks() - 1) / 1024)
    const mine = await segmentData(src, last)
    const iter = sdk.iterateWithOffsetAndBatch(last * 256 * KB, 256 * KB, true)
    await iter.next()
    let theirs = iter.current()
    theirs = theirs.slice(0, Math.min(theirs.length, 256 * (sdk.numChunks() - last * 1024)))
    check(`${label}: last segment bytes`, Buffer.compare(Buffer.from(mine), Buffer.from(theirs)) === 0, `${mine.length} vs ${theirs.length}`)
    check(`${label}: nothing past the data`, (await segmentData(src, last + 1)) === null)
    if (size <= 4 * MB) {
      const all = await readStream(src, 0, streamSize(src))
      const sdkAll = (await sdk.readFromFile(0, sdk.size())).buffer
      check(`${label}: stored bytes`, Buffer.compare(Buffer.from(all), Buffer.from(sdkAll)) === 0)
    }
  }
}
console.log(`${failed === 0 ? 'all match' : `${failed} mismatches`}: ${sizes.length} sizes × plain/encrypted (${((performance.now() - t0) / 1000).toFixed(0)} s)`)
process.exit(failed ? 1 : 0)
