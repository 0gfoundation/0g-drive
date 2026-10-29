// Sends a test run's throwaway wallet balance back to the funder, so
// repeated runs (CI) don't drain the test wallet. Best effort: a failed
// refund only leaves dust behind.
import { ethers } from 'ethers'

export async function refund(wallet, to) {
  try {
    const balance = await wallet.provider.getBalance(wallet.address)
    const gasPrice = ((await wallet.provider.getFeeData()).gasPrice ?? 0n) * 2n
    const value = balance - 21000n * gasPrice
    if (gasPrice === 0n || value <= 0n) return
    await (await wallet.sendTransaction({ to, value, gasLimit: 21000n, gasPrice, type: 0 })).wait()
    console.log(`refunded ${ethers.formatEther(value)} 0G to the funding wallet`)
  } catch (e) {
    console.log(`refund skipped: ${e.message.split('\n')[0]}`)
  }
}
