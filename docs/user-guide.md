# 0GDrive user guide

0GDrive is a personal drive — folders, uploads, previews, sharing, trash — that keeps your files on **0G Storage**, a decentralized storage network, instead of a company's servers. Your wallet is your account: there is no sign-up, no password database and no 0GDrive server holding your files. Everything is **encrypted in your browser before it leaves your device**.

This guide explains how to use each feature and what happens underneath. For the design reasoning see `docs/decisions.md`; for the code, `core/src` (storage, encryption, keys) and `web/src/App.tsx` (the app).

## Getting started

1. **Install a wallet.** 0GDrive needs an Ethereum-style browser wallet extension such as MetaMask, Rabby, OKX Wallet or Coinbase Wallet; a Ledger or Trezor works through one of these. Without one the app shows "No Ethereum wallet detected".
2. **Connect wallet** (top right, or **Get started** on the welcome screen). With more than one wallet installed, choose which one in the "Choose a wallet" list (the last one you used is at the top). Your drive belongs to the account, not to the wallet app: the same account opens it in any of them. The app then switches the wallet to the 0G network it runs on (currently the **0G Galileo testnet**, chain ID 16602); approve the switch if asked.
3. **Get some 0G** for fees. On testnet use the faucet linked in the footer ("Get testnet 0G", https://faucet.0g.ai, 0.1 0G per day). Your balance shows in the header.
4. **Create your drive.** On a new account the banner says "Create your drive." Click **Create my drive**: a random *drive key* is generated in your browser. Nothing is sent on-chain yet.
5. **Set up recovery** (sidebar → Security → Recovery → **Set up**). Two signatures and one transaction back up your drive key on-chain, locked to your wallet, so you can open the drive on any device. Do this right away: until then, the drive key exists only in this browser. You sign the same message twice so the app can check that your wallet always gives the same signature for it; recovery depends on that. If it doesn't (some smart-contract, passkey and social-login wallets), the app says so and turns nothing on: export the key file instead, or use a different wallet.

If the account already has a drive, the start banner says "This account has a drive on-chain." — click **Restore my drive** and sign once. Don't create a second drive on an account that already has one.

## What costs a transaction

Storing data on 0G costs a small fee in 0G (storage fee + gas), paid by a wallet transaction you approve in your wallet. Reading is free.

| Action | Wallet prompts |
|---|---|
| Upload one or many files (one drop) | 1 transaction (all files + the folder listing in one batch) |
| New folder, rename a file or folder, move files or folders, move to trash, restore, remove from trash, organize moves | 1 transaction each, however many files or folders (updates small listing files) |
| Set up recovery | 2 signatures + 1 transaction |
| Set or change the recovery password | 1 signature + 1 transaction |
| Publish / update share key | 2 signatures + 1 transaction |
| Restore a drive on a new device | 1 signature, no transaction |
| Create a share link | nothing — no prompt, nothing on-chain |
| Open a link encrypted to you | 1 signature the first time on a device, no transaction |
| Browse, preview, download, search | nothing |

Observed testnet costs: about 0.001 0G per MB uploaded, about 0.0001–0.0015 0G per metadata change.

## Uploading files

- Drop files on the upload zone ("Drop files here or click to upload"; on phones "Tap to upload files"), or click it to pick files. Files go into the folder you are viewing.
- One drop = **one** wallet approval, however many files.
- The **Uploads** list shows each file's state: *queued → approve in your wallet → uploading → sealing → stored*. "Sealing" means storage nodes are confirming they hold every piece — the app waits for this (up to 15 minutes, repairing missing pieces automatically) so "stored" really means stored.
- You can keep dropping files while an upload runs; they queue and go up next.
- If an upload fails the error says why; keep your local copy and try again.

Every file gets its own random key; the file is encrypted with it before upload, and that key is stored (locked under your drive key) in the folder's listing.

## Folders, trash and sync

- **+ New folder** creates a folder in the current folder (1 transaction). The sidebar shows the folder tree; click a folder to open it, the arrow to expand it.
- **Rename** (pencil icon on a file) changes its name in 1 transaction. The file itself isn't re-uploaded: names live only in your folder's encrypted listing. A name already used in the folder (ignoring upper/lower case), an empty name or one containing “/” is refused. Changing the extension doesn't change how 0GDrive opens the file. With on-device AI on, the file's search data is updated for the new name. Share links you already sent keep showing the old name, and still work.
- **Rename a folder** with the pencil next to it in the folder list on the left (on a phone, open the ☰ menu). It takes 1 transaction however much is inside: nothing is re-uploaded, and its files and subfolders stay where they are. A name another folder beside it already has (ignoring upper/lower case), an empty name or one containing “/” is refused. If you have the folder open, you stay in it under its new name.
- **Move files or folders** with "Move to…": the arrow-folder icon on a file or on a folder in the left list, or "Move to…" when you've selected several files. Pick where they go, or make a new folder right there with "+ New folder in …". It takes 1 transaction, even with a new folder, and nothing is re-uploaded; a moved folder keeps everything inside it. A name already used where you're moving to (ignoring upper/lower case) is refused, and a folder can't go into itself. If you have the moved folder open, you stay in it at its new place.
- **Select files** with their checkboxes; **Select all** (the box at the top of the list, or above the tiles in grid view) picks every file in the folder, and clicking it again clears them. A dash in it means only some are selected.
- **Move to trash** (trash icon on a file, or select several and **Trash selected**). Folders can be moved to trash from the tree.
- **Trash** (sidebar): the restore button (↺) puts a file back where it was; the × button removes its record from the trash.
- Storage on 0G is **immutable**: "deleting" removes the file from your drive's listings, but the encrypted data stays on the network until its storage period ends. Nobody can read it without your keys.
- **⟳ Sync** reloads the drive from the chain — useful after using the drive on another device.
- **List / Grid** toggle switches the file view; photos, videos and SVG images show thumbnails.

## Preview and download

File buttons show icons only; point at one to see its name. Click a file name to preview it (images, PDFs, text and code up to 2 MB, audio, video; files up to 100 MB), or use the download button (↓). Files are downloaded from storage nodes and decrypted in your browser. Previewed files are kept on this device **still encrypted**, so the next preview is instant. Thumbnails made by the browser are kept on this device (unencrypted, never uploaded) for speed; clearing the site's data removes them.

## Sharing

Click the share button on a file. Two kinds of link:

- **Secret link** — anyone with the link can download and decrypt that one file. The file's key rides in the part of the URL after `#`, which browsers never send to a server. Treat the link like the file itself. Works for anyone, no wallet needed.
- **Encrypted to recipient** — enter the recipient's wallet address; click **Wrap & create link**. The file key is locked to the recipient's published **share key**, so only their wallet can open it: they connect the same wallet, sign once ("Unlock with wallet & download"), no transaction. Someone else opening the link is refused before signing.

Creating a link writes nothing on-chain and needs no approval. Links can't be revoked once sent (the file is immutable; the recipient may already have it).

The recipient must have published a share key (it is published automatically by **Set up recovery**). If they have only an old-style key, you'll see a warning: they will need their raw private key to open the link. Files uploaded before per-file keys existed can't be shared (re-upload them).

## Security: recovery, password, share key, key file

The **Security** section of the sidebar shows four rows:

| Row | Meaning | Action |
|---|---|---|
| **Recovery** | Your drive key is backed up on-chain, locked to a wallet signature. On a new device: connect wallet → **Restore my drive** → sign once. | **Set up** (2 signatures + 1 tx) |
| **Password** | A second lock on the same backup, for when you lose the wallet. | **Set** / **Change** |
| **Share key** | The public key others use for "Encrypted to recipient" links to you. | **Publish** / **Update** if missing or outdated |
| **Key file** | A copy of your drive key to keep offline. | **Export** |

### Recovery password

**Set** opens a dialog: type the password twice, at least 12 characters. Use several unrelated words — the locked backup is public, so anyone can try guessing offline, and **nobody can reset it for you**. Setting a new password replaces the old one (the old one stops working). "Set" shows again as "Change" after it's saved.

### Lost your wallet?

On the start screen (no wallet connected): **Lost access to your wallet? → Open your drive with its recovery password**. Enter the drive's wallet address and the recovery password. The drive opens **read-only**: you can browse, preview, download and share files, but not upload or change anything (that needs the wallet). The drive key is kept in memory only — nothing is saved on that device; **Exit** closes it. Export the key file from the sidebar if you want a copy. This works only if a password was set before the wallet was lost.

### Key file

**Export** downloads your drive key. Anyone with this file can read your whole drive — store it offline. To use it: on the start banner, "import an existing 0x… key" (new drive screen) or "advanced: import a key file" (restore screen).

### What if…

- *I lose my wallet, no password, no key file* — the drive cannot be opened. There is no reset: 0GDrive has no server that knows your keys.
- *Someone gets my key file / drive key* — they can read every file uploaded so far, permanently (the encrypted data is public and immutable).
- *I clear my browser data* — connect the wallet and **Restore my drive** (if recovery is set up).

## Search and organize (on-device AI)

Sidebar → **On-device AI → Smart search & organize**. When on, AI models (~300 MB, downloaded once) run **inside your browser** — no file content or query leaves your device.

- **Search your drive — any language**: finds files by meaning, e.g. "猫" finds a cat photo named IMG_0001.jpg, "lease contract" finds a PDF named in Chinese. Matches names, text excerpts and photo content.
- New uploads are indexed automatically. **Index N older files for search** indexes files uploaded before (downloads them, reads them on your device, saves the index: 1 approval).
- **✨ Suggest organization** proposes moving files to better-matching folders; you approve the moves in one transaction, however many folders they go to.
- When off, search matches file names only.

## Assistant (this help panel)

The assistant answers questions about 0GDrive and 0G. It runs in a separate, isolated part of the page: it **cannot see your files, file names, keys, or wallet address** — only on/off facts such as "recovery is set up" — and it never asks for passwords or keys. It uses your own 0G Private Computer API key (create one at https://pc.0g.ai → Dashboard → API Keys), stored only in the assistant's part of this browser; you pay 0G directly per question — usually 0.05–0.25 0G (a few US cents), shown under each answer. Questions go to the GLM-5.3 model running in a secure enclave (TEE) via the 0G Router. Open it with **Ask** (bottom right; on phones the round button). It can point at controls on the page: the control pulses. Answers link to their sources; check them, answers can be wrong.

## How it works underneath

- **0G Storage** stores files as content-addressed blobs: each file is split into 256 KB segments, a Merkle root identifies it, and a transaction to the Flow contract registers it and pays the fee. Storage nodes then accept the segments and "seal" them.
- **Drive structure** lives in small encrypted listing files ("manifests") uploaded the same way: one for the folder list, one per folder with its file records (name, size, key, search index), one for trash, and a public backup of your drive key locked under the recovery signature and the password.
- **Finding your drive** needs no server: the app scans the chain for your account's upload events, picks the newest listing of each kind, downloads and decrypts it.
- **Encryption**: per-file AES-256 keys; file keys locked under your drive key; the drive key locked under a key derived from a fixed wallet signature (and optionally your password, PBKDF2 600k rounds). Share keys are derived from the same signature.
- **Network**: 0G Galileo testnet (chain 16602, RPC https://evmrpc-testnet.0g.ai, storage indexer https://indexer-storage-testnet-turbo.0g.ai). Storage is paid for about one year per upload.

## Troubleshooting

- **"Checking for an existing drive on-chain…" for long** — the chain scan is slow or failed; wait or use Retry. Never create a new drive while this is unknown.
- **Upload stuck at "sealing"** — the app waits up to 15 minutes and repairs automatically; if it fails, retry later.
- **"Couldn't check"** in Security — a chain query failed; click Retry.
- **Transaction failed / insufficient funds** — top up 0G (testnet faucet).
- **A file disappeared after refresh** — click ⟳ Sync; listings on another device may be newer.
- **Recipient can't open an encrypted link** — they must connect the exact wallet address the link was made for and have published a share key.
