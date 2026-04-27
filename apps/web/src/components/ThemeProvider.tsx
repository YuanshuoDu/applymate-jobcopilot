'use client'

import React, { createContext, useContext, useEffect, useState } from 'react'

type Theme = 'light' | 'dark'

interface ThemeCtx {
  theme: Theme
  toggle: () => void
}

const ThemeContext = createContext<ThemeCtx>({ theme: 'light', toggle: () => {} })

export function useTheme() {
  return useContext(ThemeContext)
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>('light')

  // On mount, read from localStorage or system preference
  useEffect(() => {
    const stored = localStorage.getItem('applymate-theme') as Theme | null
    if (stored === 'dark' || stored === 'light') {
      setTheme(stored)
      return
    }
    // Fall back to system preference
    if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
      setTheme('dark')
    }
  }, [])

  // Sync to <html> class and localStorage
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'dark') {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
    localStorage.setItem('applymate-theme', theme)
  }, [theme])

  const toggle = () => setTheme(t => t === 'light' ? 'dark' : 'light')

  return (
    <ThemeContext.Provider value={{ theme, toggle }}>
      {children}
    </ThemeContext.Provider>
  )
}
