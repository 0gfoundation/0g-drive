# 0G Storage API Study

*Sources: docs.0g.ai (Storage SDK page, network overviews), 0gfoundation/0g-storage-ts-sdk source (v1.2.12), 0g-storage-ts-starter-kit. Reference clones in `reference/`.*

## 1. Mental model

0G Storage is a **decentralized, content-addressed blob store** — think S3 without a bucket concept, not a filesystem.

- A file is split into **segments** of 256 KB (1024 chunks × 256 B), and a Merkle tree is built over the chunks. The **Merkle root hash IS the file ID**. Same bytes → same root hash (built-in dedup).
- **Upload flow** (all orchestrated by the SDK):
  1. Build Merkle tree client-side (`file.merkleTree()`).
  2. Submit a "log entry" on 0G Chain via the **Flow contract** (`FixedPriceFlow.submit`) — this pays the storage fee (price read on-chain from the linked FixedPrice market contract, `pricePerSector × sectors`) and returns a `txSeq`.
  3. Upload segments (with Merkle proofs) to storage nodes via JSON-RPC (`zgs_uploadSegmentsByTxSeq`).
  4. Wait for finality (nodes confirm they store the full file).
- **Download flow**: ask the indexer which nodes hold the root hash (`indexer_getFileLocations`) → pick a covering shard set → fetch segments (`zgs_downloadSegment`) → reassemble. Optional Merkle-proof verification.
- **Append-only**: no update, no delete. Data is stored permanently (fees pay for ongoing storage). "Delete" is purely a metadata-layer concept.
- **Two storage networks**: **Turbo** (fast, higher fee) and **Standard** (cheap, slower), each with its own indexer. The Flow contract address is auto-discovered from a storage node's `zgs_getStatus` (`networkIdentity.flowAddress`).

### Constants worth knowing
| Constant | Value |
|---|---|
| Chunk size | 256 B |
| Segment size | 256 KB (1024 chunks) |
| Small-file threshold | 256 KB (padded to one segment) |
| Fragment size (default) | 4 GB — larger files auto-split into fragments, each with its own root hash |
| KV batch limits | 64 K entries per tx, 16.7 MB per key, 256 KB per read chunk |

## 2. Networks & endpoints

| | Galileo Testnet | Mainnet |
|---|---|---|
| Chain ID | 16602 | 16661 |
| RPC | `https://evmrpc-testnet.0g.ai` | `https://evmrpc.0g.ai` |
| Indexer (Turbo) | `https://indexer-storage-testnet-turbo.0g.ai` | `https://indexer-storage-turbo.0g.ai` |
| Indexer (Standard) | `https://indexer-storage-testnet-standard.0g.ai` | `https://indexer-storage.0g.ai` |
| Flow contract | `0x22E03a6A89B950F1c82ec5e74F8eCa321a105296` | `0x62D4144dB0F0a6fBBaeb6296c785C71B3D57C526` |
| Explorer | `chainscan-galileo.0g.ai` / `storagescan-galileo.0g.ai` | `chainscan.0g.ai` |
| Faucet | faucet.0g.ai (0.1 0G/day) | — |

## 3. TS SDK surface (`@0gfoundation/0g-storage-ts-sdk`, peer dep `ethers@6.13.1`)

> The starter kit installs the same SDK under the alias `@0gfoundation/0g-ts-sdk`. Browser import: `@0gfoundation/0g-storage-ts-sdk/browser`.

### `Indexer(url)` — the main entry point
```ts
const indexer = new Indexer(INDEXER_RPC)

// Discovery
indexer.getShardedNodes()          // → { trusted: ShardedNode[], discovered: [] }
indexer.getNodeLocations()
indexer.getFileLocations(rootHash) // → ShardedNode[] holding the file

// Upload (returns single result or fragment arrays for >4GB files)
const [tx, err] = await indexer.upload(file, RPC_URL, signer, uploadOpts?)
//   → { txHash, rootHash, txSeq } | { txHashes[], rootHashes[], txSeqs[] }

// Download
await indexer.download(rootHashOrRootHashes, filePath, withProof)   // Node.js only (fs)
const [blob, err] = await indexer.downloadToBlob(rootHashOrRootHashes, {
  proof: true,
  decryption: { symmetricKey } | { privateKey },  // best-effort decrypt
})                                                                  // browser-safe

const [header, err] = await indexer.peekHeader(rootHash)  // detect encryption w/o full download
```

