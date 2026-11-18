import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ lang: 'en', t: (key: string) => key }) }))

import { PersonaPanel } from './PersonaPanel'

describe('PersonaPanel discovery consent', () => {
  it('shows the existing sharing disclosure and current-selection estimate context', () => {
    const html = renderToStaticMarkup(<PersonaPanel isDefault onEditResume={vi.fn()} onUseAsProfile={vi.fn()} />)
    expect(html).toContain('Discovery preferences')
    expect(html).toContain('sent to your configured AI model')
    expect(html).toContain('may reuse an existing Session')
    expect(html).toContain('does not authorize applications or other actions')
    expect(html).toContain('Estimate for the currently selected facts if a new discovery snapshot is created')
    expect(html).toContain('does not describe an existing Session snapshot')
  })
})
