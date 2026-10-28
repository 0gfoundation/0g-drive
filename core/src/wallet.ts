import { ethers } from 'ethers'

/**
 * Recover a wallet's compressed secp256k1 public key by asking it to sign a
 * fixed message (works with injected wallets like MetaMask). The signature
 * is verified client-side and the recovered key cached per address.
 *
 * Use this to ECIES-encrypt *to* a wallet (upload path). Note: decrypting
 * ECIES requires the raw private key, which injected wallets will not
 * reveal — see keystore.ts for the web-shell key model.
 */

const PUBKEY_MESSAGE =
  '0GDrive: publish your encryption public key.\nThis signature reveals no secrets and grants no permissions.'

const PUBKEY_PREFIX = '0gdrive:pubkey:'

function cacheKey(address: string): string {
  return PUBKEY_PREFIX + address.toLowerCase()
}

/**
 * Minimal structural signer: ethers v6 Signer satisfies this.
 */
export interface SigningWallet {
  getAddress(): Promise<string>
  signMessage(message: string): Promise<string>
}

export async function getWalletPublicKey(wallet: SigningWallet): Promise<string> {
  const address = (await wallet.getAddress()).toLowerCase()

  try {
    const cached = globalThis.localStorage?.getItem(cacheKey(address))
    if (cached && /^0x[0-9a-fA-F]{66}$/.test(cached)) return cached
  } catch {
    /* storage unavailable — just recompute */
  }

  const signature = await wallet.signMessage(PUBKEY_MESSAGE)
  // personal_sign signatures cover hashMessage(message) (EIP-191)
  const digest = ethers.hashMessage(PUBKEY_MESSAGE)
  const recovered = ethers.SigningKey.recoverPublicKey(digest, signature)
  const compressed = ethers.SigningKey.computePublicKey(recovered, true)

  try {
    globalThis.localStorage?.setItem(cacheKey(address), compressed)
  } catch {
    /* cache is best-effort */
  }
  return compressed
}
