import { afterEach, describe, expect, it, vi } from 'vitest'
import { blocksManualRecord, hasVisibleSubmissionRecord, readManualRecordLock, rejectPendingManualRecord, submitManualRecord, writeManualRecordLock } from './application-manual-record'

function memoryStorage(): Storage {
  const entries = new Map<string, string>()
  return { get length() { return entries.size }, clear: () => entries.clear(), key: i => [...entries.keys()][i] ?? null,
    getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value) }, removeItem: key => { entries.delete(key) } }
}

describe('manual record lock', () => {
  it('survives reopening and isolates account and job identities', () => {
    const store = memoryStorage()
    expect(writeManualRecordLock(store, 'a:b', 'job/1', 'pending')).toBe(true)
    expect(readManualRecordLock(store, 'a:b', 'job/1')).toBe('pending')
    expect(readManualRecordLock(store, 'a', 'b:job/1')).toBeNull()
    expect(readManualRecordLock(store, 'a:b', 'job/2')).toBeNull()
    writeManualRecordLock(store, 'a:b', 'job/1', 'confirmed')
    expect(readManualRecordLock(store, 'a:b', 'job/1')).toBe('confirmed')
  })
  it('fails closed on inaccessible or malformed storage', () => {
    const unavailable = { getItem: () => { throw Error('denied') }, setItem: () => { throw Error('denied') } } as unknown as Storage
    expect(readManualRecordLock(unavailable, 'a', 'j')).toBe('unknown')
    expect(writeManualRecordLock(unavailable, 'a', 'j', 'pending')).toBe(false)
    const malformed = memoryStorage()
    malformed.setItem('applymate:manual-record:a:j', 'unrecognized')
    expect(readManualRecordLock(malformed, 'a', 'j')).toBe('unknown')
  })
  it('releases only the pending lock after a verified rejection', () => {
    const store = memoryStorage()
    expect(rejectPendingManualRecord(store, 'a', 'j', 'limit')).toBe(false)
    writeManualRecordLock(store, 'a', 'j', 'unknown')
    expect(rejectPendingManualRecord(store, 'a', 'j', 'limit')).toBe(false)
    expect(readManualRecordLock(store, 'a', 'j')).toBe('unknown')
    writeManualRecordLock(store, 'a', 'j', 'pending')
    expect(rejectPendingManualRecord(store, 'a', 'j', 'limit')).toBe(true)
    expect(readManualRecordLock(store, 'a', 'j')).toBe('rejected-limit')
    // The next explicit record attempt replaces the verified rejection.
    expect(writeManualRecordLock(store, 'a', 'j', 'pending')).toBe(true)
    expect(readManualRecordLock(store, 'a', 'j')).toBe('pending')
    expect(readManualRecordLock(store, 'a', 'other')).toBeNull()
  })
  it('does not release a lock when storage cannot verify the update', () => {
    const store = memoryStorage()
    writeManualRecordLock(store, 'a', 'j', 'pending')
    vi.spyOn(store, 'setItem').mockImplementation(() => { throw Error('denied') })
    expect(rejectPendingManualRecord(store, 'a', 'j', 'limit')).toBe(false)
    expect(readManualRecordLock(store, 'a', 'j')).toBe('pending')
  })
})

describe('manual record response', () => {
  const requestId = 'c24888e7-55f4-43c5-b1a4-73e77c4ce800'
  afterEach(() => vi.unstubAllGlobals())
  it.each([
    ['MANUAL_APPLICATION_LIMIT_REACHED', 'limit'],
    ['MANUAL_APPLICATION_PLAN_RESTRICTED', 'plan'],
  ] as const)('recognizes only a matching pre-write %s rejection', async (code, outcome) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code, requestId }), { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await submitManualRecord('job/1', requestId)).toBe(outcome)
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/job%2F1/apply', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ 'X-Manual-Record-Request-Id': requestId }),
    }))
  })
  it.each([
    [403, { code: 'MANUAL_APPLICATION_LIMIT_REACHED', requestId: 'different' }],
    [403, { error: 'Forbidden' }],
    [500, { code: 'MANUAL_APPLICATION_LIMIT_REACHED', requestId }],
    [200, { applied: false }],
  ])('keeps status %s with unproven response unknown', async (status, body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })))
    expect(await submitManualRecord('j', requestId)).toBe('unknown')
  })
  it('keeps network failures and malformed responses unknown', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce(new Response('invalid')))
    expect(await submitManualRecord('j', requestId)).toBe('unknown')
    expect(await submitManualRecord('j', requestId)).toBe('unknown')
  })
  it('confirms an explicitly accepted record', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ applied: true }))))
    expect(await submitManualRecord('j', requestId)).toBe('confirmed')
  })
})

describe('submission evidence and duplicate protection', () => {
  const saved = { status: 'saved', workflowState: 'draft', appliedAt: null } as const

  it('allows recording a saved job with no prior submission evidence', () => {
    expect(hasVisibleSubmissionRecord(saved)).toBe(false)
    expect(blocksManualRecord(saved)).toBe(false)
  })

  it('allows manual recording after materials are ready when no submission started', () => {
    const job = { ...saved, workflowState: 'ready_to_apply' as const }
    expect(hasVisibleSubmissionRecord(job)).toBe(false)
    expect(blocksManualRecord(job)).toBe(false)
  })

  it.each(['rejected', 'offer', 'interview'] as const)(
    'does not infer a submission from %s or its submitted workflow', status => {
      const job = { ...saved, status, workflowState: 'submitted' as const }
      expect(hasVisibleSubmissionRecord(job)).toBe(false)
      expect(blocksManualRecord(job)).toBe(true)
    },
  )

  it.each(['queued', 'submitting', 'submitted'] as const)('blocks duplicate recording during %s without claiming submission', workflowState => {
    const job = { ...saved, workflowState }
    expect(hasVisibleSubmissionRecord(job)).toBe(false)
    expect(blocksManualRecord(job)).toBe(true)
  })

  it.each([null, undefined, 'unrecognized'])('blocks duplicate recording for an unknown workflow: %j', workflowState => {
    const job = { ...saved, workflowState } as unknown as typeof saved
    expect(hasVisibleSubmissionRecord(job)).toBe(false)
    expect(blocksManualRecord(job)).toBe(true)
  })

  it('recognizes an explicit applied status as a record', () => {
    const job = { ...saved, status: 'applied' as const }
    expect(hasVisibleSubmissionRecord(job)).toBe(true)
    expect(blocksManualRecord(job)).toBe(true)
  })

  it('retains historical submission evidence when the job returns to saved', () => {
    const job = { ...saved, appliedAt: '2026-10-30T10:00:00.000Z' }
    expect(hasVisibleSubmissionRecord(job)).toBe(true)
    expect(blocksManualRecord(job)).toBe(true)
  })

  it.each(['not-a-date', '', '   '])('treats an invalid timestamp as uncertain: %j', appliedAt => {
    const job = { ...saved, appliedAt }
    expect(hasVisibleSubmissionRecord(job)).toBe(false)
    expect(blocksManualRecord(job)).toBe(true)
  })

  it('blocks a malformed response that omits appliedAt', () => {
    const malformed = { ...saved, appliedAt: undefined } as unknown as typeof saved
    expect(hasVisibleSubmissionRecord(malformed)).toBe(false)
    expect(blocksManualRecord(malformed)).toBe(true)
  })
})
