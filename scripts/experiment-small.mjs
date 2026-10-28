// Controlled experiment: why do tiny manifest files vanish from testnet nodes?
// Uploads three files and reports FileInfo/download status for each:
//   A) ~200B, tagged (exactly like a manifest)
//   B) ~200B, untagged
//   C) 300KB padded, tagged
// Usage: node scripts/experiment-small.mjs [--check]   (--check re-probes without uploading)
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getNetworkConfig,
  uploadData,
  getFileInfo,
  MANIFEST_DOMAIN,
  folderTag,
} from '../core/dist/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const privateKey = /^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(
  readFileSync(resolve(root, '.env'), 'utf8')
)?.[1]
const network = getNetworkConfig('testnet', 'turbo')
const provider = new ethers.JsonRpcProvider(network.rpcUrl)
const wallet = new ethers.Wallet(privateKey, provider)
const masterKey = new Uint8Array(32)
crypto.getRandomValues(masterKey)

const STATE = resolve(root, 'scripts', '.experiment-state.json')

if (process.argv.includes('--check')) {
  const state = JSON.parse(readFileSync(STATE, 'utf8'))
  for (const [label, rootHash] of Object.entries(state)) {
    const info = await getFileInfo(rootHash, network)
    console.log(
      `${label.padEnd(14)} ${rootHash.slice(0, 18)}… → ${
        info ? `finalized=${info.finalized} segs=${info.uploadedSegNum}` : 'NULL (no record)'
      }`
    )
  }
  process.exit(0)
}

const files = {
  'A tiny+tag': {
    data: new TextEncoder().encode(JSON.stringify({ test: 'a'.repeat(150) })),
    tags: folderTag('experiment'),
  },
  'B tiny-notag': {
    data: new TextEncoder().encode(JSON.stringify({ test: 'b'.repeat(150) })),
    tags: undefined,
  },
  'C 300KB+tag': {
    data: new Uint8Array(300 * 1024), // zeros + marker
    tags: folderTag('experiment'),
  },
}
files['C 300KB+tag'].data.set(new TextEncoder().encode('PADDING-EXPERIMENT-'))

const state = {}
for (const [label, { data, tags }] of Object.entries(files)) {
  console.log(`uploading ${label} (${data.length}B)…`)
  const result = await uploadData(data, network, wallet, {
    encryption: { type: 'aes256', key: masterKey },
    tags,
    finalityRequired: false, // speed: we're testing persistence, not sealing
    onProgress: (msg) => {
      if (msg.includes('Log entry') || msg.includes('Segment')) console.log(`   ${msg}`)
    },
  })
  state[label] = result.rootHash
  console.log(`  root ${result.rootHash}`)
}
const { writeFileSync } = await import('node:fs')
writeFileSync(STATE, JSON.stringify(state, null, 2))
console.log('\nstate saved — re-run with --check after a few minutes')
