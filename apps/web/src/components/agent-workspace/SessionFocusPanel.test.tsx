import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formAnswerDraftKey, RetryCancelledApplicationFillButton, SessionFocusPanel } from './SessionFocusPanel'
import type { AgentSessionDetail } from './session-view-model'

const mocks = vi.hoisted(() => ({ useApi: vi.fn(), formQuestionFields: vi.fn() }))
vi.mock('@/lib/hooks', () => ({ useApi: mocks.useApi }))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/lib/agent/application-task-input', () => ({ formQuestionFields: mocks.formQuestionFields }))

type ApplicationTask = {
  id: string
  status: string
  checkpoint: string | null
  error: string | null
  question: unknown
  job: { company: string; role: string }
}

function installSession(applicationTasks: ApplicationTask[]) {
  const session = {
    id: 'session_1', goal: 'Fill application', status: 'completed', source: 'user', memorySummary: '',
    qualityScore: null, currentTaskId: null, createdAt: '2026-10-15T10:00:00.000Z', updatedAt: '2026-10-15T10:00:00.000Z', completedAt: null,
    tasks: [], approvals: [], applicationTasks, execution: null, questions: [],
  } as unknown as AgentSessionDetail
  mocks.useApi.mockReturnValue({ data: { session }, loading: false, error: null, refetch: vi.fn() })
}

function task(status = 'cancelled', checkpoint: string | null = 'cancelled_by_user'): ApplicationTask {
  return { id: 'application_1', status, checkpoint, error: null, question: null, job: { company: 'Example', role: 'Engineer' } }
}

describe('SessionFocusPanel application fill retry', () => {
  beforeEach(() => {
    mocks.useApi.mockReset()
    mocks.formQuestionFields.mockReset().mockReturnValue([])
  })
  afterEach(() => vi.unstubAllGlobals())

  it('shows the retry button for user-cancelled and safely stopped fill tasks only', () => {
    installSession([task()])
    expect(renderToStaticMarkup(<SessionFocusPanel sessionId="session_1" />)).toContain('Retry form fill')

    installSession([task('cancelled', 'turn_stopped_before_submit')])
    expect(renderToStaticMarkup(<SessionFocusPanel sessionId="session_1" />)).toContain('Retry form fill')
    installSession([task('cancelled', 'worker_failed')])
    expect(renderToStaticMarkup(<SessionFocusPanel sessionId="session_1" />)).not.toContain('Retry form fill')
    installSession([task('failed', 'cancelled_by_user')])
    expect(renderToStaticMarkup(<SessionFocusPanel sessionId="session_1" />)).not.toContain('Retry form fill')
  })

  it('posts one explicit retry with a fresh request ID only when its button is clicked', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false })
    const randomUUID = vi.fn().mockReturnValue('retry_request_12345678')
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('crypto', { randomUUID })
    const button = RetryCancelledApplicationFillButton({ sessionId: 'session_1', taskId: 'application_1' })

    await button.props.onClick({} as React.MouseEvent<HTMLButtonElement>)

    expect(randomUUID).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith('/api/agent/sessions/session_1/actions', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'retry_application_fill', applicationTaskId: 'application_1', requestId: 'retry_request_12345678' }),
    }))
  })

  it('does not dispatch a retry just by rendering the user-cancelled task', () => {
    const fetchMock = vi.fn()
    const randomUUID = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('crypto', { randomUUID })
    installSession([task()])

    expect(renderToStaticMarkup(<SessionFocusPanel sessionId="session_1" />)).toContain('Retry form fill')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(randomUUID).not.toHaveBeenCalled()
  })

  it('uses stable field keys for answers and safe labels for display', () => {
    const validKey = `form-answer-v2-${'a'.repeat(64)}`
    mocks.formQuestionFields.mockReturnValue([{ key: validKey, label: 'Work authorization' }, { key: null, label: 'Unmapped field' }])
    installSession([{ ...task('waiting_for_user', 'form_answer_required'), question: { waitId: 'wait_1' } }])

    const html = renderToStaticMarkup(<SessionFocusPanel sessionId="session_1" />)

    expect(html).toContain(`name="${validKey}"`)
    expect(html).toContain('placeholder="Work authorization"')
    expect(html).toContain('Unmapped field')
    expect(html).not.toContain('name="Unmapped field"')
    expect(formAnswerDraftKey('application_1', 'wait_1', validKey)).toBe(`application_1:wait_1:${validKey}`)
  })
})
