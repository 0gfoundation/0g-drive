# 0GDrive user guide

0GDrive is a personal drive — folders, uploads, previews, sharing, trash — that keeps your files on **0G Storage**, a decentralized storage network, instead of a company's servers. Your wallet is your account: there is no sign-up, no password database and no 0GDrive server holding your files. Everything is **encrypted in your browser before it leaves your device**.

This guide explains how to use each feature and what happens underneath. For the design reasoning see `docs/decisions.md`; for the code, `core/src` (storage, encryption, keys) and `web/src/App.tsx` (the app).

0GDrive runs on **0G Storage V2**. Drives made before V2 (on the earlier storage network) don't open in this version; a V2 drive starts separate and empty.

## Getting started

1. **Have a wallet.** 0GDrive works with an Ethereum-style browser wallet extension such as MetaMask, Rabby, OKX Wallet or Coinbase Wallet (a Ledger or Trezor works through one of these), or with a wallet app on your phone through **WalletConnect**: choose WalletConnect and scan the QR code with the app (MetaMask, Trust, Binance, Bitget…). Each approval then pops up on your phone.
2. **Connect wallet** (top right, or **Get started** on the welcome screen). With more than one choice (several extensions, or an extension and WalletConnect), choose in the "Choose a wallet" list (the last one you used is at the top). Your drive belongs to the account, not to the wallet app: the same account opens it in any of them. The app then switches the wallet to the 0G network it runs on (currently the **0G Galileo testnet**, chain ID 16602); approve the switch if asked.

   Once connected, the app reconnects by itself next time, without a prompt, as long as the wallet still allows this site. The **⌄** next to your address opens **Switch wallet or account** (pick another wallet app, or another account in yours) and **Disconnect** (this device stops reconnecting until you click Connect again). Switching accounts inside your wallet works too: the app starts over in the new account.
3. **Get some 0G.** Setup needs about **0.2 0G**: a first deposit of 0.1 0G to your drive's storage balance (see below), plus the network fee for that transaction (about 0.1 0G on testnet). On testnet use the faucet linked in the footer ("Get testnet 0G", https://faucet.0g.ai). Your wallet's balance shows in the header.
4. **Create your drive.** On a new account the banner says "Create your drive." Click **Create my drive**. A random *drive key* is generated in your browser, then your wallet asks for:
   - **2 signatures of the same message** — the recovery signature. The app checks that your wallet signs it the same way both times: on a new device, that signature is what unlocks your drive.
   - **1 signature linking your wallet to your drive's storage account**, so the app can find your drive from your wallet address alone.
   - **1 transaction**: the 0.1 0G first deposit to your storage balance.

   Recovery and your share key are on from the start; there is nothing else to set up. If setup stops halfway (a closed wallet window, say), the banner says **Finish setup**: it uses the same drive key and doesn't deposit twice.

   If your wallet doesn't hold enough 0G, setup says so (with what it holds) before asking for the linking signature.

   **If your wallet gives a different signature each time** (some smart-contract, passkey, MPC and social-login wallets), the app says so after the first two signatures and offers **Set up with a recovery password instead**: type a password twice (at least 12 characters), then 1 signature and the deposit. Such a drive opens on another device only with that password or the key file — the app offers the key file as soon as setup ends — and others can't send you files by your address (share links still work). A smart-contract wallet that isn't deployed yet is refused before the deposit: make one transaction from it first, or use another wallet.

If the account already has a drive, the start banner says "This wallet has a drive on 0G." — click **Restore my drive** and sign once (or use the recovery password, or import the key file). Don't create a second drive on an account that already has one.

## What it costs, and what asks your wallet

Your drive has its own **storage account**, derived from your drive key. It pays for the space your files take from a **storage balance** you top up from your wallet, and it signs every upload and change itself, in your browser. So after setup, **using the drive asks your wallet for nothing**: no prompt per upload, folder or rename.

