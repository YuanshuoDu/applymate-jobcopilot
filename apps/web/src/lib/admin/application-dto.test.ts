import { describe, expect, it } from 'vitest'
import { toAdminApplicationMetadata, toAdminApplicationTaskMetadata } from './application-dto'

describe('toAdminApplicationMetadata', () => {
  it('maps raw errors to an allow-listed class without serializing error text', () => {
    const result = toAdminApplicationMetadata({ id: 1, userId: 'user-1', jobId: 'job-1', status: 'failed', mode: 'unattended', atsType: 'lever', flowUsed: 'llm', error: 'Captcha screenshot includes private candidate input', durationMs: 1200, createdAt: new Date('2026-08-05') })
    expect(result).toEqual(expect.objectContaining({ errorClass: 'captcha' }))
    expect(JSON.stringify(result)).not.toContain('private candidate input')
  })
})

describe('toAdminApplicationTaskMetadata', () => {
  it('does not serialize worker errors or event bodies', () => {
    const task = toAdminApplicationTaskMetadata({
      id: 'task-1',
      status: 'waiting_for_user',
      checkpoint: 'form_answer_required',
      error: 'Candidate entered private phone number +353 00 000 0000',
      startedAt: null,
      completedAt: null,
      createdAt: new Date('2026-08-11'),
      updatedAt: new Date('2026-08-11'),
      events: [{ id: 'event-1', type: 'form_answer_required', actor: 'worker', createdAt: new Date('2026-08-11') }],
    })

    expect(task.errorClass).toBe('unknown')
    expect(task.events[0]?.body).toBe('Candidate input is required before execution can continue.')
    expect(JSON.stringify(task)).not.toContain('private phone number')
    expect(JSON.stringify(task)).not.toContain('+353')
  })
})
