'use client'

import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react'

export type ThemeMode = 'light' | 'dark' | 'system'
export type Theme     = 'light' | 'dark'

interface ThemeCtx {
  theme:   Theme      // resolved (actual applied) theme
  mode:    ThemeMode  // stored user preference
  setMode: (m: ThemeMode) => void
}

const ThemeContext = createContext<ThemeCtx>({
  theme:   'light',
  mode:    'system',
  setMode: () => {},
})

export function useTheme() {
  return useContext(ThemeContext)
}

function getSystemTheme(): Theme {
  return (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches)
    ? 'dark' : 'light'
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('system')
  const [systemTheme, setSystemTheme] = useState<Theme>('light')

  // On mount: read stored mode + current system preference
  useEffect(() => {
    const stored = localStorage.getItem('applymate-theme-mode') as ThemeMode | null
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      setModeState(stored)
    }
    setSystemTheme(getSystemTheme())

    // Watch system preference changes
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => setSystemTheme(e.matches ? 'dark' : 'light')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const theme: Theme = mode === 'system' ? systemTheme : mode

  // Apply to <html>
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'dark') {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
  }, [theme])

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m)
    try { localStorage.setItem('applymate-theme-mode', m) } catch {}
  }, [])

  const value = useMemo(() => ({ theme, mode, setMode }), [theme, mode, setMode])

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  )
}
