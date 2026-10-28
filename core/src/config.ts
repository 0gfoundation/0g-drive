export type NetworkName = 'testnet' | 'mainnet'
export type StorageMode = 'turbo' | 'standard'

export interface NetworkConfig {
  name: NetworkName
  mode: StorageMode
  chainId: number
  chainIdHex: string
  chainName: string
  rpcUrl: string
  indexerRpc: string
  /** Flow contract address — used for on-chain Submit event scanning. */
  flowAddress: string
  /**
   * Flow `batchSubmit` verified on this network (scripts/test-batch-submit.mjs):
   * many blobs registered in one transaction → one wallet prompt per upload.
   */
  batchSubmit: boolean
  explorerTxUrl: string // prefix; append tx hash
  storageScanUrl: string
  faucetUrl?: string
  nativeCurrency: { name: string; symbol: string; decimals: number }
}

const NETWORK_BASE: Record<NetworkName, Omit<NetworkConfig, 'mode' | 'indexerRpc'>> = {
  testnet: {
    name: 'testnet',
    chainId: 16602,
    chainIdHex: '0x40DA',
    chainName: '0G Galileo Testnet',
    rpcUrl: 'https://evmrpc-testnet.0g.ai',
    flowAddress: '0x22E03a6A89B950F1c82ec5e74F8eCa321a105296',
    batchSubmit: true,
    explorerTxUrl: 'https://chainscan-galileo.0g.ai/tx/',
    storageScanUrl: 'https://storagescan-galileo.0g.ai',
    faucetUrl: 'https://faucet.0g.ai',
    nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
  },
  mainnet: {
    name: 'mainnet',
    chainId: 16661,
    chainIdHex: '0x4105',
    chainName: '0G Mainnet',
    rpcUrl: 'https://evmrpc.0g.ai',
    flowAddress: '0x62D4144dB0F0a6fBBaeb6296c785C71B3D57C526',
    batchSubmit: false, // not yet verified on mainnet
    explorerTxUrl: 'https://chainscan.0g.ai/tx/',
    storageScanUrl: 'https://storagescan.0g.ai',
    nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
  },
}

const INDEXER_URLS: Record<NetworkName, Record<StorageMode, string>> = {
  testnet: {
    turbo: 'https://indexer-storage-testnet-turbo.0g.ai',
    standard: 'https://indexer-storage-testnet-standard.0g.ai',
  },
  mainnet: {
    turbo: 'https://indexer-storage-turbo.0g.ai',
    standard: 'https://indexer-storage.0g.ai',
  },
}

export function getNetworkConfig(
  name: NetworkName = 'testnet',
  mode: StorageMode = 'turbo'
): NetworkConfig {
  return {
    ...NETWORK_BASE[name],
    mode,
    indexerRpc: INDEXER_URLS[name][mode],
  }
}
