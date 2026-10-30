import { describe, expect, it } from 'vitest'
import { applicationTaskSessionHref, getApplicationTaskState, parseApplicationTasks, type ApplicationTaskView } from './application-task-model'

function row(overrides: Record<string, unknown> = {}) {
  return { id: 'task_1', jobId: 'job_1', userId: 'user_1', sessionId: 'session_1', status: 'waiting_for_user', checkpoint: 'form_answer_required',
    updatedAt: '2026-10-30T10:00:00.000Z', job: { company: 'Example', role: 'Engineer' }, ...overrides }
}

function task(overrides: Partial<ApplicationTaskView> = {}): ApplicationTaskView {
  return { id: 'task_1', jobId: 'job_1', sessionId: 'session_1', status: 'waiting_for_user', checkpoint: 'form_answer_required',
    updatedAt: '2026-10-30T10:00:00.000Z', company: 'Example', role: 'Engineer', ...overrides }
}

describe('application task display data', () => {
  it('joins by job ID and selects the newest actual record regardless of response order', () => {
    const parsed = parseApplicationTasks({ tasks: [row(), row({ id: 'task_new', updatedAt: '2026-10-30T11:00:00Z', status: 'submitted' }),
      row({ id: 'task_other', jobId: 'job_other', job: { company: 'Example', role: 'Engineer' } })] }, 'user_1')
    expect(parsed?.tasks.map(item => [item.jobId, item.id])).toEqual([['job_1', 'task_new'], ['job_other', 'task_other']])
  })

  it('discards sensitive fields and untrusted server summaries', () => {
    const parsed = parseApplicationTasks({ tasks: [row({ confirmedAnswers: { salary: 'private' }, question: { text: 'private' }, events: [{ body: 'private' }] })], summary: { submitted: 9999 } }, 'user_1')
    expect(parsed?.tasks).toEqual([task()])
    expect(JSON.stringify(parsed)).not.toContain('private')
    expect(JSON.stringify(parsed)).not.toContain('9999')
  })

  it('rejects foreign-owner, malformed and ambiguous records rather than showing a guessed status', () => {
    for (const invalid of [row({ userId: 'other' }), row({ jobId: '' }), row({ updatedAt: 'invalid' }), row({ job: null }), row({ status: null })]) {
      expect(parseApplicationTasks({ tasks: [row(), invalid] }, 'user_1')).toBeNull()
    }
    expect(parseApplicationTasks({ tasks: [row(), row({ id: 'task_ambiguous', status: 'submitted' })] }, 'user_1')).toBeNull()
    expect(parseApplicationTasks({ tasks: {} }, 'user_1')).toBeNull()
  })

  it('reports a full recent window without treating the summary as a global count', () => {
    const tasks = Array.from({ length: 100 }, (_, i) => row({ id: `task_${i}`, jobId: `job_${i}` }))
    expect(parseApplicationTasks({ tasks }, 'user_1')?.limited).toBe(true)
    expect(parseApplicationTasks({ tasks: [] }, 'user_1')).toEqual({ tasks: [], limited: false })
    expect(parseApplicationTasks({ tasks: [...tasks, row()] }, 'user_1')).toBeNull()
  })
})

describe('application task status and navigation', () => {
  it.each([
    ['generating_materials', null, 'preparing', false], ['filling', null, 'filling', false],
    ['waiting_for_user', 'form_answer_required', 'needsInput', true], ['waiting_for_authorization', 'form_filled', 'needsApproval', true],
    ['waiting_for_user', 'submission_uncertain', 'unknown', true], ['failed', 'submission_uncertain', 'unknown', true],
    ['submitted', 'submission_uncertain', 'unknown', true], ['unknown', null, 'unknown', true],
    ['filling', 'submission_request_started', 'submitting', false], ['submitted', 'submission_request_started', 'submitted', false],
    ['failed', null, 'failed', true], ['cancelled', null, 'cancelled', false], ['skipped', null, 'skipped', false],
    ['unrecognized', null, 'unavailable', false],
  ])('projects %s / %s as %s without adding execution authority', (status, checkpoint, kind, needsAttention) => {
    expect(getApplicationTaskState(task({ status, checkpoint }))).toMatchObject({ kind, needsAttention })
  })

  it('opens only the persisted session and encodes the complete ID as a query value', () => {
    expect(applicationTaskSessionHref(task())).toBe('/?page=agent&sessionId=session_1')
    expect(applicationTaskSessionHref(task({ sessionId: 'session&other=value' }))).toBe('/?page=agent&sessionId=session%26other%3Dvalue')
    expect(applicationTaskSessionHref(task({ sessionId: null }))).toBeNull()
    expect(applicationTaskSessionHref(task({ sessionId: ' bad ' }))).toBeNull()
  })
})
