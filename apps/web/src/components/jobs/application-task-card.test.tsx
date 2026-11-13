import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { unknownApplicationSubmissionEvidence } from '@/lib/agent/application-submission-evidence'
import type { ApplicationTaskView } from './application-task-model'

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ lang: 'en', t: (key: string) => key }) }))
import { ApplicationTaskCard } from './application-task-card'

const task: ApplicationTaskView = { id: 'task_1', jobId: 'job_1', sessionId: 'session_1', company: 'Example', role: 'Engineer', status: 'waiting_for_user', checkpoint: 'form_answer_required', updatedAt: '2026-10-30T10:00:00Z', submissionEvidence: unknownApplicationSubmissionEvidence(false, 'unknown') }

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

  it('shows unavailable session guidance for material review without fabricating a link', () => {
    const html = renderToStaticMarkup(<ApplicationTaskCard task={{ ...task, checkpoint: 'materials_ready', sessionId: null }} />)
    expect(html).toContain('jobs.task.needsMaterialsReview')
    expect(html).toContain('jobs.task.sessionUnavailable')
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('<button')
  })

  it('labels authorization as review and leaves decisions in the existing session', () => {
    const html = renderToStaticMarkup(<ApplicationTaskCard task={{ ...task, status: 'waiting_for_authorization', checkpoint: 'form_filled' }} />)
    expect(html).toContain('jobs.task.openReview')
    expect(html).not.toContain('<button')
  })

  it('renders unavailable evidence as three distinct facts without adding authority', () => {
    const html = renderToStaticMarkup(<ApplicationTaskCard task={{ ...task,
      status: 'submitted', checkpoint: 'submission_verified',
      submissionEvidence: unknownApplicationSubmissionEvidence(true, 'unavailable'),
    }} />)
    expect(html).toContain('Submission details')
    expect(html).toContain('Automation result')
    expect(html).toContain('Employer receipt')
    expect(html).toContain('Not verified')
    expect(html).toContain('Detailed submission evidence is unavailable.')
    expect(html).not.toContain('confirmed')
    expect(html).not.toContain('rejected')
    expect(html).not.toContain('<button')
  })

  it('keeps exact evaluator facts separate and never labels them as employer receipt', () => {
    const html = renderToStaticMarkup(<ApplicationTaskCard task={{ ...task,
      status: 'submitted', checkpoint: 'submission_verified',
      submissionEvidence: { visible: true, availability: 'available', workerReport: 'submitted', localRecord: 'recorded', employerReceipt: 'unverified' },
    }} />)
    expect(html).toMatch(/<dd[^>]*>System recorded a submission<\/dd>/)
    expect(html).toMatch(/<dd[^>]*>Linked<\/dd>/)
    expect(html).toMatch(/<dd[^>]*>Not verified<\/dd>/)
    expect(html).not.toContain('Worker report')
    expect(html).not.toContain('ApplyMate local record')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('retry')
  })
})
