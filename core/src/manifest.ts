import { ethers } from 'ethers'
import type { FileMeta } from './types.js'
import type { UploadEvent } from './events.js'

/**
 * Manifest layer: drive metadata as tagged, encrypted 0G files.
 *
 * Tag layout (96 bytes, recorded on-chain in the Submit event):
 *   [0..32)   domain: keccak256("0GDRIVE:v1")
 *   [32..33)  purpose: 0x01 = drive index, 0x02 = folder manifest
 *   [33..64)  folder path hash: keccak256(path) — zeroed for the index
 *
 * Because tags are on-chain, a client can find the latest manifest for any
 * folder by scanning events — no downloads needed until the final pick.
 */

export const MANIFEST_DOMAIN = ethers.id('0GDRIVE:v1')

const PURPOSE_INDEX = '01'
const PURPOSE_FOLDER = '02'
const PURPOSE_PROFILE = '03'

/** Reserved folder path holding trashed file records. */
export const TRASH_PATH = '__trash__'

export interface DriveIndex {
  /** Canonical folder paths that currently exist (excluding trash). */
  folders: string[]
  updatedAt: number
  version: number
}

export interface FolderManifest {
  path: string
  files: FileMeta[]
  updatedAt: number
  version: number
}

export function folderPathHash(path: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(path))
}

/** Tag hex for a drive-index manifest upload. */
export function indexTag(): string {
  return MANIFEST_DOMAIN + PURPOSE_INDEX + '00'.repeat(32)
}

/** Tag hex for a folder-manifest upload. */
export function folderTag(path: string): string {
  return MANIFEST_DOMAIN + PURPOSE_FOLDER + folderPathHash(path).slice(2)
}

/** Tag hex for a public profile upload (unencrypted, one per user). */
export function profileTag(): string {
  return MANIFEST_DOMAIN + PURPOSE_PROFILE + '00'.repeat(32)
}

function normTags(tags: string): string {
  const t = tags.toLowerCase()
  return t === '0x' ? '' : t.slice(2)
}

/**
 * Filter a wallet's upload events down to manifest uploads of one purpose,
 * optionally for one folder path. Returns them in chain order (oldest
 * first); the caller picks the highest block for the latest version.
 */
export function findManifestEvents(
  events: UploadEvent[],
  purpose: 'index' | 'folder' | 'profile',
  folderPath?: string
): UploadEvent[] {
  const expected =
    purpose === 'index'
      ? normTags(indexTag())
      : purpose === 'profile'
        ? normTags(profileTag())
        : normTags(folderTag(folderPath ?? ''))
  return events.filter((e) => normTags(e.tags) === expected)
}

/** Highest-block event (latest manifest version), or null. */
export function latestManifestEvent(
  events: UploadEvent[],
  purpose: 'index' | 'folder' | 'profile',
  folderPath?: string
): UploadEvent | null {
  const matches = findManifestEvents(events, purpose, folderPath)
  if (matches.length === 0) return null
  return matches.reduce((best, e) =>
    e.blockNumber >= best.blockNumber ? e : best
  )
}