| Action | Wallet prompts |
|---|---|
| Create your drive | 3 signatures + 1 transaction (the first deposit) |
| Deposit to your storage balance | 1 transaction |
| Upload files, new folder, rename, move, trash, restore, delete forever, organize moves | nothing |
| Set or change the recovery password | nothing |
| Restore your drive on a new device | 1 signature (or the password, or the key file), no transaction |
| Create a share link | nothing |
| Open a link encrypted to you | 1 signature the first time on a device, no transaction |
| Browse, preview, download, search | nothing |

**The storage balance** shows in the sidebar's Security section (the **Storage** row), with a **Deposit** button (you choose the amount; 1 transaction). Storage is charged as rent for as long as a file is kept — on testnet about 38.9 0G per TB per month, so the first 0.1 0G covers roughly 2.5 GB for a month. An upload holds about a week of its rent up front: if the balance is lower than that, the app offers a deposit before uploading. If the balance runs out, uploads are refused until you deposit; keep it topped up, since the network can eventually reclaim the files of an account that stays unpaid. **Delete forever** (from the trash) deletes the file from 0G Storage and stops its rent; replaced versions of your folder listings are deleted the same way.

## On a phone

Phone browsers have no wallet built in. Two ways in:

- **Connect your wallet app** (WalletConnect): you stay in Safari or Chrome. Pick your wallet app (**MetaMask**, **Trust Wallet**, **Binance Wallet**, **Bitget Wallet**, or copy the connection link into another one); it opens and asks you to connect; come back to the page. Later approvals (a deposit, opening a link encrypted to you) work the same way: a bar says "Approve in …" with a button that opens the wallet app. To come back after approving, tap **◀ Safari** / **◀ Chrome** at the top left of the screen (iPhone) or use the app switcher; your page is where you left it.
- **Open 0GDrive in a wallet app's own browser**: **MetaMask**, **Trust Wallet**, **OKX Wallet** or **Coinbase Wallet** (or copy the link and open it in another wallet's browser).

With the second way, the wallet app's browser is separate from your phone's browser: your drive opens there as on a new device (connect, then restore it with your wallet or recovery password). Some wallet apps lock or close their browser when you switch apps; you'll then reconnect when you come back.

## Uploading files

- Drop files on the upload zone ("Drop files here or click to upload"; on phones "Tap to upload files"), or click it to pick files. Files go into the folder you are viewing.
- **No wallet prompt.** Each file is encrypted on your device and sent to 0G Storage, two at a time; then the folder's listing is saved, so the whole drop appears at once.
- The **Uploads** list shows each file's state: *queued → preparing → hashing & encrypting / storing segments (with %) → saving to your drive → in your drive ✓*. A connection that drops mid-file is resumed from where it stopped.
- If your storage balance is low for the files' size, the app offers a deposit first (1 transaction); if the balance runs out during an upload, that file fails with "your storage balance ran out — deposit, then upload it again".
- You can keep dropping files while an upload runs; they queue and go up next.
- **A name that's already in the folder** (ignoring upper/lower case, including files still uploading there, or the same name twice in one drop): you're asked first, with a name field for each such file, filled in with “name (1).ext”. **Upload with these names** uploads them under the names in the fields (edit any of them; a name already used there, or given to two files, is refused); **Replace** moves the file already there to the trash (you can restore it) in the same change; **Skip** uploads only the other files; **Cancel** uploads nothing. Two files in a folder never share a name.
- If some files fail, the others are still added; each failed one shows ✗ with the reason. Keep your local copy and try again.

Every file gets its own random key; the file is encrypted with it before upload, and that key is stored (locked under your drive key) in the folder's listing.

## Folders, trash and sync

