// The V2 relayer client's data hash and signed statements (core/v2relayer.ts)
// against the test vectors in the V2 SDK's browser guide. Offline: no
// network, no wallet.
//   node scripts/test-v2-vectors.mjs
import { ethers } from 'ethers'
import { RelayerClient, hashBlob, V2_TESTNET } from '../core/dist/v2relayer.js'

let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const MiB = 1 << 20

const hello = await hashBlob(new Blob(['hello']), MiB)
check('data hash of "hello"', hello.dataHash === '6c62eba29a666677aa93b608a4363bab04951d281e1906d6246049a7dc2b8501', hello.dataHash)
const zeros = await hashBlob(new Blob([new Uint8Array(2.5 * MiB)]), MiB)
check('data hash of 2.5 MiB of zeros (3 chunks)', zeros.dataHash === '76bdbfa9f0f3005c7a976203622a3c2f3237f1ecb8db0f6f5497abfcbad3fdca' && zeros.leaves.length === 3, zeros.dataHash)

const key = new ethers.Wallet('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318')
check('test key address', key.address === '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23', key.address)
const client = new RelayerClient(V2_TESTNET)
const realNow = Date.now
Date.now = () => 1762000000 * 1000
const { headers } = await client.sign(key, 'Upload', { dataHash: '0x9f2c5e1a7b3d4c6e8f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60', fileSize: 10737418240 })
Date.now = realNow
check('Upload statement signature, V as 0/1',
  headers['X-0G-Signature'] === '0x273f074fbe5d3e1b866ed886261aec85bbe7fbb7f4a83a5de346f08c964c5632074a5ee03452828256d58e7ab85f6e33e91514f96185c1f47553d808ff9a319200'
  && headers['X-0G-Signed-At'] === '1762000000', headers['X-0G-Signature'])
console.log(failed ? `${failed} FAILED` : 'V2 VECTORS PASSED ✓')
process.exitCode = failed ? 1 : 0
