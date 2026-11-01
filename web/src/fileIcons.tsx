// File-type icons for files without a preview (photos, videos and SVGs show
// their thumbnails instead). Each file belongs to a family with a colour
// and a symbol; the grid's large icon also prints the extension on a strip
// across the bottom ("PDF", "DOCX", "PPTX"), the way desktop file managers
// do. The list's small icon is too small for text: a tinted square with the
// family's symbol. Colours read on both themes.

export type FileFamily =
  | 'pdf'
  | 'doc'
  | 'sheet'
  | 'slides'
  | 'text'
  | 'code'
  | 'archive'
  | 'image'
  | 'video'
  | 'audio'
  | 'ebook'
  | 'design'
  | 'font'
  | 'app'
  | 'generic'

interface FamilyStyle {
  color: string
  /** the strip's text: white, or dark on the light amber */
  ink: string
  /** symbol on a 24 × 24 grid, stroked */
  glyph: string
}

const WHITE = '#ffffff'

export const FAMILIES: Record<FileFamily, FamilyStyle> = {
  pdf: { color: '#ef4444', ink: WHITE, glyph: 'M7 8h10M7 12h10M7 16h6' },
  doc: { color: '#3b82f6', ink: WHITE, glyph: 'M6 7h12M6 11h12M6 15h12M6 19h7' },
  sheet: { color: '#22c55e', ink: WHITE, glyph: 'M5 5h14v14H5zM5 10h14M5 14.5h14M10 5v14' },
  slides: { color: '#f97316', ink: WHITE, glyph: 'M4 5h16v10H4zM12 15v4M8 19h8M8 12l3-3 2 2 3-3' },
  text: { color: '#94a3b8', ink: WHITE, glyph: 'M6 7h12M6 11h12M6 15h9' },
  code: { color: '#64748b', ink: WHITE, glyph: 'M9 7l-5 5 5 5M15 7l5 5-5 5' },
  archive: { color: '#f59e0b', ink: '#1f1300', glyph: 'M12 3v2M12 7v2M12 11v2M10 15h4v4h-4z' },
  image: { color: '#14b8a6', ink: WHITE, glyph: 'M4 18l5-6 4 4 3-3 4 5M15.5 7.5a1.5 1.5 0 1 0 .01 0' },
  video: { color: '#a855f7', ink: WHITE, glyph: 'M8 6l10 6-10 6z' },
  audio: {
    color: '#ec4899',
    ink: WHITE,
    glyph: 'M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
  },
  ebook: { color: '#b45309', ink: WHITE, glyph: 'M12 6c-2-1.5-5-2-8-2v14c3 0 6 .5 8 2 2-1.5 5-2 8-2V4c-3 0-6 .5-8 2zM12 6v14' },
  design: { color: '#d946ef', ink: WHITE, glyph: 'M4 20l4-1 11-11-3-3L5 16zM14 6l3 3' },
  font: { color: '#6366f1', ink: WHITE, glyph: 'M6 19L11 5l5 14M8 14h6' },
  app: { color: '#0ea5e9', ink: WHITE, glyph: 'M4 8l8-4 8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8' },
  generic: { color: '#8b98a5', ink: WHITE, glyph: 'M7 10h10M7 14h10' },
}

const BY_EXT: Record<string, FileFamily> = {}
const add = (family: FileFamily, exts: string) => exts.split(' ').forEach((e) => (BY_EXT[e] = family))
add('pdf', 'pdf')
add('doc', 'doc docx odt pages rtf wpd')
add('sheet', 'xls xlsx xlsm ods csv tsv numbers')
add('slides', 'ppt pptx pps ppsx odp key')
add('text', 'txt md markdown log rst')
add(
  'code',
  'js mjs cjs ts tsx jsx py rb rs go java kt swift c h cc cpp hpp cs php sh bash zsh ps1 sql html htm css scss less json yml yaml toml xml ini sol vue svelte ipynb'
)
add('archive', 'zip rar 7z tar gz tgz bz2 xz zst')
add('image', 'jpg jpeg png gif webp bmp tif tiff heic heif avif svg ico raw cr2 nef arw dng')
add('video', 'mp4 mov m4v mkv webm avi wmv flv 3gp')
add('audio', 'mp3 wav flac aac m4a ogg opus wma aiff mid midi')
add('ebook', 'epub mobi azw azw3 fb2 djvu')
add('design', 'psd ai sketch fig xd indd afdesign afphoto blend')
add('font', 'ttf otf woff woff2 eot')
add('app', 'dmg pkg exe msi apk ipa deb rpm appimage iso')

function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** A file's family: by extension first, then by its stored type. */
export function fileFamily(meta: { mime: string; name: string }): FileFamily {
  const byExt = BY_EXT[extOf(meta.name)]
  if (byExt) return byExt
  const m = meta.mime.toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  if (m.startsWith('font/')) return 'font'
  if (m === 'application/pdf') return 'pdf'
  if (m.includes('presentation')) return 'slides'
  if (m.includes('spreadsheet') || m.includes('excel')) return 'sheet'
  if (m.includes('wordprocessing') || m.includes('msword') || m.includes('opendocument.text')) return 'doc'
  if (m.includes('epub')) return 'ebook'
  if (m.includes('zip') || m.includes('compressed') || m.includes('x-tar') || m.includes('gzip')) return 'archive'
  if (m.includes('json') || m.includes('javascript') || m.includes('xml')) return 'code'
  if (m.startsWith('text/')) return 'text'
  return 'generic'
}

/** The strip's text: the extension in capitals, at most 4 letters ("FILE" without one). */
export function fileLabel(name: string): string {
  return (extOf(name) || 'file').slice(0, 4).toUpperCase()
}

export function FileIcon({ meta, large = false }: { meta: { mime: string; name: string }; large?: boolean }) {
  const family = fileFamily(meta)
  const { color, ink, glyph } = FAMILIES[family]
  if (!large) {
    return (
      <svg className="ficon" viewBox="0 0 24 24" aria-hidden="true" data-family={family}>
        <rect x="1.5" y="1.5" width="21" height="21" rx="5" fill={color} fillOpacity="0.18" />
        <g transform="translate(4.8 4.8) scale(0.6)">
          <path d={glyph} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      </svg>
    )
  }
  const label = fileLabel(meta.name)
  return (
    <svg className="ficon" viewBox="0 0 40 48" aria-hidden="true" data-family={family} data-label={label}>
      <path
        d="M7 2h19l10 10v32a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"
        fill={color}
        fillOpacity="0.12"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M26 2v8a2 2 0 0 0 2 2h8" fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
      <g transform="translate(12.5 11) scale(0.625)">
        <path d={glyph} fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <rect x="5" y="32" width="31" height="11" rx="2" fill={color} />
      <text
        x="20.5"
        y="40.3"
        textAnchor="middle"
        fontSize={label.length > 3 ? 6.6 : 8.4}
        fontWeight="700"
        fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
        letterSpacing={label.length > 3 ? 0 : 0.3}
        fill={ink}
      >
        {label}
      </text>
    </svg>
  )
}
