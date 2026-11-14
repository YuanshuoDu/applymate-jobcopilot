import { describe, expect, it } from 'vitest'
import { unknownApplicationSubmissionEvidence } from '@/lib/agent/application-submission-evidence'
import { applicationTaskSessionHref, getApplicationTaskState, parseApplicationTasks, type ApplicationTaskView } from './application-task-model'

const legacyEvidence = unknownApplicationSubmissionEvidence(false, 'unknown')

function row(overrides: Record<string, unknown> = {}) {
  return { id: 'task_1', jobId: 'job_1', userId: 'user_1', sessionId: 'session_1', status: 'waiting_for_user', checkpoint: 'form_answer_required',
    updatedAt: '2026-10-30T10:00:00.000Z', job: { company: 'Example', role: 'Engineer' }, ...overrides }
}

function task(overrides: Partial<ApplicationTaskView> = {}): ApplicationTaskView {
  return { id: 'task_1', jobId: 'job_1', sessionId: 'session_1', status: 'waiting_for_user', checkpoint: 'form_answer_required',
    updatedAt: '2026-10-30T10:00:00.000Z', company: 'Example', role: 'Engineer', submissionEvidence: legacyEvidence, ...overrides }
}

describe('application task display data', () => {
  it('sorts the unique task for each job by its actual update time', () => {
    const parsed = parseApplicationTasks({ tasks: [row(),
      row({ id: 'task_other', jobId: 'job_other', updatedAt: '2026-10-30T11:00:00Z', job: { company: 'Example', role: 'Engineer' } })] }, 'user_1')
    expect(parsed?.tasks.map(item => [item.jobId, item.id])).toEqual([['job_other', 'task_other'], ['job_1', 'task_1']])
  })

  it('discards sensitive fields and untrusted server summaries', () => {
    const parsed = parseApplicationTasks({ tasks: [row({ confirmedAnswers: { salary: 'private' }, question: { text: 'private' }, events: [{ body: 'private' }] })], summary: { submitted: 9999 } }, 'user_1')
    expect(parsed?.tasks).toEqual([task()])
    expect(JSON.stringify(parsed)).not.toContain('private')
    expect(JSON.stringify(parsed)).not.toContain('9999')
  })

  it('normalizes missing legacy evidence to unknown without rejecting the Task', () => {
    const parsed = parseApplicationTasks({ tasks: [row({ status: 'submitted', checkpoint: 'submission_verified' })] }, 'user_1')
    expect(parsed?.tasks[0]?.submissionEvidence).toEqual(unknownApplicationSubmissionEvidence(true, 'unknown'))
  })

  it('accepts the exact closed set of supported evidence values', () => {
    const parsed = parseApplicationTasks({ tasks: [row({
      checkpoint: 'submission_verified',
      submissionEvidence: { visible: true, availability: 'available', workerReport: 'submitted', localRecord: 'recorded',
        employerReceipt: 'unverified' },
    })] }, 'user_1')
    expect(parsed?.tasks[0]?.submissionEvidence).toEqual({
      visible: true, availability: 'available', workerReport: 'submitted', localRecord: 'recorded', employerReceipt: 'unverified',
    })
  })

  it('turns evidence with unsupported private fields into unknown without retaining them', () => {
    const parsed = parseApplicationTasks({ tasks: [row({
      checkpoint: 'submission_verified',
      submissionEvidence: { visible: true, availability: 'available', workerReport: 'submitted', localRecord: 'recorded',
        employerReceipt: 'unverified', attemptId: 'secret', receiptId: 'secret', constraintHash: 'secret' },
    })] }, 'user_1')
    expect(parsed?.tasks[0]?.submissionEvidence).toEqual(unknownApplicationSubmissionEvidence(true, 'unknown'))
    expect(JSON.stringify(parsed)).not.toContain('secret')
  })

  it('maps invalid positive or site claims to unknown/unverified without rejecting the Task', () => {
    for (const invalid of [
      { visible: true, availability: 'available', workerReport: 'confirmed', localRecord: 'recorded', employerReceipt: 'confirmed' },
      { visible: true, availability: 'available', workerReport: 'submitted', localRecord: 'recorded', employerReceipt: 'rejected' },
      { visible: true, availability: 'available', workerReport: 'submitted', localRecord: 'recorded' },
      { visible: true, availability: 'available', workerReport: 'unknown', localRecord: 'recorded', employerReceipt: 'unverified' },
      { visible: true, availability: 'unavailable', workerReport: 'submitted', localRecord: 'recorded', employerReceipt: 'unverified' },
    ]) {
      const parsed = parseApplicationTasks({ tasks: [row({ status: 'submitted', checkpoint: 'submission_verified', submissionEvidence: invalid })] }, 'user_1')
      const expectedAvailability = invalid.availability === 'unavailable' ? 'unavailable' : 'unknown'
      expect(parsed?.tasks[0]?.submissionEvidence).toEqual(unknownApplicationSubmissionEvidence(true, expectedAvailability))
    }
  })

  it('does not display positive evidence that the server marks invisible', () => {
    const parsed = parseApplicationTasks({ tasks: [row({
      submissionEvidence: { visible: false, availability: 'available', workerReport: 'submitted', localRecord: 'recorded', employerReceipt: 'unverified' },
    })] }, 'user_1')
    expect(parsed?.tasks[0]?.submissionEvidence).toEqual(unknownApplicationSubmissionEvidence(false, 'unknown'))
  })

  it('does not retain conflicting tasks, foreign owners, or malformed display data', () => {
    for (const invalid of [row({ userId: 'other' }), row({ jobId: '' }), row({ updatedAt: 'invalid' }), row({ job: null }), row({ status: null })]) {
      expect(parseApplicationTasks({ tasks: [row(), invalid] }, 'user_1')).toBeNull()
    }
    expect(parseApplicationTasks({ tasks: [row(), row({ id: 'task_ambiguous', status: 'submitted' })] }, 'user_1')).toBeNull()
    expect(parseApplicationTasks({ tasks: [row({ status: 'waiting_for_user', checkpoint: 'submission_uncertain' }),
      row({ id: 'later', updatedAt: '2026-10-30T11:00:00Z', status: 'cancelled', checkpoint: 'turn_stopped_before_submit' })] }, 'user_1')).toBeNull()
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
    ['waiting_for_user', 'materials_ready', 'needsMaterialsReview', true], ['waiting_for_user', 'user_takeover', 'needsHandoff', true],
    ['waiting_for_user', 'fill_outcome_uncertain', 'fillUncertain', true],
    ['waiting_for_user', 'review_requested', 'needsUserAction', true], ['waiting_for_user', null, 'needsUserAction', true],
    ['waiting_for_user', 'submission_uncertain', 'unknown', true], ['failed', 'submission_uncertain', 'unknown', true],
    ['submitted', 'submission_uncertain', 'unknown', true], ['unknown', null, 'unknown', true],
    ['filling', 'submission_request_started', 'submitting', false], ['submitted', 'submission_request_started', 'submitted', false],
    ['failed', null, 'failed', true], ['cancelled', null, 'cancelled', false], ['skipped', null, 'skipped', false],
    ['unrecognized', null, 'unavailable', false],
  ])('projects %s / %s as %s without adding execution authority', (status, checkpoint, kind, needsAttention) => {
    expect(getApplicationTaskState(task({ status, checkpoint }))).toMatchObject({ kind, needsAttention })
  })

  it('describes material review, handoff and unspecified waits without implying submission approval or a question', () => {
    expect(getApplicationTaskState(task({ checkpoint: 'materials_ready' })).labelKey).toBe('jobs.task.needsMaterialsReview')
    expect(getApplicationTaskState(task({ checkpoint: 'materials_ready' })).descriptionKey).toBe('jobs.task.needsMaterialsReviewHint')
    expect(getApplicationTaskState(task({ checkpoint: 'materials_ready' })).actionKey).toBe('jobs.task.openMaterialsReview')
    expect(getApplicationTaskState(task({ checkpoint: 'user_takeover' })).actionKey).toBe('jobs.task.openHandoff')
    expect(getApplicationTaskState(task({ checkpoint: 'review_requested' })).actionKey).toBe('jobs.task.viewActivity')
    expect(getApplicationTaskState(task()).actionKey).toBe('jobs.task.openQuestion')
  })

  it('opens only the persisted session and encodes the complete ID as a query value', () => {
    expect(applicationTaskSessionHref(task())).toBe('/?page=agent&sessionId=session_1')
    expect(applicationTaskSessionHref(task({ sessionId: 'session&other=value' }))).toBe('/?page=agent&sessionId=session%26other%3Dvalue')
    expect(applicationTaskSessionHref(task({ sessionId: null }))).toBeNull()
    expect(applicationTaskSessionHref(task({ sessionId: ' bad ' }))).toBeNull()
  })
})
