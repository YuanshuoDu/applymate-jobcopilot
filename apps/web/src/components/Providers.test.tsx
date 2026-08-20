import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

vi.mock('next-auth/react', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}))

vi.mock('@/components/ThemeProvider', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}))

vi.mock('@/lib/i18n', () => ({
  I18nProvider: ({ children }: { children: React.ReactNode }) => children,
  useI18n: () => ({ lang: 'en', t: (key: string) => key, setLang: () => {} }),
}))

import { Providers } from './Providers'
import { useToast } from './ui'

function ToastConsumer() {
  useToast()
  return <span>toast-ready</span>
}

describe('Providers', () => {
  it('provides toast actions to standalone App Router pages', () => {
    expect(() => renderToStaticMarkup(
      <Providers>
        <ToastConsumer />
      </Providers>,
    )).not.toThrow()
  })
})