### File abstractions
- `ZgFile.fromFilePath(path)` — Node.js
- `Blob` (aliased `ZgBlob`) — browser `File` objects
- `MemData(Uint8Array)` — in-memory bytes
- All: must call `.merkleTree()` before upload, `.close()` after. Upload options include `onProgress(msg)` callback (important for UX — uploads take seconds-to-minutes).

### `UploadOption` (key fields)
| Field | Default | Notes |
|---|---|---|
| `finalityRequired` | `true` | wait until nodes confirm storage |
| `expectedReplica` | `1` | number of full replicas |
| `fragmentSize` | 4 GB | auto-split larger files |
| `skipIfFinalized` | `true` | **free dedup** — already-stored content costs nothing |
| `fee` | auto | else `pricePerSector × sectors` from market contract |
| `tags`, `submitter`, `nonce`, `taskSize` | — | advanced |
| `encryption` | — | `{type:'aes256', key}` or `{type:'ecies', recipientPubKey}` |

### `StorageNode(url)` — raw node JSON-RPC
`zgs_getStatus`, `zgs_uploadSegment(s)(ByTxSeq)`, `zgs_downloadSegment(WithProof)(ByTxSeq)`, `zgs_getFileInfo(root, needAvailable)`, `zgs_getFileInfoByTxSeq`, `zgs_getShardConfig`, `zgs_getSectorProof`.
`FileInfo = { tx: { seq, size, dataMerkleRoot, ... }, finalized, isCached, uploadedSegNum }` — useful for status polling ("is my upload finalized yet?").

### Encryption (client-side, v1.2.6+)
- `aes256`: 32-byte symmetric key, 17-byte header. You manage the key — no recovery.
- `ecies`: encrypt to any secp256k1 pubkey (your wallet key works), 50-byte header. Enables user-to-user sharing.
- Network never sees plaintext. Wrong key does NOT throw — `downloadToBlob` silently returns ciphertext; use `peekHeader` first.
- `indexer.download()` (fs version) does not decrypt — always use `downloadToBlob` for encrypted files. Multi-fragment encrypted files decrypt correctly via the array form.

### KV layer (0G-KV) — permissioned, versioned key-value store
**Writes** — batched into a single tagged file upload:
```ts
const [nodes, err] = await indexer.selectNodes(1)
const batcher = new Batcher(1, nodes, flowContract, RPC_URL)
batcher.streamDataBuilder.set(streamId, keyBytes, valueBytes)  // up to 64K per batch
const [tx, err] = await batcher.exec()
```
**Reads** — from a KV node (`KvClient(kvNodeRpc)`, e.g. `http://…:6789`):
- `getValue(streamId, key)` (auto-assembles >256 KB values), `getNextWithValue` (cursor iteration), `getFirst/getLast`, versioned reads (`version` param = MVCC snapshot).
- Permission queries: `hasWritePermission(account, streamId, key)`, `isAdmin`, `isWriterOfKey`, `isWriterOfStream`.
- `streamId` = 32-byte stream identifier; access control (admins/writers) is enforced by special in-stream keys. Tags on the underlying upload encode touched streamIds (`sha256('STREAM')` domain).

### Hot data service (optional, paid)
`HotRouterClient` + `Indexer.uploadToHot()`: prefetch a root hash into a hot node for fast retrieval; downloads go through a router that issues EIP-712-signed billing tickets. Best-effort caching.

## 4. What 0G does NOT give you (the OneDrive gap)

