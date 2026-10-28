// Send testnet 0G from the project's funded test wallet (.env) to an address.
// Usage: node scripts/send-test-funds.mjs <0x-address> [amount-in-0G, default 100]
import { ethers } from 'ethers'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const privateKey = /^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(
  readFileSync(resolve(root, '.env'), 'utf8')
)?.[1]
const to = process.argv[2]
const amount = process.argv[3] ? Number(process.argv[3]) : 100

if (!privateKey || !/^0x[0-9a-fA-F]{40}$/.test(to ?? '')) {
  console.error('Usage: node scripts/send-test-funds.mjs <0x-address> [amount-0G]')
  process.exit(1)
}

const provider = new ethers.JsonRpcProvider('https://evmrpc-testnet.0g.ai')
const wallet = new ethers.Wallet(privateKey, provider)
console.log(`from: ${wallet.address} (balance ${ethers.formatEther(await provider.getBalance(wallet.address))} 0G)`)
console.log(`to:   ${to}`)
console.log(`amt:  ${amount} 0G`)

const tx = await wallet.sendTransaction({
  to,
  value: ethers.parseEther(String(amount)),
})
console.log(`tx:   ${tx.hash}`)
const receipt = await tx.wait()
console.log(`status: ${receipt.status === 1 ? 'confirmed ✓' : 'FAILED'}`)
console.log(`recipient balance now: ${ethers.formatEther(await provider.getBalance(to))} 0G`)
