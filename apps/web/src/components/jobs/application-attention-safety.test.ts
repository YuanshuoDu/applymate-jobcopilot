import { describe, expect, it } from 'vitest'
import { applicationTaskAllowsManualWork } from './application-attention-safety'
import type { ApplicationTaskView } from './application-task-model'

const task: ApplicationTaskView = { id: 'task', jobId: 'job', sessionId: 'session', status: 'failed', checkpoint: 'turn_stopped_before_submit', company: 'Company', role: 'Role', updatedAt: '2026-10-30T00:00:00Z' }

describe('manual work after a task', () => {
  it('allows no task or a proven stop before submission', () => {
    expect(applicationTaskAllowsManualWork(undefined)).toBe(true)
    expect(applicationTaskAllowsManualWork(task)).toBe(true)
    expect(applicationTaskAllowsManualWork({ ...task, status: 'cancelled' })).toBe(true)
  })
  it('fails closed without both the terminal status and the exact proof', () => {
    for (const status of ['unknown', 'waiting_for_authorization', 'filling', 'submitted', 'skipped', 'cancelled_by_user']) {
      expect(applicationTaskAllowsManualWork({ ...task, status })).toBe(false)
    }
    for (const checkpoint of [null, 'submission_uncertain', 'submission_request_started', 'cancelled_by_user', '']) {
      expect(applicationTaskAllowsManualWork({ ...task, checkpoint })).toBe(false)
    }
  })
})
