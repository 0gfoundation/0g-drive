# Deploying 0GDrive

0GDrive has no backend. A deployment is two static sites, plus one small function that relays AI model downloads:

| Site | What it serves | Vercel project (root directory) |
|---|---|---|
| **Drive** | the app (`web/`), plus `/_models/…`, a download relay for on-device AI model files (`web/api/models.ts`) | `0g-drive` (`web`) |
| **Assistant** | the help assistant (`assistant/`) and its knowledge bundle; no server code | `0g-drive-assistant` (`assistant`) |

The assistant is a separate site, not a folder of the drive, for two reasons:

- **Isolation.** The browser keeps pages from different origins apart. Served from another origin, the assistant cannot read the drive's storage (drive key, share key, cached files) or its page. Serving both from one deployment would put each app's files on the other's hostname too, so they are two projects.
- **The 0G Router only answers `https://*.0g.ai` pages** (plus `localhost:3000` and `:5173` for development; checked 2026-10-29). The assistant calls the Router from the browser, so it must be served from a `*.0g.ai` hostname. `vercel.app` addresses are refused.

## Environments

| | Preview | Staging | Production |
|---|---|---|---|
| Deployed from | every pull request | every push to `main` | every push to `release` |
| Drive | `0g-drive-git-<branch>-<team>.vercel.app` | `drive-staging.0g.ai` | `drive.0g.ai` |
| Assistant | the staging assistant | `drive-assistant-staging.0g.ai` | `drive-assistant.0g.ai` |
| Network | Galileo testnet | Galileo testnet | Galileo testnet (mainnet later) |
| Tests | CI build, plus manual click-through | `Staging E2E` workflow: daily drive suites, weekly assistant suite | — |

The assistant project deploys only `main` and `release` (`git.deploymentEnabled` in `assistant/vercel.json`). Assistant changes in a pull request therefore can't be tried on a preview; they appear on staging after merge, and in local dev (`npm run dev`) before that.

**Releasing:** merge `main` into `release` (or fast-forward it) once staging looks right.

## The assistant only works inside the drive

| Layer | Where | Effect |
|---|---|---|
| `frame-ancestors` | `assistant/vercel.json` headers | browsers show the assistant only inside the matching drive: production in `drive.0g.ai`, staging in `drive-staging.0g.ai` and `*.vercel.app` previews, anything else nowhere |
| Redirect on `Sec-Fetch-Dest: document` | `assistant/vercel.json` redirects | opening the assistant's address directly goes to the drive; only requests from an iframe get the page |
| Allowed-parent check | `assistant/src/bridge.ts`, `main.tsx` | the page talks only to a drive origin in `VITE_DRIVE_ORIGINS`, and otherwise shows a link to the drive (covers browsers without `Sec-Fetch-*`) |
| `X-Robots-Tag: noindex` | both `vercel.json` files | keeps the assistant (and non-production drives) out of search engines |

The drive itself sends `frame-ancestors 'none'`, so no other site can frame it and trick users into wallet actions.

## Settings

### Environment variables (Vercel → project → Settings → Environment Variables)

| Project | Variable | Production | Preview (staging and PRs) |
|---|---|---|---|
| drive | `VITE_ASSISTANT_URL` | `https://drive-assistant.0g.ai/` | `https://drive-assistant-staging.0g.ai/` |
| assistant | `VITE_DRIVE_ORIGINS` | `https://drive.0g.ai` | `https://drive-staging.0g.ai,https://0g-drive-*-<team>.vercel.app` |

`*` in `VITE_DRIVE_ORIGINS` matches one hostname part (letters, digits, `-`). These are build-time values: redeploy after changing them.

### One-time setup

1. **Vercel team** (Pro; the Hobby plan is for non-commercial use) connected to the `0gfoundation/0g-drive` GitHub repo.
2. **Two projects** from the same repo: root directory `web` and root directory `assistant`. Keep "Include files outside the root directory" on; the builds run from the repo root (`installCommand` / `buildCommand` in each `vercel.json`).
3. **Production branch** of both projects: `release` (Settings → Environments → Production → Branch Tracking).
4. **Domains:** add `drive.0g.ai` to the drive project and `drive-assistant.0g.ai` to the assistant project. For staging, add `drive-staging.0g.ai` and `drive-assistant-staging.0g.ai` and assign each to the `main` branch (Settings → Domains → Git Branch).
5. **DNS** for `0g.ai`: a CNAME for each of the four names, pointing to the target Vercel shows for that domain.
6. **Environment variables** as in the table above.
7. **GitHub secrets** for the `Staging E2E` workflow (repo → Settings → Secrets and variables → Actions):
   - `TEST_WALLET_KEY`: private key of a testnet-only wallet holding a few testnet 0G. Each suite funds a throwaway wallet from it and returns the rest.
   - `ZG_ROUTER_API_KEY`: a 0G Private Computer key with a small deposit, for the assistant suite (~0.5 0G per run).

The hostnames are set in `assistant/vercel.json`, in `web/vercel.json` (the production host is excluded from `noindex`), in `.github/workflows/staging-e2e.yml`, and in the environment variables above. Change all of them together.

## The model download relay

The on-device AI downloads ~300 MB of model files from Hugging Face and jsDelivr. When the browser's direct download stalls or crawls (some networks reach those CDNs badly), it resumes through the drive's own `/_models/<host>/<path>`. On Vercel that path is rewritten to the `api/models` function, which streams the file from upstream and passes `Range` through. The function:

- accepts only GET requests for the two models' files and ONNX Runtime's `dist/` files, so it isn't a general proxy;
- can run for up to 300 s per request; longer downloads continue in the next request from where they stopped;
- uses Vercel bandwidth only for users whose direct download failed.

`npm run dev` serves the same handler from the Vite dev server.

## The assistant's knowledge bundle

`assistant/public/knowledge.json` is built at deploy time by `scripts/build-knowledge.mjs`. It contains:

- 0GDrive's guide, docs, source and deployment config at the commit being deployed. Citations link to GitHub at that commit.
- All of docs.0g.ai, fetched at build time.
- The 0G storage repos at the commits pinned in `scripts/knowledge-sources.json`, downloaded as GitHub tarballs, so builds make no GitHub API calls and hit no rate limits.

To move the 0G repos to their latest commits, run `npm run knowledge -- --update` and commit the changed `knowledge-sources.json`.