- **+ New folder** creates a folder in the current folder (no wallet prompt). The sidebar shows the folder tree; click a folder to open it, the arrow to expand it.
- **Rename** (pencil icon on a file) changes its name, with no wallet prompt. The file itself isn't re-uploaded: names live only in your folder's encrypted listing. A name already used in the folder (ignoring upper/lower case), an empty name or one containing “/” is refused. Changing the extension doesn't change how 0GDrive opens the file. With on-device AI on, the file's search data is updated for the new name. Share links you already sent keep showing the old name, and still work.
- **Rename a folder** with the pencil next to it in the folder list on the left (on a phone, open the ☰ menu). However much is inside, nothing is re-uploaded, and its files and subfolders stay where they are. A name another folder beside it already has (ignoring upper/lower case), an empty name or one containing “/” is refused. If you have the folder open, you stay in it under its new name.
- **Move files or folders** with "Move to…": the arrow-folder icon on a file or on a folder in the left list, or "Move to…" when you've selected several files. Pick where they go, or make a new folder right there with "+ New folder in …". Nothing is re-uploaded (a new folder made there is created in the same change); a moved folder keeps everything inside it. A name already used where you're moving to (ignoring upper/lower case) is refused, and a folder can't go into itself. If you have the moved folder open, you stay in it at its new place.
- **Select files** with their checkboxes; **Select all** (the box at the top of the list, or above the tiles in grid view) picks every file in the folder, and clicking it again clears them. A dash in it means only some are selected.
- **Move to trash** (trash icon on a file, or select several and **Trash selected**). Folders can be moved to trash from the tree.
- **Trash** (sidebar): the restore button (↺) puts a file back where it was. If its folder has a file of the same name by then, the restored one is named “name (1).ext” and Activity says so. The × button is **Delete forever**: after you confirm, the file is deleted from 0G Storage (its rent stops) and share links to it stop working.
- Moving a file to the trash keeps it (and its rent); only **Delete forever** removes it from 0G. Anyone who downloaded the encrypted file before, or holds a link with its key, may still have a copy.
- **A change is all or nothing.** Each change (an upload's listing, a rename, a move…) becomes visible in one step, when its new drive *root* is saved; until then nothing has changed. If the page closes before that, the change simply didn't happen: do it again. Two devices changing the drive at the same moment are merged.
- **⟳ Sync** reloads the drive from 0G Storage — useful after using the drive on another device.
- **List / Grid** toggle switches the file view; photos, videos and SVG images show thumbnails, and PDFs their first page (with a “PDF” badge in the grid). Other files show an icon for their type (PDF, document, spreadsheet, presentation, text, code, archive, audio, video, ebook, design, font, app); in the grid it also shows the extension, e.g. “PPTX”.

## Preview and download

File buttons show icons only; point at one to see its name. Click a file name to preview it (images, PDFs, text and code up to 2 MB, audio, video; files up to 100 MB), or use the download button (↓). Files are downloaded from storage nodes and decrypted in your browser. An HTML file opens as the page it shows (**Source** shows its text): safely — its scripts don’t run, links don’t open and nothing is loaded from the internet. A Markdown file (`.md`) opens formatted — headings, lists, tables, code — under the same rules (images from the internet show as their description); **Source** shows its text. On phones and tablets a PDF opens as scrollable pages with a page counter; for zoom or search, download it. Previewed files are kept on this device **still encrypted**, so the next preview is instant. Thumbnails made by the browser are kept on this device (unencrypted, never uploaded) for speed; clearing the site's data removes them.

## Sharing

Click the share button on a file. Two kinds of link:

- **Secret link** — anyone with the link can download and decrypt that one file. The file's key rides in the part of the URL after `#`, which browsers never send to a server. Treat the link like the file itself. Works for anyone, no wallet needed.
- **Encrypted to recipient** — enter the recipient's wallet address; click **Wrap & create link**. The file key is locked to the recipient's published **share key**, so only their wallet can open it: they connect the same wallet, sign once ("Unlock with wallet & download"), no transaction. Someone else opening the link is refused before signing.

Creating a link stores nothing and needs no approval. A sent link can't be withdrawn on its own (the recipient may already have the file); **Delete forever** stops every link to that file.

The recipient must have a 0GDrive: their share key is published with their drive when they create it. Sharing to an address with no drive is refused ("this address has no 0GDrive yet"), and so is an address whose drive was set up with a recovery password only ("send a share link instead"). A secret link points at the file's data on 0G Storage, so **Delete forever** makes it stop working.

## Security: storage, recovery, password, share key, key file

The **Security** section of the sidebar shows:

| Row | Meaning | Action |
|---|---|---|
| **Storage** | Your storage balance (what pays for your files' space). | **Deposit** (1 transaction) |
| **Recovery** | Your drive key, locked to your wallet's recovery signature and kept with your drive on 0G Storage. On a new device: connect wallet → **Restore my drive** → sign once. **Password only** for a drive set up with a recovery password instead. | — (on from setup) |
| **Password** | A second lock on the drive key, for when you lose the wallet. | **Set** / **Change** (no wallet prompt) |
| **Share key** | The public key others use for "Encrypted to recipient" links to you. **Not published** for a password-only drive. | — (published at setup) |
| **Key file** | A copy of your drive key to keep offline. | **Export** |

The locked copies of your drive key live in your drive's **card**: a small public record at the start of your drive's root file, with your wallet address, your storage account, your wallet's linking signature and your share key. It's public so a new device can find and unlock your drive; without your wallet's signature, the password or the key file, it's only encrypted bytes.

### Recovery password

**Set** opens a dialog: type the password twice, at least 12 characters. Use several unrelated words — the locked copy is public, so anyone can try guessing offline, and **nobody can reset it for you**. Setting a new password replaces the old one (the old one stops working). It's saved with your drive, with no wallet prompt. "Set" shows again as "Change" after it's saved.

### Lost your wallet?

On the start screen (no wallet connected): **Lost access to your wallet? → Open your drive with its recovery password**. Enter the drive's wallet address and the recovery password. The drive opens **read-only**: you can browse, preview, download and share files, but not upload or change anything (that needs the wallet). The drive key is kept in memory only — nothing is saved on that device; **Exit** closes it. Export the key file from the sidebar if you want a copy. This works only if a password was set before the wallet was lost.

### Key file

**Export** downloads your drive key. Anyone with this file can read your whole drive — store it offline. To use it: on the start banner, "import an existing 0x… key" (new drive screen) or "advanced: import a key file" (restore screen).

### What if…

- *I lose my wallet, no password, no key file* — the drive cannot be opened. There is no reset: 0GDrive has no server that knows your keys.
- *Someone gets my key file / drive key* — they can read every file uploaded so far, permanently (the encrypted data is public and immutable).
- *I clear my browser data* — connect the wallet and **Restore my drive** (one signature), or use the recovery password or the key file.
- *My storage balance runs out* — uploads are refused until you deposit; deposit promptly, as the network can eventually reclaim the files of an account that stays unpaid.

## Search and organize (on-device AI)

Sidebar → **On-device AI → Smart search & organize**. When on, AI models run **inside your browser** — no file content or query leaves your device. They download once (~250 MB; the text model comes from 0G Storage) when your drive opens; the photo part is only loaded into memory the first time you upload or search photos.

**On phones it starts off.** The models need about 600 MB of memory, and some phones and wallet apps' browsers close the page or fail to load them when it runs short. You can still turn it on; the app asks first. Search by file name works either way.

- **Search your drive — English and Chinese**: finds files by meaning, e.g. "猫" finds a cat photo named IMG_0001.jpg, "lease contract" finds a PDF named in Chinese. Names with accents (café, José) work too; text in other languages (Japanese, Korean, Russian…) is matched by file name and exact words only. Matches names, text excerpts and photo content.
- New uploads are indexed automatically. Files without an index (uploaded with smart search off, before the models were ready, or from another device) are found and indexed **in the background**, anywhere in the drive, one at a time while you're not uploading or previewing. The sidebar shows "N files to index for search" while it works; search on this device uses them straight away.
- Those entries are saved in your drive (for your other devices) with **your next change** — an upload, rename, move or new folder. To save them right away, use **Save** next to "N indexed on this device" in the sidebar (no wallet prompt).
- "N indexed by name only": files whose content couldn't be read (or has no text, like a scanned PDF); search matches their names.
- **✨ Suggest organization** proposes moving files to better-matching folders; the moves you pick are made in one change, with no wallet prompt.
- When off, search matches file names only.

## Assistant (this help panel)

The assistant answers questions about 0GDrive and 0G. It runs in a separate, isolated part of the page: it **cannot see your files, file names, keys, or wallet address** — only on/off facts such as "recovery is on" or "no recovery password" — and it never asks for passwords or keys. It uses your own 0G Private Computer API key (create one at https://pc.0g.ai → Dashboard → API Keys), stored only in the assistant's part of this browser (on iPhones and in Safari, asked again if you haven't used the assistant for a week); you pay 0G directly per question — usually 0.05–0.25 0G (a few US cents), shown under each answer. Questions go to the GLM-5.3 model running in a secure enclave (TEE) via the 0G Router. Open it with **Ask** (bottom right; on phones the round button). It can point at controls on the page: the control pulses. Answers link to their sources; check them, answers can be wrong.

## How it works underneath

- **0G Storage V2** stores files through a relayer (`https://galileo-storage-v2-relayer.0g.ai` on testnet): each upload is signed by your drive's storage account (an EIP-712 statement, in your browser), sent in parts, and identified by its *data hash*. Rent is charged from the account's storage balance in the PaymentVault contract, which your wallet tops up with deposits. Deleting a file stops its rent.
- **Drive structure** lives in small encrypted *listing* files: one for the folder list, one per folder with its file records (name, size, data hash, the file's locked key, search entry), one for trash. A **root** file names the current version of every listing; each change uploads the new listings, then a new root, and the replaced ones are deleted one change later.
- **Finding your drive** needs no server. On a new device: the wallet's deposits to the PaymentVault (on chain) name the storage accounts it funded; the newest file starting with the root marker in such an account is the root, and its public **card** — signed by your wallet — confirms it's your drive and holds the locked drive key. Unlock it (signature, password or key file), and the rest of the root decrypts. A device that already has your drive key finds the root from it directly.
- **Encryption**: per-file AES-256 keys; file keys locked under your drive key; the drive key locked under a key derived from a fixed wallet signature (HKDF) and optionally your password (PBKDF2, 600k rounds). The storage account is derived from the drive key, and the share key from the wallet signature; neither leads back to the key it came from.
- **Network**: 0G Galileo testnet (chain 16602, RPC https://evmrpc-testnet.0g.ai); storage on 0G Storage V2 through its testnet relayer.

## Troubleshooting

- **"Looking for your drive…" for long** — the app reads your wallet's storage deposits on chain; slow or failed. If it says it couldn't check, use **Retry**. Never create a new drive while this is unknown.
- **"Your wallet doesn't have enough 0G for the deposit and its network fee"** — add 0G to the wallet (testnet faucet), then try again.
- **"The deposit was sent but couldn't be confirmed"** — the transaction may still go through: check the Storage row before depositing again.
- **An upload fails with "your storage balance ran out"** — deposit (Storage row), then upload the file again.
- **"Models failed to load (…)"** next to Smart search — the reason is in brackets (also in Activity). *Not enough memory on this device* is common on phones and in wallet apps' browsers: smart search needs about 1 GB there; search keeps matching file names. *Couldn't download the models* — check the connection and retry from the search box.
- **A change didn't happen** — the page closed before it was saved; do it again.
- **A file disappeared after refresh** — click ⟳ Sync; another device may have changed the drive.
- **"The drive key on this device belongs to a different drive"** — restore this wallet's drive with the banner below it.
- **Phone: stuck at "Reconnecting…" / "Connecting…", or "WalletConnect didn't start"** — what WalletConnect saved in this browser can get stuck. Tap **Start a new connection** (it clears only that, not your drive), then connect your wallet app again. Adding `?debug=wc` to the address shows WalletConnect's log on the page, for a screenshot when reporting a problem.
- **Recipient can't open an encrypted link** — they must connect the exact wallet address the link was made for.
- **A link says it's from the old network** — it was made before V2; that file isn't on V2.
