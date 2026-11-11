import { ethers } from 'ethers'
import type { NetworkConfig } from './config.js'

/**
 * Fold the submission's merkle witness nodes into the file root, mirroring
 * the storage node's `nodes_to_root` (log_entry_fetcher.rs:782): start from
 * the last node, fold right-to-left, each step keccak256(left ‖ right) over
 * the 64 raw concatenated bytes.
 */
export function foldNodesToRoot(
  nodes: ReadonlyArray<{ root: ethers.BytesLike; height?: ethers.BigNumberish }>
): string {
  const roots = nodes.map((n) => ethers.getBytes(n.root))
  let acc = roots[roots.length - 1]
  for (let i = roots.length - 2; i >= 0; i--) {
    acc = ethers.getBytes(
      ethers.keccak256(new Uint8Array([...roots[i], ...acc]))
    )
  }
  return ethers.hexlify(acc)
}

const providers = new Map<string, ethers.JsonRpcProvider>()

/**
 * One JSON-RPC provider per RPC URL, shared by every V1 upload and read. A
 * fresh provider asks for eth_chainId before its first call; a shared one
 * with a static network never does, and calls made together go out as one
 * batched request.
 */
export function rpcProvider(network: NetworkConfig): ethers.JsonRpcProvider {
  let provider = providers.get(network.rpcUrl)
  if (!provider) {
    // cacheTimeout -1: no reusing a just-made call's answer
    provider = new ethers.JsonRpcProvider(network.rpcUrl, network.chainId, { staticNetwork: true, cacheTimeout: -1 })
    providers.set(network.rpcUrl, provider)
  }
  return provider
}
