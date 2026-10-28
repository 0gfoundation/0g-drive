import type { ethers } from 'ethers'
import type { NetworkConfig } from './config.js'
import { uploadData, downloadFile } from './storage.js'
import { scanUploads, scanUploadsCached, scanUploadsNewestFirst, type EventCache, type UploadEvent } from './events.js'
import { findManifestEvents, profileTag } from './manifest.js'

/**
 * Public sharing profiles: a small UNENCRYPTED record, uploaded as a
 * tagged 0G file, mapping a wallet address to its compressed secp256k1
 * public key. Senders use it to resolve "share with 0xAlice…" to a pubkey
 * for ECIES key-wrapping (Mode B). It is public by design — a pubkey
 * reveals nothing beyond what any on-chain signature already reveals.
 */

export interface PublicProfile {
  address: string
  /** Compressed secp256k1 public key (0x + 66 hex chars). */
  pubKey: string
  /**
   * 'share': the derived sharing key (sharekey.ts) — the recipient opens
   * shares with a wallet signature. 'wallet' (legacy): the wallet's own
   * key — opening needs the raw private key. Absent means 'wallet'.
   */
  kind?: 'share' | 'wallet'
  updatedAt: number
}

/**
 * Publish (or re-publish) the caller's profile. One small tx.
 * The wallet's pubkey is recovered from a signature by the caller
 * (see wallet.ts getWalletPublicKey) — this function takes it as input.
 */
export async function publishProfile(
  network: NetworkConfig,
  signer: ethers.Signer,
  address: string,
  pubKey: string
): Promise<{ rootHash: string; txHash: string }> {
  const profile: PublicProfile = {
    address: address.toLowerCase(),
    pubKey,
    updatedAt: Date.now(),
  }
  const result = await uploadData(
    new TextEncoder().encode(JSON.stringify(profile)),
    network,
    signer,
    // unencrypted: the point is that anyone can read it
    { tags: profileTag(), finalityRequired: false }
  )
  return { rootHash: result.rootHash, txHash: result.txHash }
}

/**
 * Look up a user's published profile from the chain. Checks the key-backup
 * manifests first (the combined setup publishes the pubKey there), then
 * falls back to standalone profile manifests (tag 0x03). Null when the
 * user never published either.
 */
export async function getProfile(
  address: string,
  network: NetworkConfig,
  /** only for the connected wallet's own address */
  cache?: EventCache
): Promise<PublicProfile | null> {
  if (cache) {
    return profileFromEvents(address, network, (await scanUploadsCached(address, network, cache)).events)
  }
  // Someone else's profile (no cache): only the latest backup manifest
  // matters, and it's usually recent — look at the newest blocks first.
  const { backupTag } = await import('./recovery.js')
  const backupExpected = backupTag().slice(2).toLowerCase()
  const scan = await scanUploadsNewestFirst(address, network, (events) =>
    events.some((e) => e.tags.toLowerCase().slice(2) === backupExpected)
  )
  const found = await profileFromEvents(address, network, scan.events)
  if (found || scan.complete) return found
  // the recent backup carried no key: the answer may be in older blocks
  return profileFromEvents(address, network, (await scanUploads(address, network)).events)
}

async function profileFromEvents(
  address: string,
  network: NetworkConfig,
  events: UploadEvent[]
): Promise<PublicProfile | null> {
  // combined path: latest backup manifest carrying a key
  const { backupTag } = await import('./recovery.js')
  const backupExpected = backupTag().slice(2).toLowerCase()
  const backupCandidates = events.filter(
    (e) => e.tags.toLowerCase().slice(2) === backupExpected
  )
  if (backupCandidates.length > 0) {
    const latest = backupCandidates.reduce((a, b) =>
      b.blockNumber >= a.blockNumber ? b : a
    )
    try {
      const { data } = await downloadFile([latest.rootHash], network, {
        txSeqs: [latest.txSeq],
      })
      const backup = JSON.parse(new TextDecoder().decode(data)) as {
        shareKey?: string
        pubKey?: string
        updatedAt?: number
      }
      if (typeof backup.shareKey === 'string') {
        return {
          address: address.toLowerCase(),
          pubKey: backup.shareKey,
          kind: 'share',
          updatedAt: backup.updatedAt ?? 0,
        }
      }
      if (typeof backup.pubKey === 'string') {
        return {
          address: address.toLowerCase(),
          pubKey: backup.pubKey,
          kind: 'wallet',
          updatedAt: backup.updatedAt ?? 0,
        }
      }
    } catch {
      // fall through to the standalone profile path
    }
  }

  // standalone path: purpose 0x03 profile manifests
  const candidates = findManifestEvents(events, 'profile')
  if (candidates.length === 0) return null
  const latest = candidates.reduce((a, b) =>
    b.blockNumber >= a.blockNumber ? b : a
  )
  try {
    const { data } = await downloadFile([latest.rootHash], network, {
      txSeqs: [latest.txSeq],
    })
    const profile = JSON.parse(new TextDecoder().decode(data)) as PublicProfile
    if (
      typeof profile.address !== 'string' ||
      typeof profile.pubKey !== 'string'
    ) {
      return null
    }
    return { ...profile, kind: 'wallet' }
  } catch {
    return null
  }
}
