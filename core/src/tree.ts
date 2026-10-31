import { ethers } from 'ethers'
import { ROOT_ID, type DriveIndex, type FolderNode } from './manifest.js'

/** Upper bound on folder depth when walking parents (guards a bad index). */
const MAX_DEPTH = 256

/**
 * The drive's folders as a tree of permanent ids (DriveIndex v2). Paths
 * like "Work/2025" are worked out from names and parents; a folder's
 * manifest is found by its id, so renaming or moving a folder changes only
 * this tree.
 */
export class FolderTree {
  private byId = new Map<string, FolderNode>()

  constructor(nodes: FolderNode[] = []) {
    for (const n of nodes) this.byId.set(n.id, { ...n })
  }

  /** The tree an index holds; a v1 index (folder paths) becomes nodes whose
   *  ids are those paths, so existing manifests keep their tags. */
  static fromIndex(index: DriveIndex): FolderTree {
    if (index.v === 2) return new FolderTree(index.folders as FolderNode[])
    const tree = new FolderTree()
    for (const path of [...(index.folders as string[])].sort()) {
      let parent = ROOT_ID
      let prefix = ''
      for (const name of path.split('/')) {
        prefix = prefix ? `${prefix}/${name}` : name
        if (!tree.byId.has(prefix)) tree.byId.set(prefix, { id: prefix, name, parent })
        parent = prefix
      }
    }
    return tree
  }

  get nodes(): FolderNode[] {
    return [...this.byId.values()]
  }

  has(id: string): boolean {
    return id === ROOT_ID || this.byId.has(id)
  }

  get(id: string): FolderNode | undefined {
    return this.byId.get(id)
  }

  children(id: string): FolderNode[] {
    return this.nodes.filter((n) => n.parent === id)
  }

  /** A child of `parent` named `name`: an exact match, else (with
   *  `ignoreCase`) one that differs only in case. */
  child(parent: string, name: string, ignoreCase = false): FolderNode | undefined {
    const kids = this.children(parent)
    return (
      kids.find((n) => n.name === name) ??
      (ignoreCase ? kids.find((n) => n.name.toLowerCase() === name.toLowerCase()) : undefined)
    )
  }

  /** The id of the folder at `path` ('' = root), or null if there is none. */
  idOf(path: string): string | null {
    let id = ROOT_ID
    if (path === '') return id
    for (const name of path.split('/')) {
      const next = this.child(id, name)
      if (!next) return null
      id = next.id
    }
    return id
  }

  /** The current path of folder `id`, or null if it (or a parent) is gone. */
  pathOf(id: string): string | null {
    const names: string[] = []
    let cur = id
    for (let depth = 0; cur !== ROOT_ID; depth++) {
      const node = this.byId.get(cur)
      if (!node || depth > MAX_DEPTH) return null
      names.unshift(node.name)
      cur = node.parent
    }
    return names.join('/')
  }

  /** Every folder's path (not the root), parents before children. */
  paths(): string[] {
    return this.nodes
      .map((n) => this.pathOf(n.id))
      .filter((p): p is string => p !== null)
      .sort()
  }

  /** `id` and every folder below it. */
  subtree(id: string): string[] {
    const out = [id]
    for (let i = 0; i < out.length; i++) out.push(...this.children(out[i]).map((n) => n.id))
    return out
  }

  /** The id of the folder at `path`, creating it and any missing parents
   *  (each with a new id). `created` says whether the tree changed. */
  ensure(path: string): { id: string; created: boolean } {
    let id = ROOT_ID
    let created = false
    if (path === '') return { id, created }
    for (const name of path.split('/')) {
      let next = this.child(id, name)
      if (!next) {
        next = { id: newFolderId(), name, parent: id }
        this.byId.set(next.id, next)
        created = true
      }
      id = next.id
    }
    return { id, created }
  }

  rename(id: string, name: string): void {
    const node = this.byId.get(id)
    if (node) node.name = name
  }

  remove(ids: string[]): void {
    for (const id of ids) this.byId.delete(id)
  }
}

/** A new folder id: never a path, never reused. */
export function newFolderId(): string {
  return 'f:' + ethers.hexlify(ethers.randomBytes(16)).slice(2)
}
