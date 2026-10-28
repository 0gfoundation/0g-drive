// The assistant's tools. All read-only: search and read the knowledge, ask
// the drive for on/off facts, or point at a control on the drive page.
import { search, readText, findFiles, type Scope } from './knowledge'
import { getDriveStatus, showInDrive, SHOW_TARGETS, type ShowTarget } from './bridge'

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description:
        'Keyword search over the 0GDrive user guide, 0GDrive design docs and source code, all of docs.0g.ai, and the 0G TypeScript storage SDK source. Returns matching excerpts with their path and line range. Use English keywords and identifiers; run several searches with different wording when unsure.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'keywords, e.g. "recovery password read-only" or "uploadBatch finality"' },
          scope: {
            type: 'string',
            enum: ['all', 'guide', '0gdrive', '0g-docs', 'code'],
            description: 'guide = 0GDrive user guide; 0gdrive = its guide, docs and source; 0g-docs = docs.0g.ai; code = source code only. Default all.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_source',
      description:
        'Read a document or source file by path (as returned by search_knowledge or find_files), with line numbers. Read only the lines you need: every line read is paid for again in each later step. Files of other 0G repos (github:0gfoundation/...) are fetched at a pinned commit.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'e.g. "0gdrive:core/src/recovery.ts", "docs:developer-hub/building-on-0g/storage/sdk.md", "github:0gfoundation/0g-storage-contracts/contracts/dataFlow/Flow.sol"' },
          start_line: { type: 'integer', description: 'first line, 1-based (default 1)' },
          end_line: { type: 'integer', description: 'last line (default start_line + 99; at most 150 lines per call)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description:
        'Find file paths whose path contains all the given words, across 0GDrive, docs.0g.ai and the 0G repos (0g-storage-ts-sdk, 0g-storage-client (Go), 0g-storage-node (Rust), 0g-storage-kv (Rust), 0g-storage-contracts (Solidity)).',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'path words, e.g. "flow sol" or "kv client"' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'drive_status',
      description:
        "This user's 0GDrive state as on/off facts: wallet connected, drive open, read-only, recovery / password / share key status, on-device AI, uploading, low balance. Contains no addresses, file names or keys. Use it for questions about the user's own setup (\"is my drive backed up?\", \"why can't I…\").",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_in_drive',
      description:
        'Highlight a control on the drive page so the user can find it (scrolls to it and makes it pulse). Use when the user asks where something is or how to do something in the app. Read-only: it never clicks anything.',
      parameters: {
        type: 'object',
        properties: { target: { type: 'string', enum: [...SHOW_TARGETS] } },
        required: ['target'],
      },
    },
  },
]

/** what a tool call is doing, for the activity line */
export function describe(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'search_knowledge':
      return `Searched “${args.query}”${args.scope && args.scope !== 'all' ? ` in ${args.scope}` : ''}`
    case 'read_source':
      return `Read ${String(args.path).replace(/^\w+:/, '')}${args.start_line ? ` from line ${args.start_line}` : ''}`
    case 'find_files':
      return `Looked for files “${args.query}”`
    case 'drive_status':
      return 'Checked your drive’s status'
    case 'show_in_drive':
      return `Pointed at ${String(args.target).replace(/-/g, ' ')} in the drive`
    default:
      return name
  }
}

const MAX_RESULT = 7000

export async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case 'search_knowledge': {
        const hits = await search(String(args.query ?? ''), (args.scope as Scope) ?? 'all')
        if (!hits.length) return 'No matches. Try other keywords or another scope.'
        return hits.map((h) => `### ${h.path} (lines ${h.lines}) — ${h.title}\n${h.text}`).join('\n\n').slice(0, MAX_RESULT)
      }
      case 'read_source': {
        const path = String(args.path ?? '')
        const { text } = await readText(path)
        const lines = text.split('\n')
        const start = Math.max(1, Number(args.start_line) || 1)
        const end = Math.min(lines.length, Number(args.end_line) || start + 99, start + 149)
        const body = lines
          .slice(start - 1, end)
          .map((l, i) => `${start + i}: ${l}`)
          .join('\n')
        const more = end < lines.length ? `\n[… ${lines.length - end} more lines; total ${lines.length}]` : ''
        return `${path} lines ${start}-${end} of ${lines.length}\n${body}`.slice(0, MAX_RESULT * 2) + more
      }
      case 'find_files': {
        const { matches, total } = await findFiles(String(args.query ?? ''))
        if (!total) return 'No paths match. Try fewer or shorter words.'
        return matches.join('\n') + (total > matches.length ? `\n[… ${total - matches.length} more; add words to narrow]` : '')
      }
      case 'drive_status': {
        const s = await getDriveStatus()
        return s ? JSON.stringify(s) : 'Not available: the assistant is not open inside the drive page.'
      }
      case 'show_in_drive': {
        const r = await showInDrive(args.target as ShowTarget)
        if (!r) return 'Not available: the assistant is not open inside the drive page.'
        return r.shown ? `Highlighted ${args.target} on the drive page.` : `Couldn't show it: ${r.reason ?? 'not on this screen'}.`
      }
      default:
        return `Unknown tool ${name}`
    }
  } catch (e) {
    return `Error: ${(e as Error).message}`
  }
}
