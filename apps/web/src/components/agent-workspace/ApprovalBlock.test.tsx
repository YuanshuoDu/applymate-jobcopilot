import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n'
import { ApprovalBlock } from './ApprovalBlock'

const scope = {
  sessionId: 'session-1', turnId: 'turn-1', jobId: 'job-1', toolCallId: 'call-1', action: 'submit_application',
  resourceHash: 'resource-hash', materialHash: 'material-hash', answersHash: 'answers-hash', scopeHash: 'scope-hash', revision: 3,
  expiresAt: '2099-01-01T00:00:00.000Z',
}

function event(data: unknown) {
  return { id: 'event-1', taskId: 'task-1', type: 'approval_request', speaker: 'Orchestrator', title: 'Submit application', body: 'Review before submitting.', data, durationMs: null, createdAt: '2026-09-03T00:00:00.000Z' }
}

function render(data: unknown, onAction = vi.fn()) {
  return renderToStaticMarkup(<I18nProvider><ApprovalBlock event={event(data)} border="#d9e2ec" onAction={onAction} /></I18nProvider>)
}

describe('ApprovalBlock', () => {
  it('shows scoped impact, hashes, and actions for a live pending approval', () => {
    const html = render({ approval: { id: 'approval-1', status: 'pending', scope } })
    expect(html).toContain('Approval scope and version')
    expect(html).toContain('turn-1')
    expect(html).toContain('resource-hash')
    expect(html).toContain('Approve')
  })

  it('makes answered and cross-turn approvals read-only', () => {
    const answered = render({ approval: { id: 'approval-1', status: 'approved', scope } })
    expect(answered).toContain('Decision already recorded')
    expect(answered).not.toContain('Approve')
    const stale = render({ turnId: 'turn-2', approval: { id: 'approval-1', status: 'pending', scope } })
    expect(stale).toContain('another Turn')
    expect(stale).not.toContain('Approve')
  })

  it('does not offer an action when scope data is missing', () => {
    const html = render({ approval: { id: 'approval-1', status: 'pending' } })
    expect(html).toContain('scope is unavailable')
    expect(html).not.toContain('Approve')
  })
})
