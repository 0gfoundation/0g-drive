// One outline icon set, drawn inline (nothing loads): 24-unit paths,
// stroked in the text color. Use these instead of emoji or symbol glyphs,
// which look different on every platform.

const PATHS = {
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  share: 'M15 5l5 5-5 5M20 10H10a6 6 0 00-6 6v3',
  trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13',
  restore: 'M4 12a8 8 0 108-8 8 8 0 00-6 2.7M4 4v4h4',
  close: 'M6 6l12 12M18 6L6 18',
  rename: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  move: 'M3 6h6l2 2h10v11H3zM10 14h7M14 11l3 3-3 3',
  plus: 'M12 5v14M5 12h14',
  folderPlus: 'M3 6h6l2 2h10v11H3zM12 11v5M9.5 13.5h5',
  sync: 'M20 11a8 8 0 00-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0014.3 4.9L20 16M20 20v-4h-4',
  sparkles: 'M11 3l1.8 4.6L17.4 9.4l-4.6 1.8L11 15.8l-1.8-4.6L4.6 9.4l4.6-1.8zM18.5 14.5l.8 2 2 .7-2 .8-.8 2-.7-2-2-.8 2-.7z',
  alert: 'M12 3.5l9 16H3zM12 10v4M12 17h.01',
  file: 'M14 3H6v18h12V7zM14 3v4h4',
  chevron: 'M9 6l6 6-6 6',
  clock: 'M12 3a9 9 0 110 18 9 9 0 010-18zM12 7v5l3 2',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  play: 'M8 5.5v13l10.5-6.5z',
  sun: 'M12 8a4 4 0 110 8 4 4 0 010-8zM12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4',
  moon: 'M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z',
  tag: 'M3.5 12.5V4h8.5l8.5 8.5-8 8zM8 8.5h.01',
  minus: 'M5 12h14',
} as const

export type IconName = keyof typeof PATHS

/** An icon at the text's size (1em) unless the class sizes it; decorative (the button or text names it). */
export function Icon({ name, className = 'ico' }: { name: IconName; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  )
}
