// A small Markdown renderer for answers: headings, paragraphs, lists, tables,
// code blocks, inline code, bold/italic and links. Builds React elements —
// never HTML strings — so model output can't inject markup.
import { Fragment, type ReactNode } from 'react'

export type LinkRenderer = (href: string, children: ReactNode, key: number) => ReactNode

function inline(text: string, link: LinkRenderer): ReactNode[] {
  const out: ReactNode[] = []
  // `code` | [text](href) | **bold** | *italic* | _italic_
  const re = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|(?<![\w])_([^_]+)_(?![\w])/g
  let last = 0
  let k = 0
  for (let m; (m = re.exec(text)); ) {
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[1] !== undefined) out.push(<code key={k++}>{m[1]}</code>)
    else if (m[2] !== undefined) out.push(link(m[3], inline(m[2], link), k++))
    else if (m[4] !== undefined) out.push(<strong key={k++}>{inline(m[4], link)}</strong>)
    else out.push(<em key={k++}>{inline(m[5] ?? m[6], link)}</em>)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l)
const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())

export function Markdown({ text, link }: { text: string; link: LinkRenderer }) {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let k = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++])
      i++
      blocks.push(<pre key={k++}><code>{body.join('\n')}</code></pre>)
    } else if (/^#{1,6} /.test(line)) {
      const level = Math.min(4, line.match(/^#+/)![0].length + 1)
      const H = `h${level}` as 'h2' | 'h3' | 'h4'
      blocks.push(<H key={k++}>{inline(line.replace(/^#+ /, ''), link)}</H>)
      i++
    } else if (isTableRow(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]))
      blocks.push(
        <div className="table-wrap" key={k++}>
          <table>
            <thead><tr>{head.map((c, j) => <th key={j}>{inline(c, link)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c, link)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )
    } else if (/^\s*([-*+]|\d+[.)]) /.test(line)) {
      const ordered = /^\s*\d/.test(line)
      const items: string[] = []
      while (i < lines.length && /^\s*([-*+]|\d+[.)]) /.test(lines[i])) {
        let item = lines[i++].replace(/^\s*([-*+]|\d+[.)]) /, '')
        // continuation lines (indented, not a new item)
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)]) /.test(lines[i])) item += ' ' + lines[i++].trim()
        items.push(item)
      }
      const L = ordered ? 'ol' : 'ul'
      blocks.push(<L key={k++}>{items.map((it, j) => <li key={j}>{inline(it, link)}</li>)}</L>)
    } else if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*> ?/, ''))
      blocks.push(<blockquote key={k++}>{inline(body.join(' '), link)}</blockquote>)
    } else if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      blocks.push(<hr key={k++} />)
      i++
    } else if (!line.trim()) {
      i++
    } else {
      const body: string[] = [lines[i++]]
      while (i < lines.length && lines[i].trim() && !/^(\s*```|#{1,6} |\s*([-*+]|\d+[.)]) |\s*>)/.test(lines[i]) && !isTableRow(lines[i])) {
        body.push(lines[i++])
      }
      blocks.push(
        <p key={k++}>
          {body.map((b, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              {inline(b, link)}
            </Fragment>
          ))}
        </p>
      )
    }
  }
  return <>{blocks}</>
}
