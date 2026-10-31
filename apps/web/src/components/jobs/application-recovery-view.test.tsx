import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
import { ApplicationRecoveryView } from './application-recovery-view'

describe('resume recovery screen', () => {
  it('does not render private data on the signed-out screen', () => {
    const html = renderToStaticMarkup(<ApplicationRecoveryView draft={null} />)
    expect(html).toContain('resume.recoverySignIn')
    expect(html).not.toContain('recovery-draft')
  })
})
