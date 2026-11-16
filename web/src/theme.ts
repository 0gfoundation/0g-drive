import { useCallback, useEffect, useState } from 'react'

// Light or dark: the one chosen with the header's switch (kept per
// browser), else the system's. Applied as <html data-theme>, which picks
// the palette in style.css; index.html applies it before the page draws,
// so a light page never flashes dark.

export type Theme = 'light' | 'dark'

const KEY = '0gdrive:theme'
const SYSTEM_LIGHT = '(prefers-color-scheme: light)'
/** the browser's bar color for each, as the page background */
const BAR: Record<Theme, string> = { dark: '#0a0a0c', light: '#f6f6f8' }

function chosen(): Theme | null {
  try {
    const t = localStorage.getItem(KEY)
    return t === 'light' || t === 'dark' ? t : null
  } catch {
    return null // storage blocked: the system's
  }
}

const system = (): Theme => (matchMedia(SYSTEM_LIGHT).matches ? 'light' : 'dark')

/** The theme the page shows now. */
export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

function apply(t: Theme) {
  document.documentElement.dataset.theme = t
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BAR[t])
}

/** The theme shown, and a switch to the other one (remembered in this browser). */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => chosen() ?? system())
  useEffect(() => apply(theme), [theme])
  // no choice made: follow the system as it changes
  useEffect(() => {
    const mq = matchMedia(SYSTEM_LIGHT)
    const follow = () => chosen() === null && setTheme(system())
    mq.addEventListener('change', follow)
    return () => mq.removeEventListener('change', follow)
  }, [])
  const toggle = useCallback(() => {
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark'
      try {
        localStorage.setItem(KEY, next)
      } catch {
        // storage blocked: this visit only
      }
      return next
    })
  }, [])
  return [theme, toggle]
}
