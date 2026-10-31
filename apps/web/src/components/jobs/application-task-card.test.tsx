import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ApplicationTaskView } from './application-task-model'

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
import { ApplicationTaskCard } from './application-task-card'

const task: ApplicationTaskView = { id: 'task_1', jobId: 'job_1', sessionId: 'session_1', company: 'Example', role: 'Engineer', status: 'waiting_for_user', checkpoint: 'form_answer_required', updatedAt: '2026-10-30T10:00:00Z' }

describe('application task card', () => {
  it('routes a question to its original session without embedding another answer form', () => {
    const html = renderToStaticMarkup(<ApplicationTaskCard task={task} />)
    expect(html).toContain('jobs.task.openQuestion')
    expect(html).toContain('href="/?page=agent&amp;sessionId=session_1"')
    expect(html).not.toContain('<input')
    expect(html).not.toContain('<button')
  })

  it('keeps uncertain outcomes distinct and offers no retry or submit action', () => {
    const html = renderToStaticMarkup(<ApplicationTaskCard task={{ ...task, status: 'failed', checkpoint: 'submission_uncertain' }} />)
    expect(html).toContain('jobs.task.unknownHint')
    expect(html).toContain('jobs.task.checkOutcome')
    expect(html).not.toContain('jobs.task.failed')
    expect(html).not.toContain('<button')
  })

  it('does not invent a session when the persisted relationship is unavailable', () => {
    const html = renderToStaticMarkup(<ApplicationTaskCard task={{ ...task, sessionId: null }} />)
    expect(html).toContain('jobs.task.sessionUnavailable')
    expect(html).not.toContain('<a ')
  })

  it('labels authorization as review and leaves decisions in the existing session', () => {
    const html = renderToStaticMarkup(<ApplicationTaskCard task={{ ...task, status: 'waiting_for_authorization', checkpoint: 'form_filled' }} />)
    expect(html).toContain('jobs.task.openReview')
    expect(html).not.toContain('<button')
  })
})
