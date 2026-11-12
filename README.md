# 0GDrive

A private, encrypted file drive that runs in your browser and stores everything on [0G Storage](https://docs.0g.ai), a decentralized storage network. Your wallet is your account. Files are encrypted on your device before upload, and no 0GDrive server stores, sees or controls your data.

You get the usual drive features: folders, drag-and-drop upload, preview, download, share links and trash. Built-in AI helps you find and organize files without exposing them.

**Try it:** <https://drive-staging.0g.ai> (0G Galileo testnet). The production address will be `drive.0g.ai`.

## Why 0GDrive

### Your files are only yours
- **No company in the middle.** Files live on 0G's decentralized storage network, not on a provider's servers. There is no account to suspend, no subscription that locks your data, and no operator who can delete or read it.
- **Your wallet is your login.** There is no sign-up and no password database. Your wallet sets up your drive and funds its storage; after that, using the drive needs no wallet prompt.
- **No backend.** The app finds and rebuilds your whole drive from public data (your wallet's storage deposits on chain, your drive's files on 0G Storage) plus your keys, so it keeps working even if this website disappears. Any copy of the app can open your drive. Files go through 0G Storage V2's public relayer, which only ever sees ciphertext.
- **Recovery you control.** Your drive key is kept with your drive on 0G Storage, locked to your wallet. An optional recovery password opens the drive (read-only) if you lose the wallet. Nobody, including us, can reset it or open it for you.

### Encrypted everywhere outside your device
- **Every file is encrypted in your browser** with its own AES-256 key before it is uploaded. Storage nodes and the chain only ever hold ciphertext.
- **Names and structure are encrypted too.** File names, folder names, the folder tree, trash and search indexes are stored as encrypted listing files, not as readable metadata.
- **Sharing doesn't break this.** A secret link carries a single file's key in the part of the URL that browsers never send to a server. An "encrypted to recipient" link can be opened only by the recipient's wallet. Creating a link sends nothing on-chain.
- **What is public:** that your wallet funded a storage account, and when and how much that account stores. File contents, names and folder layout are not public.

### AI that helps without seeing what it shouldn't
- **On-device AI works on your plaintext, locally.** Smart search (by meaning, in any language, including photo content) and "Suggest organization" run inside your browser. Your files and queries never leave your device.
- **The cloud assistant is walled off from your files.** The help assistant uses a stronger remote model (GLM-5.3 in a secure enclave via 0G Private Computer). It runs in a sandboxed frame on a separate origin. It cannot read your files, file names, keys or wallet address. It sees only on/off facts such as "recovery is on", and it can point at controls on the page but never click them.
- **You pay for the assistant directly**, with your own 0G Private Computer API key (a few US cents per question). No middleman stores your questions.

## Features

| Area | What you can do |
|---|---|
| Files | Drag-and-drop upload with no wallet prompt, folders, rename and move files and folders, list/grid view with photo, video and SVG thumbnails, trash and restore, sync across devices |
| Preview | Images, PDF, text and code, audio and video, decrypted in the browser |
| Sharing | Secret links for anyone; wallet-locked links for a specific recipient |
| Security | Key backup locked to your wallet (or to a password, for wallets whose signatures change), recovery password, offline key file, share key for receiving locked links |
| Storage | A storage balance you top up from your wallet pays rent for your files; delete forever stops it. Every change appears all at once or not at all |
| AI | On-device semantic search and organization; isolated help assistant that cites its sources |
| Mobile | Every screen adapts to phone width |

See the [user guide](docs/user-guide.md) for how each feature works and what it costs.

## Status

Version 0.1, running on the **0G Galileo testnet** with **0G Storage V2**. Storage, folders, sharing, recovery, on-device AI and the assistant are built and covered by end-to-end tests on testnet. Drives from before V2 don't open in this version. Mainnet support and app packaging are next. See the roadmap in [`docs/decisions.md`](docs/decisions.md).

## Project layout

- `core/`: shared TypeScript library. Covers the 0G Storage V2 relayer client (signed uploads, resumable parts and downloads, deposits), the V2 drive backend (listings and roots), the account card (finding a drive from a wallet), encryption, drive-key custody and recovery, sharing, and the drive metadata model (`DriveStore`). It keeps V1 storage download for the on-device AI model.
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

Then open <http://localhost:5173> in a browser with a wallet extension installed (MetaMask, Rabby or any other Ethereum wallet), or connect a phone wallet with WalletConnect (set `VITE_WALLETCONNECT_PROJECT_ID` in `web/.env.local`, from dashboard.reown.com). You'll need testnet 0G to upload: get some at <https://faucet.0g.ai> (0.1 0G per day per wallet).

### Scripts

| Script | What it does |
|---|---|
| `npm run net-check` | read-only indexer and node connectivity probe |
| `npm run smoke` | strict E2E: 1 MB upload → finality → download → decrypt → verify, with a cost report |
| `npm run roundtrip` | fast E2E roundtrip (same flow, 256 KB) |
| `npm run test:e2e` | the full drive UI in a real browser |
| `npm run test:share-wallet` | wallet-locked share links |
| `npm run test:password` | recovery password and read-only open without the wallet |
| `npm run test:wallets` | wallet picker with several wallets installed, switching accounts, disconnect and quiet reconnect, keeping connections warm, and the signature check (spends nothing) |
| `npm run test:svg` | SVG thumbnails, including that an SVG's scripts and external images never load |
| `npm run test:welcome` | the welcome panel shown before a wallet is connected (spends nothing) |
| `npm run test:rename` | file rename: name checks, duplicates refused, no wallet prompt, phone layout; file actions icon-only |
| `npm run test:folder-rename` | folder rename: name checks, no wallet prompt, open folder follows, subfolder kept, phone layout |
| `npm run test:move` | "Move to…" picker for folders and files: greyed-out places, name clashes refused, new destination folder, no wallet prompt, phone layout; grid "Select all" |
| `node scripts/test-duplicate-names.mjs` | uploading a name already in the folder: asked first with an editable name per file ("name (1)" suggested; taken, empty, "/" and repeated names refused), Replace (old to trash, one transaction) / Skip / Cancel; restore into a taken name; phone layout |
| `node scripts/test-open-in-wallet.mjs` | phones with no wallet: links that open the drive in MetaMask, Trust, OKX or Coinbase Wallet's browser, at 390 px; desktop unchanged (spends nothing) |
| `node scripts/test-walletconnect.mjs` | WalletConnect with a scripted wallet over the real relay: QR code on a laptop, wallet-app links on a phone (390 px), drive setup (3 signatures and the deposit) approved in the wallet, reconnect after reload (laptop and phone) with the wallet app in the background, no reads sent to the wallet though it lists them (as MetaMask does), a wallet that approves another chain first (like MetaMask), a declined connection shown on the start page, no link back to the app (it opened a new tab), WalletConnect stuck (relay silent): an error within 20 s, `?debug=wc` log, "Start a new connection" clears its saved data, same drive from a browser wallet, disconnect ends the session, no analytics (needs `VITE_WALLETCONNECT_PROJECT_ID`; spends a little) |
| `node scripts/test-file-icons.mjs` | file-type icons: extension and type → family, the extension strip fits, a colour per family (offline, spends nothing) |
| `node scripts/test-model-error.mjs` | smart search models that fail to load say why on the page and in Activity (memory / storage / download / WebAssembly), not only in a tooltip |
| `uv run --with onnx==1.17.0 --with numpy python scripts/models/prune-text-model.py ORIG OUT` | trim the search text model to English + Chinese tokens (see docs/decisions.md) |
| `node scripts/models/check-pruned-model.mjs DIR` | the trimmed model gives the same tokens and embeddings for English and Chinese text as the full one |
| `[NETWORK=mainnet] node scripts/models/upload-model-to-0g.mjs DIR` | upload the trimmed model to 0G Storage; prints the pins for `web/src/ai/modelOn0g.ts` |
| `node scripts/test-merkle.mjs` | our upload hashing against the SDK's: roots, submissions, segment proofs and encrypted bytes, 23 sizes plain and encrypted (offline, spends nothing) |
| `npm run test:browser-ai` / `test:search` | on-device AI search and organize |
| `npm run test:ai-memory` | the AI engine’s memory reservation stays at 1 GB, and models load in a tab that has no room for 4 GB |
| `npm run test:pdf-preview` | PDF preview on phones: pages drawn and released as you scroll; desktop keeps the browser’s viewer |
| `npm run test:bg-index` | background indexing: files without search entries indexed on the device, saved with the next change or Save |
| `npm run test:html-preview` | HTML preview: the page shown sandboxed (no scripts, nothing loaded from the internet), or its source |
| `node scripts/test-ai-loading.mjs` | AI model loading: off on phones (asks before turning on), text model first, photo models on the first photo |
| `npm run test:assistant` | assistant in the browser: isolation, real questions, privacy, phone layout (needs `ZG_ROUTER_API_KEY` in `.env`; about 0.5 0G) |
| `npm run test:assistant-key` | the assistant's API key survives a browser restart in WebKit (iPhone) and Chromium; a refused question doesn't forget it (Router mocked; no cost) |
| `npm run test:v2-vectors` | the V2 relayer client's data hash and signed statements against the V2 SDK's published test vectors (offline) |
| `npm run test:v2-relayer [MiB]` | proof of concept: upload (dropped connections, skewed clock), dedup, find the root by listing, resumed download and delete through the V2 testnet relayer, from WebKit at phone size and Chromium (first run deposits 0.05 testnet 0G) |
| `npm run test:v2-drive` | the drive on V2: DriveStore with the V2 backend against the testnet relayer — folders, uploads, rename, move, trash, a restart, two devices at once, a wrong drive key, superseded versions deleted (deposits 0.05 testnet 0G into a fresh storage account, deletes its files at the end) |
| `npm run test:v2-account` | a wallet's V2 drive found from the wallet alone: setup (recovery and binding signatures, one deposit), a new device unlocking by signature or password, a password change, the sharing key looked up by someone else, an impostor card skipped, the drive found from its key alone and its card under 510 newer files, a shared file read with no account, a purged file deleted (a fresh wallet funded with 1 testnet 0G for gas, refunded; deposits 2 × 0.02 0G) |
| `npm run test:v2-app [url]` | the app on V2 in Chromium: create the drive (3 signatures, 1 deposit), a folder and uploads with no wallet prompt, preview, a share link read with no account, a recovery password, a deposit, a second device restoring with one signature, a device holding the key opening the drive when the deposit scan sees nothing, the drive opened read-only by password with no wallet, delete forever, and the setup and storage UI at 390 px (a fresh wallet funded with 2 testnet 0G for gas, refunded; the drive's files deleted at the end) |
| `npm run test:password-only [url]` | password-only setup for a wallet whose signatures change: setup stops at the stability check and offers a recovery password; 1 signature and 1 deposit then; the card has the password wrap only and no share key; the key file offered at once; a second device restores by password with no wallet prompt, a wrong one refused (a fresh wallet funded with 2 testnet 0G for gas, refunded; the drive's files deleted at the end) |
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

- **Storage.** Files are stored on 0G Storage V2 through its relayer. Each drive has its own storage account, derived from the drive key, which signs uploads and deletes in the browser (EIP-712) and pays rent from a balance in the PaymentVault contract that your wallet tops up.
- **Keys.** Each file has a random AES-256 key, locked under your drive key. The drive key is locked under a key derived from a fixed wallet signature, and optionally also under your password (PBKDF2, 600k rounds); both locked copies sit in the drive's public card. Share keys are derived from the same signature.
- **Metadata.** Folders, file records, trash and search indexes live in small encrypted listing files. A root file names the current listings; each change stores new listings and then a new root, so it appears all at once.
- **Discovery is serverless.** The PaymentVault's deposit events name the storage accounts a wallet funded; an account's newest root carries a card signed by the wallet, which identifies the drive and holds the locked drive key.
- **Cost on testnet.** Setup is a 0.1 0G first deposit plus its network fee (about 0.1 0G). Storage rent is about 38.9 0G per TB per month, paid from the storage balance; changes cost no transaction.

See [`docs/decisions.md`](docs/decisions.md) for the full architecture and roadmap.

## License

[Apache License 2.0](LICENSE)
