'use client'

import { createContext, useContext } from 'react'
import type { Page } from '@/lib/types'
import type { RecoveryDraft } from '@/lib/application-recovery-draft'

type NavContextValue = {
  navigate: (page: Page) => void | boolean | Promise<boolean>
  registerNavigationGuard?: (guard: NavigationGuard) => () => void
  prepareToLeave?: () => Promise<boolean>
  signOutSafely?: () => Promise<boolean>
  publishRecoveryDraft?: (userId: string, draft: RecoveryDraft | null) => void
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
