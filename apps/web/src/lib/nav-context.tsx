'use client'

import { createContext, useContext } from 'react'
import type { Page } from '@/lib/types'

type NavContextValue = {
  navigate: (page: Page) => void
}

export const NavContext = createContext<NavContextValue>({
  navigate: () => {},
})

export function useNav() {
  return useContext(NavContext)
}
