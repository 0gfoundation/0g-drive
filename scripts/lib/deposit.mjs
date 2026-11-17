// A deposit the relayer has seen. depositForUser returns once the deposit
// is mined; the relayer counts it a moment later, and an upload before then
// is refused for an empty balance ("insufficient balance: have 0 wei"). The
// app waits for it at setup (saveFirstRoot); a test that uses the account
// right away waits here: until the account's standing on the relayer shows
// more than before the deposit, or 2 minutes.
import { depositForUser } from '../../core/dist/index.js'

const SEEN_WAIT_MS = 120_000

export async function depositSeen(net, payer, account, amount) {
  const balance = async () => {
    const res = await fetch(`${net.relayer}/v1/users/${account}/standing`)
    if (!res.ok) throw new Error(`standing: HTTP ${res.status}`)
    return BigInt((await res.json()).balance ?? 0)
  }
  const before = await balance().catch(() => 0n)
  const receipt = await depositForUser(net, payer, account, amount)
  const end = Date.now() + SEEN_WAIT_MS
  while ((await balance().catch(() => before)) <= before) {
    if (Date.now() > end) throw new Error(`the relayer hasn't seen the deposit to ${account} after ${SEEN_WAIT_MS / 1000} s`)
    await new Promise((r) => setTimeout(r, 2000))
  }
  return receipt
}
