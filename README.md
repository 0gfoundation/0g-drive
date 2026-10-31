# 0GDrive

A private, encrypted file drive that runs in your browser and stores everything on [0G Storage](https://docs.0g.ai), a decentralized storage network. Your wallet is your account. Files are encrypted on your device before upload, and no 0GDrive server stores, sees or controls your data.

You get the usual drive features: folders, drag-and-drop upload, preview, download, share links and trash. Built-in AI helps you find and organize files without exposing them.

**Try it:** <https://drive-staging.0g.ai> (0G Galileo testnet). The production address will be `drive.0g.ai`.

## Why 0GDrive

### Your files are only yours
- **No company in the middle.** Files live on 0G's decentralized storage network, not on a provider's servers. There is no account to suspend, no subscription that locks your data, and no operator who can delete or read it.
- **Your wallet is your login.** There is no sign-up and no password database. Only your wallet can change your drive.
- **No backend.** The app rebuilds your whole drive from public chain data plus your keys, so it keeps working even if this website disappears. Any copy of the app can open your drive. The only server-side piece is a stateless relay that passes already-encrypted pieces to storage nodes, because browsers require HTTPS and the nodes speak plain HTTP.
- **Recovery you control.** Your drive key is backed up on-chain and locked to your wallet. An optional recovery password opens the drive (read-only) if you lose the wallet. Nobody, including us, can reset it or open it for you.

### Encrypted everywhere outside your device
- **Every file is encrypted in your browser** with its own AES-256 key before it is uploaded. Storage nodes and the chain only ever hold ciphertext.
- **Names and structure are encrypted too.** File names, folder names, the folder tree, trash and search indexes are stored as encrypted listing files, not as readable metadata.
- **Sharing doesn't break this.** A secret link carries a single file's key in the part of the URL that browsers never send to a server. An "encrypted to recipient" link can be opened only by the recipient's wallet. Creating a link sends nothing on-chain.
- **What is public:** that your wallet uploaded data, and when and how much. File contents, names and folder layout are not public.

### AI that helps without seeing what it shouldn't
- **On-device AI works on your plaintext, locally.** Smart search (by meaning, in any language, including photo content) and "Suggest organization" run inside your browser. Your files and queries never leave your device.
- **The cloud assistant is walled off from your files.** The help assistant uses a stronger remote model (GLM-5.3 in a secure enclave via 0G Private Computer). It runs in a sandboxed frame on a separate origin. It cannot read your files, file names, keys or wallet address. It sees only on/off facts such as "recovery is set up", and it can point at controls on the page but never click them.
- **You pay for the assistant directly**, with your own 0G Private Computer API key (a few US cents per question). No middleman stores your questions.

## Features

| Area | What you can do |
|---|---|
| Files | Drag-and-drop upload (many files, one wallet approval), folders, rename and move files and folders, list/grid view with photo, video and SVG thumbnails, trash and restore, sync across devices |
| Preview | Images, PDF, text and code, audio and video, decrypted in the browser |
| Sharing | Secret links for anyone; wallet-locked links for a specific recipient |
| Security | On-chain key backup, recovery password, offline key file, share key for receiving locked links |
| Reliability | Uploads count as stored only once storage nodes confirm every piece, with automatic repair of missing pieces |
| AI | On-device semantic search and organization; isolated help assistant that cites its sources |
| Mobile | Every screen adapts to phone width |

See the [user guide](docs/user-guide.md) for how each feature works and what it costs.

## Status

Version 0.1, running on the **0G Galileo testnet**. Storage, folders, sharing, recovery, on-device AI and the assistant are built and covered by end-to-end tests on testnet. Mainnet support, storage renewal (0G stores data for about one year per payment) and app packaging are next. See the roadmap in [`docs/decisions.md`](docs/decisions.md).

## Project layout

- `core/`: shared TypeScript library. Covers uploads and downloads (progress, bounded finality, auto-repair), encryption, drive-key custody and recovery, sharing, on-chain event scanning, and manifest-based drive metadata (`DriveStore`).
- `web/`: the drive app (React + Vite).
- `assistant/`: the help assistant, served from its own origin and embedded as an isolated iframe (see D9 in `docs/decisions.md`).
- `docs/`: [user guide](docs/user-guide.md), [architecture decisions](docs/decisions.md), [deployment](docs/deploy.md) and [0G Storage API study](docs/0g-storage-api-study.md).
- `reference/`: clones of the 0G SDK and starter kit (gitignored, for reading only).

## Getting started

```bash
npm install
npm run net-check        # verify 0G indexer endpoints are reachable (no wallet needed)
npm run dev              # build core + start the drive (:5173) and the assistant (:3000)
```

Then open <http://localhost:5173> in a browser with a wallet extension installed (MetaMask, Rabby or any other Ethereum wallet). You'll need testnet 0G to upload: get some at <https://faucet.0g.ai> (0.1 0G per day per wallet).

### Scripts

| Script | What it does |
|---|---|
| `npm run net-check` | read-only indexer and node connectivity probe |
| `npm run smoke` | strict E2E: 1 MB upload → finality → download → decrypt → verify, with a cost report |
| `npm run roundtrip` | fast E2E roundtrip (same flow, 256 KB) |
| `npm run test:drive` | drive semantics: folder tree, files, trash, folder rename, restart recovery, drives from before the folder tree |
| `npm run test:e2e` | the full drive UI in a real browser |
| `npm run test:batch` | one-approval batch uploads |
| `npm run test:share-wallet` | wallet-locked share links |
| `npm run test:password` | recovery password and read-only open without the wallet |
| `npm run test:wallets` | wallet picker with several wallets installed, and the signature check (spends nothing) |
| `npm run test:svg` | SVG thumbnails, including that an SVG's scripts and external images never load |
| `npm run test:welcome` | the welcome panel shown before a wallet is connected (spends nothing) |
| `npm run test:rename` | file rename: name checks, duplicates refused, one transaction, phone layout; file actions icon-only |
| `npm run test:folder-rename` | folder rename: name checks, one transaction, open folder follows, subfolder kept, phone layout |
| `npm run test:move` | "Move to…" picker for folders and files: greyed-out places, name clashes refused, new destination folder, one transaction, phone layout; grid "Select all" |
| `node scripts/time-wallet-prompt.mjs` | Time from a drive action to its wallet prompt, request by request (testnet, throwaway wallet) |
| `npm run test:browser-ai` / `test:search` | on-device AI search and organize |
| `npm run test:assistant` | assistant in the browser: isolation, real questions, privacy, phone layout (needs `ZG_ROUTER_API_KEY` in `.env`; about 0.5 0G) |
| `npm run knowledge` | rebuild the assistant's knowledge bundle (guide, docs, source, docs.0g.ai, 0G repos at the commits in `scripts/knowledge-sources.json`; add `-- --update` to move to their latest) |
| `node scripts/gen-test-wallet.mjs` | create a throwaway test wallet in `.env` |

Test scripts read `PRIVATE_KEY` (and `ZG_ROUTER_API_KEY`) from the gitignored `.env`, fund a throwaway wallet from it, and return what's left at the end. Pass a URL to test a deployed drive instead of the dev server, e.g. `node scripts/test-browser-e2e.mjs https://drive-staging.0g.ai`.

## Run your own copy

Your drive lives on 0G, not on our website, so any copy of the app opens it with the same wallet. To host one:

1. `npm install && npm run build -w @0gdrive/core && npm run build -w web` produces a static site in `web/dist`.
2. **Over https, add the storage-node relay.** Storage nodes speak plain HTTP, which browsers block from https pages, so the app sends node calls to `/_node/<ip>:<port>` on its own site. [`web/api/node.ts`](web/api/node.ts) is that relay: stateless, POST only, storage-node methods only, and only to nodes a 0G indexer lists. It runs as-is as a Vercel function (with the rewrites in [`web/vercel.json`](web/vercel.json)); on other hosts, port it or put an equivalent proxy at `/_node/`. Served over plain http (e.g. on your own machine), the app talks to the nodes directly and needs no relay.
3. Optional: [`web/api/models.ts`](web/api/models.ts) at `/_models/` is a fallback download route for the on-device AI models, used only when the browser can't reach the model CDNs directly.

The help assistant won't work in a self-hosted copy: its AI provider only answers pages on `0g.ai` hostnames. Everything else works without it.

Maintainers: environments, releases and settings for the hosted app are in [docs/deploy.md](docs/deploy.md).

## How it works

- **Storage.** Files are stored on 0G Storage as content-addressed, Merkle-rooted blobs. Each upload pays an on-chain storage fee through the Flow contract. Core enforces strict finality itself (a 15-minute bounded wait, plus auto-repair of missing segments) instead of trusting the SDK's unbounded loop.
- **Keys.** Each file has a random AES-256 key, locked under your drive key. The drive key is backed up on-chain, locked under a key derived from a fixed wallet signature, and optionally also under your password (PBKDF2, 600k rounds). Share keys are derived from the same signature.
- **Metadata.** Folders, file records, trash and search indexes live in small encrypted JSON manifests uploaded as tagged 0G files.
- **Discovery is serverless.** The Flow contract's `Submit` events carry the sender, file root and tags. A fresh client finds the newest manifests from a public RPC, downloads them and decrypts them.
- **Cost on testnet.** About 0.001 0G per MB uploaded. Each metadata change is one small transaction (about 0.0001–0.0015 0G).

See [`docs/decisions.md`](docs/decisions.md) for the full architecture and roadmap.

## License

[Apache License 2.0](LICENSE)
