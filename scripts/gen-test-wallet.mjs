// Generate a throwaway testnet wallet for the smoke test.
// Writes .env (gitignored) and prints the address to fund via faucet.0g.ai.
// Never run this for a wallet that holds real funds.
import { ethers } from 'ethers'
import { writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envPath = resolve(root, '.env')

if (existsSync(envPath)) {
  console.error('.env already exists — refusing to overwrite. Delete it first if you really want a new key.')
  process.exit(1)
}

const wallet = ethers.Wallet.createRandom()
writeFileSync(envPath, `PRIVATE_KEY=${wallet.privateKey}\n`, { mode: 0o600 })
console.log('Test wallet created (.env, gitignored).')
console.log('Address to fund:', wallet.address)
console.log('Faucet: https://faucet.0g.ai (0.1 0G/day)')
