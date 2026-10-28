import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formAnswerDraftKey, needsApplicationFillRetryPolling, RetryApplicationFillButton, SessionFocusPanel, startApplicationFillRetryPolling } from './SessionFocusPanel'
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

function installSession(applicationTasks: ApplicationTask[], retryTasks?: Array<{ id: string; cancelledFillRetryReady: boolean }>, retryLoading = false, overrides: Partial<AgentSessionDetail> = {}) {
  const session = {
    id: 'session_1', goal: 'Fill application', status: 'completed', source: 'user', memorySummary: '',
    qualityScore: null, currentTaskId: null, createdAt: '2026-10-15T10:00:00.000Z', updatedAt: '2026-10-15T10:00:00.000Z', completedAt: null,
    tasks: [], approvals: [], applicationTasks, execution: null, questions: [], ...overrides,
  } as unknown as AgentSessionDetail
  const readiness = retryTasks ?? applicationTasks.map(item => ({ id: item.id, cancelledFillRetryReady: true }))
  mocks.useApi.mockImplementation((url: string) => url.includes('projection=cancelled-fill-retry')
    ? { data: retryLoading ? null : { tasks: readiness }, loading: retryLoading, error: null, refetch: vi.fn() }
    : { data: { session }, loading: false, error: null, refetch: vi.fn() })
}

function task(status = 'cancelled', checkpoint: string | null = 'cancelled_by_user'): ApplicationTask {
  return { id: 'application_1', status, checkpoint, error: null, question: null, job: { company: 'Example', role: 'Engineer' } }
}

