'use client'

import { createContext, useContext } from 'react'
import type { Page } from '@/lib/types'

type NavContextValue = {
  navigate: (page: Page) => void | boolean | Promise<boolean>
  registerNavigationGuard?: (guard: NavigationGuard) => () => void
}

export type NavigationGuard = {
  needsSave: () => boolean
  save: () => Promise<boolean>
  currentHref: () => string
}

export const NavContext = createContext<NavContextValue>({
  navigate: () => {},
})

export function useNav() {
  return useContext(NavContext)
}