1. **No listing.** Blobs are addressed only by root hash. There is no "list my files" API — `Submit` events on the Flow contract (`Submit(sender, identity, submissionIndex, startPos, length, submission)`) can reconstruct *what* an address stored (root hashes + sizes), but never names, paths, or mime types.
2. **No directories** — any tree structure is app-level metadata.
3. **No update/delete** — immutability means versioning and trash are metadata ops.
4. **No per-file ACLs on plain blobs** — anyone with a root hash can download plaintext. Privacy requires client-side encryption (SDK supports it); sharing requires key distribution.
5. **Latency & cost per write** — every upload is an on-chain tx + storage fee. A metadata write via KV is also an upload. This rules out chatty autosave-style designs.

## 5. 0GDrive architecture (proposal)

**Identity & accounts**: wallet-based (MetaMask / BrowserProvider). User address = drive owner. No passwords, no backend account table.

**Two-layer storage design**:
- **Blob layer** (0G Storage): file bytes, optional per-file encryption. `Indexer.upload/downloadToBlob`. >4 GB files auto-fragment; store `rootHashes[]` in metadata.
- **Metadata layer** (0G-KV): the drive namespace, one stream per user (`streamId` derived from user address). Entries (JSON values, keyed):
  - `file:<rootHash>` → `{ name, path, size, mime, createdAt, modifiedAt, rootHashes, encryption: 'none'|'aes256'|'ecies', version }`
  - `dir:<path>` → `{ createdAt }` (folder existence + cheap listing by prefix iteration via `getNextWithValue`)
  - `share:<id>` → `{ rootHash, recipient, grantedBy, keyWrapped }`
  - Trash = `trash:<rootHash>` entries; delete = move entry, blobs are immutable.
- KV writes are batched (one tx per user action batch, not per field).

**Key derivation/sharing**:
- Private files: `ecies` encrypted to the owner's wallet pubkey — decryption is just wallet-key possession.
- Sharing: re-encrypt the file's AES key to the recipient's pubkey (`ecies` on a small key blob in KV), or unencrypted "public link" shares (root hash in URL).

**App shape**: React + Vite web app, `vite-plugin-node-polyfills` (SDK imports `fs`/`crypto`; `/browser` build avoids it), wallet connect, upload progress UI (`onProgress` + `zgs_getFileInfo` polling), folder tree UI reading the KV stream.

**Network**: start on Galileo testnet (faucet-funded), Turbo indexer for responsiveness; config-switchable to mainnet/standard.

**Optional backend** (later, for performance not correctness): a read-cache of each user's KV stream to avoid cursor-walking on page load; hot-storage prefetch for frequently opened files.

### Cost characteristics
- Storage fee is per sector (64 KB), price on-chain (`pricePerSector`), fixed and transparent; dedup makes re-uploads of identical content free.
- Every KV metadata batch and every file = 1 on-chain tx (gas) + fee.
- Gas on 0G Chain is cheap, but design for *batched* mutations.

## 6. Gotchas list (from source reading)

- SDK `console.log`s verbosely on every operation (no logger injection) — expect noisy browser console.
- `indexer.download()` uses `fs.appendFileSync` — browser must use `downloadToBlob` or manual `StorageNode.downloadSegmentByTxSeq` reassembly (starter kit `web/src/storage.ts` has a working implementation).
- `downloadToBlob` buffers the whole file in memory — fine for docs, bad for 10 GB videos; streaming download needs the segment API directly.
- Wrong decryption key returns ciphertext silently — always `peekHeader` first.
- `selectNodes` requires a *complete shard covering set*; with `expectedReplica: 1` the trusted set usually suffices.
- `TIMEOUT_MS` in the SDK is 3,000,000 ms (50 min) — long uploads are expected.
- KV read chunking is 256 KB (`MAX_QUERY_SIZE`) — `KvClient.getValue`/`getNextWithValue` handle assembly, raw `StorageKv` calls don't.
- Starter kit aliases the SDK as `@0gfoundation/0g-ts-sdk`; npm's canonical name is `@0gfoundation/0g-storage-ts-sdk`.
