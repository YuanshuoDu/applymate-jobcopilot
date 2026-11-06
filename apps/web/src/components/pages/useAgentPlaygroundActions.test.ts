import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { Dispatch, SetStateAction } from 'react'
import type { ApplyReadyJob } from '@/components/agent-workspace/ApplyJobCard'
import { recordManualApplication, type RecordManualApplicationOptions } from './useAgentPlaygroundActions'

const source = readFileSync(new URL('./useAgentPlaygroundActions.ts', import.meta.url), 'utf8')

const job: ApplyReadyJob = {
  jobId: 'job-1',
  company: 'N26',
  role: 'Software Engineer',
  score: 94,
  url: 'https://example.com/apply',
  matchedKeywords: [],
}

function queueHarness() {
  let queue: ApplyReadyJob[] = [job]
  const setApplyQueue: Dispatch<SetStateAction<ApplyReadyJob[]>> = update => {
    queue = typeof update === 'function' ? update(queue) : update
  }
  return { setApplyQueue, getQueue: () => queue, replaceQueue: (next: ApplyReadyJob[]) => { queue = next } }
}

function deferredQueueHarness() {
  let queue: ApplyReadyJob[] = [job]
  const deferred: Array<(prev: ApplyReadyJob[]) => ApplyReadyJob[]> = []
  const setApplyQueue: Dispatch<SetStateAction<ApplyReadyJob[]>> = update => {
    if (typeof update === 'function') deferred.push(update)
    else queue = update
  }
  return {
    setApplyQueue,
    getQueue: () => queue,
    replaceQueue: (next: ApplyReadyJob[]) => { queue = next },
    flushDeferred() {
      for (const update of deferred.splice(0)) queue = update(queue)
    },
  }
}

describe('Agent playground review actions', () => {
  it('preserves the existing approval-answer and email actions', () => {
    expect(source).toContain("field === '_send_email'")
    expect(source).toContain("apiMutate('/api/gmail/send-draft', 'POST', emailData)")
    expect(source).toContain("apiMutate('/api/agent', 'PATCH', { [field]: value })")
    expect(source).toContain("type: 'question_answered'")
    expect(source).toContain("apiMutate('/api/agent/answer', 'POST', { questionId, answer })")
  })

  it('posts the existing manual-record route and marks the queue user-reported', async () => {
    const { setApplyQueue, getQueue } = queueHarness()
    const mutate = vi.fn(async () => ({ data: { applied: true }, error: null }))
    const toast = { success: vi.fn(), error: vi.fn() } as unknown as RecordManualApplicationOptions['toast']

    const request = recordManualApplication({
      jobId: job.jobId, userId: 'user-1', getActiveUserId: () => 'user-1',
      job, toast, setApplyQueue, lang: 'en', mutate,
    })

    expect(mutate).toHaveBeenCalledWith(`/api/jobs/${job.jobId}/apply`, 'POST', {})
    expect(getQueue()[0].manualRecordStatuses).toEqual({ 'user-1': 'pending' })
    await request

    expect(getQueue()[0].manualRecordStatuses).toEqual({ 'user-1': 'reported' })
    expect(toast.success).toHaveBeenCalledWith('Recorded from your confirmation', 'N26 · Software Engineer')
  })

  it('records an uncertain API result as unknown instead of retrying it', async () => {
    const { setApplyQueue, getQueue } = queueHarness()
    const mutate = vi.fn(async () => ({ data: null, error: 'Network error' }))
    const toast = { success: vi.fn(), error: vi.fn() } as unknown as RecordManualApplicationOptions['toast']

    await expect(recordManualApplication({
      jobId: job.jobId, userId: 'user-1', getActiveUserId: () => 'user-1',
      job, toast, setApplyQueue, lang: 'en', mutate,
    }))
      .rejects.toThrow('Network error')

    expect(mutate).toHaveBeenCalledOnce()
    expect(getQueue()[0].manualRecordStatuses).toEqual({ 'user-1': 'unknown' })
    expect(toast.error).toHaveBeenCalledWith(
      'Status unknown. Check your applications before trying again.',
      'Network error',
    )
  })

  it('does not let a late account A response replace account B queue state', async () => {
    const { setApplyQueue, getQueue, replaceQueue } = queueHarness()
    const activeUser = { id: 'user-a' }
    const toast = { success: vi.fn(), error: vi.fn() } as unknown as RecordManualApplicationOptions['toast']
    let resolveMutation!: (value: { data: unknown | null; error: string | null }) => void
    const mutation = new Promise<{ data: unknown | null; error: string | null }>(resolve => { resolveMutation = resolve })
    const mutate = vi.fn(() => mutation)

    const requestA = recordManualApplication({
      jobId: job.jobId, userId: 'user-a', getActiveUserId: () => activeUser.id,
      job, toast, setApplyQueue, lang: 'en', mutate,
    })
    expect(getQueue()[0].manualRecordStatuses).toEqual({ 'user-a': 'pending' })

    activeUser.id = 'user-b'
    replaceQueue([{ ...job, manualRecordStatuses: { 'user-b': 'unknown' } }])
    resolveMutation({ data: { applied: true }, error: null })
    await requestA

    expect(getQueue()[0].manualRecordStatuses).toEqual({ 'user-b': 'unknown', 'user-a': 'reported' })
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('merges a delayed A updater into A’s slot without replacing B’s current slot', async () => {
    const { setApplyQueue, getQueue, replaceQueue, flushDeferred } = deferredQueueHarness()
    const activeUser = { id: 'user-a' }
    const toast = { success: vi.fn(), error: vi.fn() } as unknown as RecordManualApplicationOptions['toast']
    let resolveMutation!: (value: { data: unknown | null; error: string | null }) => void
    const mutation = new Promise<{ data: unknown | null; error: string | null }>(resolve => { resolveMutation = resolve })
    const mutate = vi.fn(() => mutation)

    const requestA = recordManualApplication({
      jobId: job.jobId, userId: 'user-a', getActiveUserId: () => activeUser.id,
      job, toast, setApplyQueue, lang: 'en', mutate,
    })
    expect(getQueue()[0].manualRecordStatuses).toBeUndefined()

    activeUser.id = 'user-b'
    replaceQueue([{ ...job, manualRecordStatuses: { 'user-b': 'unknown' } }])
    flushDeferred()
    expect(getQueue()[0].manualRecordStatuses).toEqual({ 'user-b': 'unknown', 'user-a': 'pending' })

    resolveMutation({ data: { applied: true }, error: null })
    await requestA
    flushDeferred()
    expect(getQueue()[0].manualRecordStatuses).toEqual({ 'user-b': 'unknown', 'user-a': 'reported' })
    expect(toast.success).not.toHaveBeenCalled()
  })
})
