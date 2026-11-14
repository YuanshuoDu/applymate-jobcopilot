import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ApplicationAttentionView, ApplicationTaskSummary } from './application-attention-view'
import type { ApplicationTaskView } from './application-task-model'

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
const task = (id: string, status: string): ApplicationTaskView => ({ id, jobId: `job-${id}`, sessionId: `session-${id}`, status, checkpoint: null, company: `Company ${id}`, role: `Role ${id}`, updatedAt: '2026-10-30T01:00:00Z' })
const props = { loading: false, error: null, onOpenJob: vi.fn(), onOpenSession: vi.fn(), onRefresh: vi.fn() }

describe('recent attention view', () => {
  it('shows all supplied pending tasks independently of job-list pagination and discloses coverage', () => {
    const html = renderToStaticMarkup(<ApplicationAttentionView {...props} tasks={[task('outside-page', 'waiting_for_user'), task('other', 'waiting_for_authorization'), task('working', 'filling')]} />)
    expect(html).toContain('Company outside-page')
    expect(html).toContain('Company other')
    expect(html).not.toContain('Company working')
    expect(html).toContain('sessionId=session-outside-page')
    expect(html).toContain('highlight=job-outside-page')
    expect(html).toContain('application.taskCoverage')
  })
  it('does not show an empty-success state while the task query is unavailable', () => {
    const html = renderToStaticMarkup(<ApplicationAttentionView {...props} tasks={[]} error="unavailable" />)
    expect(html).toContain('application.attentionUnavailable')
    expect(html).not.toContain('application.recentAttentionEmpty')
  })
  it('explains unknown outcomes and links the original task rather than offering submission', () => {
    const html = renderToStaticMarkup(<ApplicationTaskSummary task={task('uncertain', 'unknown')} onOpenSession={vi.fn()} />)
    expect(html).toContain('jobs.task.unknown')
    expect(html).toContain('jobs.task.unknownHint')
    expect(html).toContain('jobs.task.checkOutcome')
    expect(html).not.toContain('application.prepareMaterials')
  })
})
