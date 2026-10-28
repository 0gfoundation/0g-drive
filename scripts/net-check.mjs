// Read-only 0G network connectivity check — no wallet or funds needed.
// Usage: npm run net-check
import { Indexer, StorageNode } from '@0gfoundation/0g-storage-ts-sdk'

const ENDPOINTS = [
  ['testnet:turbo', 'https://indexer-storage-testnet-turbo.0g.ai'],
  ['testnet:standard', 'https://indexer-storage-testnet-standard.0g.ai'],
  ['mainnet:turbo', 'https://indexer-storage-turbo.0g.ai'],
  ['mainnet:standard', 'https://indexer-storage.0g.ai'],
]

let failures = 0
for (const [name, url] of ENDPOINTS) {
  try {
    const indexer = new Indexer(url)
    const nodes = await indexer.getShardedNodes()
    const trusted = nodes.trusted ?? []
    const discovered = nodes.discovered ?? []
    console.log(
      `✓ ${name} — ${trusted.length} trusted, ${discovered.length} discovered nodes`
    )
    if (trusted.length > 0) {
      const node = new StorageNode(trusted[0].url)
      const status = await node.getStatus()
      console.log(
        `  sample node ${trusted[0].url} — chainId ${status.networkIdentity?.chainId}, flow ${status.networkIdentity?.flowAddress}, nextTxSeq ${status.nextTxSeq}`
      )
    }
  } catch (err) {
    failures++
    console.error(`✗ ${name} — ${err.message}`)
  }
}
process.exit(failures > 0 ? 1 : 0)