describe('SessionFocusPanel application fill retry', () => {
  beforeEach(() => {
    mocks.useApi.mockReset()
    mocks.formQuestionFields.mockReset().mockReturnValue([])
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks() })

  it('polls while any retryable TaskGraph fill checkpoint is not ready', () => {
    expect(needsApplicationFillRetryPolling([task()], [], false)).toBe(true)
    expect(needsApplicationFillRetryPolling([task()], [{ id: 'application_1', cancelledFillRetryReady: true }], false)).toBe(false)
    expect(needsApplicationFillRetryPolling([task()], undefined, true)).toBe(false)
    expect(needsApplicationFillRetryPolling([task('cancelled', 'turn_stopped_before_submit')], [], false)).toBe(true)
    expect(needsApplicationFillRetryPolling([task('failed', 'fill_prestart_failed')], [], false)).toBe(true)
    expect(needsApplicationFillRetryPolling([task('failed', 'worker_failed')], [], false)).toBe(false)
  })

  it('cleans up the readiness poll and does not poll when disabled', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const stop = startApplicationFillRetryPolling(true, refresh)
    vi.advanceTimersByTime(20_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    stop()
    vi.advanceTimersByTime(20_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    const stopDisabled = startApplicationFillRetryPolling(false, refresh)
    vi.advanceTimersByTime(20_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    stopDisabled()
  })

  it.each([
    ['read is loading', [{ id: 'application_1', cancelledFillRetryReady: true }], true],
    ['read is missing the task', [], false],
    ['server says not ready', [{ id: 'application_1', cancelledFillRetryReady: false }], false],
  ])('hides retry while readiness %s', (_state, retryTasks, retryLoading) => {
    installSession([task()], retryTasks, retryLoading)

    const html = renderToStaticMarkup(<SessionFocusPanel sessionId="session_1" />)

    expect(html).not.toContain('Retry form fill')
    expect(mocks.useApi).toHaveBeenCalledWith(expect.stringContaining('projection=cancelled-fill-retry'), { cache: false, enabled: true })
  })

  it('does not request retry readiness when the session has no retryable application fill', () => {
    installSession([task('failed', 'worker_failed')])

    renderToStaticMarkup(<SessionFocusPanel sessionId="session_1" />)

    expect(mocks.useApi).toHaveBeenCalledWith(expect.stringContaining('projection=cancelled-fill-retry'), { cache: false, enabled: false })
  })

  it.each([
    ['cancelled', 'cancelled_by_user'],
    ['cancelled', 'turn_stopped_before_submit'],
    ['failed', 'fill_prestart_failed'],
    ['failed', 'taskgraph_fill_failed'],
  ])('shows the retry button for %s / %s', (status, checkpoint) => {
    installSession([task(status, checkpoint)])
    expect(renderToStaticMarkup(<SessionFocusPanel sessionId="session_1" />)).toContain('Retry form fill')
  })

  it.each([
    ['cancelled', 'worker_failed'],
    ['failed', 'cancelled_by_user'],
    ['failed', 'fill_outcome_uncertain'],
    ['waiting_for_user', 'fill_outcome_uncertain'],
    ['filling', 'taskgraph_fill_queued'],
  ])('hides the retry button for unsupported %s / %s states', (status, checkpoint) => {
    installSession([task(status, checkpoint)])
    expect(renderToStaticMarkup(<SessionFocusPanel sessionId="session_1" />)).not.toContain('Retry form fill')
  })

  it('shows submission recovery only for the uncertain waiting task', () => {
    installSession([task('waiting_for_user', 'submission_uncertain')])
    expect(renderToStaticMarkup(<SessionFocusPanel sessionId="session_1" />)).toContain('Confirm and start fresh fill for review')
  })

  it.each([
    ['waiting_for_user', 'form_answer_required'],
    ['filling', 'submission_uncertain'],
    ['failed', 'submission_uncertain'],
  ])('hides submission recovery for other %s / %s states', (status, checkpoint) => {
    installSession([task(status, checkpoint)])
    expect(renderToStaticMarkup(<SessionFocusPanel sessionId="session_1" />)).not.toContain('Confirm and start fresh fill for review')
  })

  it('posts one explicit retry and refreshes only after success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 })
    const randomUUID = vi.fn().mockReturnValue('retry_request_12345678')
    const dispatchEvent = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('crypto', { randomUUID })
    vi.stubGlobal('window', { dispatchEvent })
    const element = RetryApplicationFillButton({ sessionId: 'session_1', taskId: 'application_1' }) as React.ReactElement<{ children: React.ReactNode }>
    const [button, alert] = React.Children.toArray(element.props.children) as React.ReactElement[]
    await (button!.props as { onClick: (event: React.MouseEvent<HTMLButtonElement>) => Promise<void> }).onClick({ currentTarget: { nextElementSibling: { textContent: '' } } } as unknown as React.MouseEvent<HTMLButtonElement>)

    expect(randomUUID).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith('/api/agent/sessions/session_1/actions', expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'retry_application_fill', applicationTaskId: 'application_1', requestId: 'retry_request_12345678' }),
    }))
    expect((alert!.props as { role?: string; 'aria-live'?: string })).toMatchObject({ role: 'alert', 'aria-live': 'assertive' })
    expect(dispatchEvent).toHaveBeenCalledOnce()
  })

  it.each([
    ['server rejection', async () => ({ ok: false, status: 409 }), 'Retry rejected by the server (HTTP 409). Refresh and try again.'],
    ['network failure', async () => { throw new Error('offline') }, 'Could not retry the form fill. Check your connection and try again.'],
  ])('announces %s in the alert region without dispatching success', async (_reason, respond, expectedMessage) => {
    const fetchMock = vi.fn().mockImplementation(respond)
    const dispatchEvent = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValue('retry_request_12345678') })
    vi.stubGlobal('window', { dispatchEvent })
    const element = RetryApplicationFillButton({ sessionId: 'session_1', taskId: 'application_1' }) as React.ReactElement<{ children: React.ReactNode }>
    const [button, alert] = React.Children.toArray(element.props.children) as React.ReactElement[]
    const feedback = { textContent: '' }
    await (button!.props as { onClick: (event: React.MouseEvent<HTMLButtonElement>) => Promise<void> }).onClick({ currentTarget: { nextElementSibling: feedback } } as unknown as React.MouseEvent<HTMLButtonElement>)

    expect((alert!.props as { role?: string; 'aria-live'?: string })).toMatchObject({ role: 'alert', 'aria-live': 'assertive' })
    expect(feedback.textContent).toBe(expectedMessage)
    expect(dispatchEvent).not.toHaveBeenCalled()
  })

  it.each([
    ['cancelled', 'cancelled_by_user'],
    ['cancelled', 'turn_stopped_before_submit'],
    ['failed', 'fill_prestart_failed'],
    ['failed', 'taskgraph_fill_failed'],
  ])('does not dispatch retry while rendering %s / %s', (status, checkpoint) => {
    const fetchMock = vi.fn()
    const randomUUID = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('crypto', { randomUUID })
    installSession([task(status, checkpoint)])

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

  it('does not show a wall of empty sections or query a session before one is selected', () => {
    expect(renderToStaticMarkup(<SessionFocusPanel sessionId={null} />)).toBe('')
    expect(mocks.useApi).not.toHaveBeenCalled()
    installSession([])
    const html = renderToStaticMarkup(<SessionFocusPanel sessionId="session_1" />)
    expect(html).toBe('')
    expect(html).not.toContain('agent.noTaskRecords')
    expect(html).not.toContain('agent.noPendingApprovals')
    expect(html).not.toContain('agent.noApplicationTasks')
    expect(html).not.toContain('agent.noExecution')
    expect(html).not.toContain('agent.noQuestions')
    expect(html).not.toContain('agent.sessionQuality')
  })

  it('keeps pending answers, approvals, application recovery and execution controls directly visible', () => {
    installSession([task('waiting_for_user', 'submission_uncertain')], undefined, false, {
      execution: { id: 'execution_1', status: 'running', checkpoint: 'filling', error: null, attemptCount: 1 },
      approvals: [{ id: 'approval_1', title: 'Review application', status: 'pending', type: 'submit', createdAt: '2026-10-15T10:00:00.000Z' }],
      questions: [{ id: 'question_1', stage: 'Prepare', question: 'Can you work in Ireland?', pending: true, options: [{ label: 'Yes, authorised', value: 'yes' }] }],
    })
    const html = renderToStaticMarkup(<SessionFocusPanel sessionId="session_1" />)
    expect(html).toContain('Review application')
    expect(html).toContain('Yes, authorised')
    expect(html).toContain('Confirm and start fresh fill for review')
    expect(html).toContain('agent.cancelRun')
    expect(html).not.toContain('Session session_1')
    expect(html).not.toContain('<details')
  })

  it('does not hide a pending application recovery after five historical applications', () => {
    installSession([
      ...Array.from({ length: 5 }, (_, index) => ({ ...task('submitted', null), id: `done_${index}` })),
      task('waiting_for_user', 'submission_uncertain'),
    ])
    const html = renderToStaticMarkup(<SessionFocusPanel sessionId="session_1" />)
    expect(html).toContain('Confirm and start fresh fill for review')
  })

  it('removes duplicate task history, session metadata and quality without turning answered questions into actions', () => {
    installSession([], undefined, false, {
      tasks: [{ id: 'task_1', role: 'scout', taskType: 'discovery', goal: 'Find roles', status: 'completed', confidence: 0.9, failureReason: null, createdAt: '2026-10-15', updatedAt: '2026-10-15' }],
      questions: [{ id: 'question_1', stage: 'Prepare', question: 'Previously answered', answered: true, options: [{ label: 'Answer again', value: 'yes' }] }],
      qualityScore: 98,
    })
    const html = renderToStaticMarkup(<SessionFocusPanel sessionId="session_1" />)
    expect(html).toContain('Answered · read-only')
    expect(html).not.toContain('Answer again')
    expect(html).not.toContain('Find roles')
    expect(html).not.toContain('agent.sessionQuality')
    expect(html).not.toContain('98%')
    expect(html).not.toContain('Session session_1')
    expect(html).not.toContain('2026-10-15')
    expect(html).not.toContain('data-agent-session-details')
  })

  it('retains actual artifacts and unknown outcome evidence without nominal budget or compaction summaries', () => {
    installSession([], undefined, false, {
      artifacts: [{ id: 'artifact_1', title: 'Draft cover letter', type: 'cover_letter', version: 2, hash: 'verified-hash', stale: true, staleReason: 'Job requirements changed.' }],
      budget: { used: 20, limit: 100, unit: 'tokens' },
      compaction: { status: 'completed', beforeTokens: 1000, afterTokens: 500 },
      uncertain: [{ id: 'evidence_1', label: 'Application receipt', detail: 'Submission outcome is still unknown.' }],
    })
    const html = renderToStaticMarkup(<SessionFocusPanel sessionId="session_1" />)
    expect(html).toContain('Draft cover letter')
    expect(html).toContain('Job requirements changed.')
    expect(html).toContain('Application receipt')
    expect(html).toContain('Submission outcome is still unknown.')
    expect(html).not.toContain('Cost and confidence')
    expect(html).not.toContain('Budget')
    expect(html).not.toContain('Compaction')
  })

  it.each([
    [{ used: 80, limit: 100, unit: 'tokens' }, 'Near limit'],
    [{ used: 100, limit: 100, unit: 'tokens' }, 'Budget exhausted'],
    [{ used: 20, limit: 100, warning: 'This run needs a higher budget to finish.' }, 'This run needs a higher budget to finish.'],
  ])('keeps actionable budget feedback visible for %j', (budget, expected) => {
    installSession([], undefined, false, { budget })
    expect(renderToStaticMarkup(<SessionFocusPanel sessionId="session_1" />)).toContain(expected)
  })

  it.each([
    ['uncertain submission on a completed session', [task('waiting_for_user', 'submission_uncertain')], {}],
    ['unknown application outcome', [task('unknown', null)], {}],
    ['failed application', [task('failed', 'worker_failed')], {}],
    ['retryable cancelled fill', [task()], {}],
    ['pending approval', [], { approvals: [{ id: 'approval_1', title: 'Review', status: 'pending', type: 'submit', createdAt: '2026-10-15' }] }],
    ['unanswered question', [], { questions: [{ id: 'question_1', stage: 'Prepare', question: 'Authorised?', options: [], answered: false, pending: true }] }],
    ['uncertain answer state', [], { questions: [{ id: 'question_1', stage: 'Prepare', question: 'Authorised?', options: [], answered: false, pending: false, answerAvailable: false }] }],
    ['uncertain evidence', [], { uncertain: [{ id: 'evidence_1', label: 'Submission result', detail: 'No receipt available' }] }],
    ['near-limit budget', [], { budget: { used: 80, limit: 100 } }],
    ['exhausted budget', [], { budget: { used: 100, limit: 100 } }],
    ['explicit budget warning', [], { budget: { used: 20, limit: 100, warning: 'Increase the limit to finish.' } }],
  ] as Array<[string, ApplicationTask[], Partial<AgentSessionDetail>]>)('reports attention for %s regardless of session completion', (_label, applicationTasks, overrides) => {
    installSession(applicationTasks, undefined, false, { status: 'completed', ...overrides })
    const onAttentionChange = vi.fn()
    const effects: Array<{ effect: React.EffectCallback; dependencies: React.DependencyList | undefined }> = []
    vi.spyOn(React, 'useEffect').mockImplementation((effect, dependencies) => { effects.push({ effect, dependencies }) })
    renderToStaticMarkup(<SessionFocusPanel sessionId="session_1" onAttentionChange={onAttentionChange} />)
    const notification = effects.find(entry => entry.dependencies?.includes(onAttentionChange))
    expect(notification).toBeDefined()
    notification!.effect()
    expect(onAttentionChange).toHaveBeenCalledWith('session_1', true)
  })

  it('clears attention for answered questions and uses stable effect dependencies across equivalent data refreshes', () => {
    const onAttentionChange = vi.fn()
    const effects: Array<{ effect: React.EffectCallback; dependencies: React.DependencyList | undefined }> = []
    vi.spyOn(React, 'useEffect').mockImplementation((effect, dependencies) => { effects.push({ effect, dependencies }) })
    for (let refresh = 0; refresh < 2; refresh += 1) {
      installSession([], undefined, false, { questions: [{ id: 'question_1', stage: 'Prepare', question: 'Authorised?', options: [], answered: false, pending: false, answerAvailable: true }] })
      renderToStaticMarkup(<SessionFocusPanel sessionId="session_1" onAttentionChange={onAttentionChange} />)
    }
    const notifications = effects.filter(entry => entry.dependencies?.includes(onAttentionChange))
    expect(notifications).toHaveLength(2)
    expect(notifications[0].dependencies).toEqual(notifications[1].dependencies)
    notifications[0].effect()
    expect(onAttentionChange).toHaveBeenCalledWith('session_1', false)
  })
})
