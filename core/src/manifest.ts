import { ethers } from 'ethers'
import type { FileMeta } from './types.js'

/**
 * Manifest layer: drive metadata as encrypted listings, each stored under
 * a stable key (V2: named by the drive's root, v2backend.ts).
 *
 * Key layout (hex, 96 bytes; first used as V1 transaction tags, kept so
 * keys stay the same):
 *   [0..32)   domain: keccak256("0GDRIVE:v1")
 *   [32..33)  purpose: 0x01 = drive index, 0x02 = folder manifest
 *   [33..64)  folder key hash: keccak256(key) — zeroed for the index
 *
 * A folder's key is its permanent id (see FolderNode). Folders made before
 * the tree index (and the root, '', and the trash) use their path as the
 * key.
 */

export const MANIFEST_DOMAIN = ethers.id('0GDRIVE:v1')

const PURPOSE_INDEX = '01'
const PURPOSE_FOLDER = '02'

/** Reserved folder path holding trashed file records. */
export const TRASH_PATH = '__trash__'

/** One folder in the drive index's tree. */
export interface FolderNode {
  /** Permanent key: its manifest's tag. 'f:' + random hex for new
   *  folders; the path it had for folders made before the tree index. */
  id: string
  name: string
  /** The parent folder's id; ROOT_ID for top-level folders. */
  parent: string
}

/** The drive root's folder key. */
export const ROOT_ID = ''

/**
 * The stored drive index. v2 holds the folder tree, so renaming or moving
 * a folder rewrites only the index. v1 (no `v`) held folder paths; it is
 * read as a tree whose ids are those paths, and written back as v2.
 */
export interface DriveIndex {
  v?: 2
  folders: FolderNode[] | string[]
  updatedAt: number
  version: number
}

export interface FolderManifest {
  /** The folder's key (its id; a path for folders made before v2). */
  path: string
  files: FileMeta[]
  updatedAt: number
  version: number
}

export function folderPathHash(key: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(key))
}

/** Tag hex for a drive-index manifest upload. */
export function indexTag(): string {
  return MANIFEST_DOMAIN + PURPOSE_INDEX + '00'.repeat(32)
}

/** Tag hex for a folder-manifest upload, by folder key. */
export function folderTag(key: string): string {
  return MANIFEST_DOMAIN + PURPOSE_FOLDER + folderPathHash(key).slice(2)
}
