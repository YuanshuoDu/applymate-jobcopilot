'use client'

import { SessionProvider } from 'next-auth/react'
import { ThemeProvider }   from '@/components/ThemeProvider'
import { ToastProvider }   from '@/components/ui'
import { I18nProvider }    from '@/lib/i18n'

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <I18nProvider>
        <ThemeProvider>
          <ToastProvider>{children}</ToastProvider>
        </ThemeProvider>
      </I18nProvider>
    </SessionProvider>
  )
}
