import { ethers } from 'ethers'
import type { NetworkConfig } from '@0gdrive/core'

declare global {
  interface Window {
    ethereum?: {
      request(args: { method: string; params?: unknown[] }): Promise<unknown>
      on(event: string, handler: (arg: never) => void): void
      removeListener(event: string, handler: (arg: never) => void): void
    }
  }
}

export interface WalletState {
  address: string
  balance: string // 0G
  chainId: number
  signer: ethers.JsonRpcSigner
}

export function hasWallet(): boolean {
  return typeof window !== 'undefined' && window.ethereum !== undefined
}

export async function connectWallet(
  network: NetworkConfig
): Promise<WalletState> {
  if (!window.ethereum) {
    throw new Error('No Ethereum wallet detected. Install MetaMask to use 0GDrive.')
  }
  const provider = new ethers.BrowserProvider(window.ethereum)
  await provider.send('eth_requestAccounts', [])
  await ensureNetwork(network, provider)
  const signer = await provider.getSigner()
  return await readWalletState(signer, network)
}

export async function readWalletState(
  signer: ethers.JsonRpcSigner,
  network: NetworkConfig
): Promise<WalletState> {
  const address = await signer.getAddress()
  const provider = signer.provider as ethers.BrowserProvider
  const networkInfo = await provider.getNetwork()
  const balanceWei = await provider.getBalance(address)
  if (Number(networkInfo.chainId) !== network.chainId) {
    throw new Error(
      `Wallet is on chain ${networkInfo.chainId}, expected ${network.chainId} (${network.chainName}).`
    )
  }
  return {
    address,
    balance: ethers.formatEther(balanceWei),
    chainId: Number(networkInfo.chainId),
    signer,
  }
}

async function ensureNetwork(
  network: NetworkConfig,
  provider: ethers.BrowserProvider
): Promise<void> {
  const current = await provider.getNetwork()
  if (Number(current.chainId) === network.chainId) return

  try {
    await window.ethereum!.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: network.chainIdHex }],
    })
  } catch (err) {
    const code = (err as { code?: number }).code
    if (code === 4902 || code === -32603) {
      await window.ethereum!.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: network.chainIdHex,
            chainName: network.chainName,
            nativeCurrency: network.nativeCurrency,
            rpcUrls: [network.rpcUrl],
            blockExplorerUrls: [network.explorerTxUrl.replace(/\/tx\/$/, '')],
          },
        ],
      })
    } else {
      throw err
    }
  }
}

export function onAccountsChanged(handler: (accounts: string[]) => void): void {
  window.ethereum?.on('accountsChanged', handler as never)
}

export function onChainChanged(handler: (chainId: string) => void): void {
  window.ethereum?.on('chainChanged', handler as never)
}
