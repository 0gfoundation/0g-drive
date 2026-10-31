// Checks, without spending anything, that each network's Flow contract
// takes a batchSubmit: the selector is in the implementation's bytecode,
// and a 3-blob batchSubmit simulated with eth_call (balance overridden on a
// random address) succeeds. A real upload still needs
// scripts/test-batch-submit.mjs.
//
//   node scripts/check-batch-submit.mjs
import { ethers } from 'ethers'
import { MemData, getFlowContract, getMarketContract } from '@0gfoundation/0g-storage-ts-sdk'
import { getNetworkConfig } from '../core/dist/index.js'

const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
let ok = true

for (const name of ['testnet', 'mainnet']) {
  const network = getNetworkConfig(name, 'turbo')
  const provider = new ethers.JsonRpcProvider(network.rpcUrl)
  const flow = getFlowContract(network.flowAddress, provider)

  // the code that runs: the proxy's implementation (EIP-1967 slot or beacon)
  const slotAddr = async (slot) => ethers.getAddress('0x' + (await provider.getStorage(network.flowAddress, slot)).slice(26))
  let impl = await slotAddr(IMPL_SLOT)
  if (impl === ethers.ZeroAddress) {
    const beacon = await slotAddr(BEACON_SLOT)
    if (beacon !== ethers.ZeroAddress) {
      impl = await new ethers.Contract(beacon, ['function implementation() view returns (address)'], provider).implementation()
    }
  }
  const code = (await provider.getCode(network.flowAddress)) + (impl === ethers.ZeroAddress ? '' : await provider.getCode(impl))
  const selector = flow.interface.getFunction('batchSubmit').selector.slice(2)
  const hasSelector = code.includes('63' + selector) // PUSH4 <selector> in the dispatcher

  const from = ethers.Wallet.createRandom().address
  const market = getMarketContract(await flow.market(), provider)
  const price = await market.pricePerSector()
  const submissions = []
  let fee = 0n
  for (const size of [1_000, 70_000, 300_001]) {
    const data = new Uint8Array(size)
    crypto.getRandomValues(data.subarray(0, Math.min(size, 65536)))
    const [s, err] = await new MemData(data).createSubmission('0x', from)
    if (err) throw err
    submissions.push(s)
    fee += s.data.nodes.reduce((n, node) => n + (1n << BigInt(node.height)), 0n) * price
  }
  let simulated = ''
  try {
    const out = await provider.send('eth_call', [
      { from, to: network.flowAddress, data: flow.interface.encodeFunctionData('batchSubmit', [submissions]), value: ethers.toQuantity(fee) },
      'latest',
      { [from]: { balance: ethers.toQuantity(ethers.parseEther('1000')) } },
    ])
    const [seqs] = flow.interface.decodeFunctionResult('batchSubmit', out)
    simulated = `ok, txSeqs ${seqs.join(', ')}`
  } catch (e) {
    simulated = `REVERTED: ${e.shortMessage ?? e.message}`
  }
  const pass = hasSelector && simulated.startsWith('ok')
  ok &&= pass
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: batchSubmit in bytecode ${hasSelector}; simulated 3-blob batchSubmit ${simulated}`)
}
process.exit(ok ? 0 : 1)
