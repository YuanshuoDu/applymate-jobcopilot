import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }))

import { SelectedJobPreparationCard } from './SelectedJobPreparationCard'

describe('SelectedJobPreparationCard', () => {
  it('clearly limits the action to one saved job and draft preparation', () => {
    const html = renderToStaticMarkup(<SelectedJobPreparationCard sessionId="session-1" onAccepted={vi.fn()} />)
    expect(html).toContain('data-selected-job-preparation="true"')
    expect(html).toContain('Prepare a draft for one job')
    expect(html).toContain('will not submit an application or contact the employer')
    expect(html).toContain('disabled=""')
  })
})
