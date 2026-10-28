# 0GDrive

OneDrive-style personal drive on [0G Storage](https://docs.0g.ai) — folders, uploads, downloads, and sharing with wallet-based identity and client-side encryption.

## Status

**M1 ✅ / M2 in verification** — encrypted uploads/downloads with strict bounded finality proven on testnet; drive semantics (folders, trash, rename) on manifest files, E2E test running.

- `core/` — shared TypeScript package: uploads/downloads (progress + bounded finality + auto-repair), encryption, drive key custody, on-chain event scanning, manifest-based drive metadata (`DriveStore`)
- `web/` — React + Vite app: wallet connect, drive key setup, folder navigation, drag-drop encrypted upload, trash/restore
- `assistant/` — the help assistant (own origin, embedded as an isolated iframe; GLM-5.3 on 0G Private Computer with the user's API key) — see D9 in `docs/decisions.md`
- `docs/` — [0G Storage API study](docs/0g-storage-api-study.md) · [architecture decisions](docs/decisions.md) · [user guide](docs/user-guide.md)
- `reference/` — clones of the 0G SDK and starter kit (gitignored, for reading only)

## Getting started

```bash
npm install
npm run net-check        # verify 0G indexer endpoints are reachable (no wallet needed)
npm run dev              # build core + start the web app (:5173) and the assistant (:3000)
```

Get testnet funds at <https://faucet.0g.ai> (0.1 0G/day per wallet).

### Scripts

| Script | What it does |
|---|---|
| `npm run net-check` | read-only indexer/node connectivity probe |
| `npm run smoke` | strict E2E: 1 MB ECIES upload → finality → download → decrypt → verify + cost report |
| `node scripts/verify-roundtrip.mjs` | fast E2E roundtrip (same flow, 256 KB) |
| `node scripts/test-drive.mjs` | drive semantics E2E: folders, files, trash, rename, restart-recovery |
| `node scripts/gen-test-wallet.mjs` | create a throwaway test wallet in `.env` |
| `npm run knowledge` | rebuild the assistant's knowledge bundle (guide, docs, source, docs.0g.ai, 0G repos) |
| `npm run test:assistant` | assistant E2E in the browser — isolation, real questions, privacy, phone layout (needs `ZG_ROUTER_API_KEY` in `.env`; ~0.5 0G) |

All test scripts read `PRIVATE_KEY` from the environment or the gitignored `.env`.

## How it works

- **Files** are stored on 0G Storage as content-addressed, Merkle-rooted blobs; uploads pay an on-chain storage fee via the Flow contract. Core enforces strict finality itself (15-min bounded wait, auto-repair of missing segments) rather than trusting the SDK's unbounded loop.
- **Encryption** is client-side. The web shell uses a per-account AES-256 drive master key (generated in-browser, must be backed up — injected wallets cannot decrypt ECIES since they never expose the raw private key). Node/desktop flows use ECIES to the wallet key.
- **Drive metadata** (folders, file records, trash) lives in small encrypted JSON manifests uploaded as tagged 0G files. Discovery is serverless: the Flow contract's `Submit` events carry the sender, the file root hash, and the upload tags — so a fresh client reconstructs the whole drive from a public RPC + downloads, no backend.
- **Cost** observed on testnet: ~0.0012 0G per ~MB file roundtrip; each metadata op is one small tx (~0.0001 0G).

See `docs/decisions.md` for the full architecture and roadmap.
