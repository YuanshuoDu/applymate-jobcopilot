import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ApplicationProgress } from './application-progress'
import type { ApplicationTaskView } from './application-task-model'

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
describe('application progress evidence', () => {
  it('does not mark submission complete when materials passed their check', () => {
    const html = renderToStaticMarkup(<ApplicationProgress hasMaterials checked recorded={false} />)
    expect(html.match(/application.recordAvailable/g)).toHaveLength(2)
    expect(html).toContain('application.notComplete')
  })
  it('preserves an uncertain outcome even when a lifecycle record says submitted', () => {
    const task = { status: 'unknown', checkpoint: 'submission_uncertain' } as ApplicationTaskView
    const html = renderToStaticMarkup(<ApplicationProgress hasMaterials checked recorded task={task} />)
    expect(html.match(/application.recordAvailable/g)).toHaveLength(2)
  })
})
