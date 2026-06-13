'use client'

import { SessionProvider } from 'next-auth/react'
import { ThemeProvider }   from '@/components/ThemeProvider'
import { I18nProvider }    from '@/lib/i18n'

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <I18nProvider>
        <ThemeProvider>{children}</ThemeProvider>
      </I18nProvider>
    </SessionProvider>
  )
}
