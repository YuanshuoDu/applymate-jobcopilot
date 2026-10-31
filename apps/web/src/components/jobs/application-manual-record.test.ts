import { afterEach, describe, expect, it, vi } from 'vitest'
import { blocksManualRecord, hasVisibleSubmissionRecord, parseScopedManualRecordJob, readManualRecord, readManualRecordLock, rejectPendingManualRecord, submitManualRecord, writeManualRecordLock } from './application-manual-record'

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
    [409, { error: 'Application state changed. Refresh the application before recording.' }],
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

describe('bounded manual record requests', () => {
  const requestId = 'c24888e7-55f4-43c5-b1a4-73e77c4ce800'
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it.each([
    [200, { applied: true }],
    [403, { code: 'MANUAL_APPLICATION_LIMIT_REACHED', requestId }],
  ])('keeps a late POST response unknown after timeout even if abort is ignored (%s)', async (status, body) => {
    vi.useFakeTimers()
    let release!: (value: Response) => void
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>(resolve => { release = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const pending = submitManualRecord('j', requestId)
    let finished = false
    void pending.then(() => { finished = true })
    await vi.advanceTimersByTimeAsync(14_999)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toBe('unknown')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    release(new Response(JSON.stringify(body), { status }))
    await Promise.resolve()
    expect(await pending).toBe('unknown')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('bounds a hanging POST body read and ignores its late success', async () => {
    vi.useFakeTimers()
    let release!: (value: unknown) => void
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => new Promise(resolve => { release = resolve }) }))
    const pending = submitManualRecord('j', requestId)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await pending).toBe('unknown')
    release({ applied: true })
    await Promise.resolve()
    expect(await pending).toBe('unknown')
  })

  it('reads a valid job response and treats non-success and network failure as unavailable', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'j' })))
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockRejectedValueOnce(Error('offline'))
    vi.stubGlobal('fetch', fetchMock)
    expect(await readManualRecord('j')).toEqual({ id: 'j' })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/jobs/j')
    expect(fetchMock.mock.calls[0][1].cache).toBe('no-store')
    expect(await readManualRecord('j')).toBeNull()
    expect(await readManualRecord('j')).toBeNull()
  })

  it('returns unavailable when a GET ignores abort and resolves late', async () => {
    vi.useFakeTimers()
    let release!: (value: Response) => void
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>(resolve => { release = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const pending = readManualRecord('j')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await pending).toBeNull()
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    release(new Response(JSON.stringify({ id: 'j' })))
    await Promise.resolve()
    expect(await pending).toBeNull()
  })

  it('bounds the GET body read and ignores a late parsed result', async () => {
    vi.useFakeTimers()
    let release!: (value: unknown) => void
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => new Promise(resolve => { release = resolve }) }))
    const pending = readManualRecord('j')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await pending).toBeNull()
    release({ id: 'j' })
    await Promise.resolve()
    expect(await pending).toBeNull()
  })
})

describe('scoped manual record job', () => {
  const job = {
    id: 'job-1', userId: 'user-1', company: 'Example', role: 'Engineer', logo: null, location: 'Dublin',
    status: 'saved', score: 82, url: null, description: null, salary: null, source: null, notes: null,
    coverLetter: null, analysisNote: null, keywords: null, appliedAt: null, followUpAt: null,
    workflowState: 'draft', createdAt: '2026-10-30T10:00:00.000Z', updatedAt: '2026-10-30T10:00:00.000Z',
    finalResumeId: null, finalCoverLetterId: null,
  }

  it('returns a complete scoped row with nullable fields and supported dates', () => {
    const valid = { ...job, appliedAt: '2026-10-30T10:00:00.000Z', followUpAt: '2026-11-05T00:00:00.000Z' }
    expect(parseScopedManualRecordJob(valid, 'user-1', 'job-1')).toEqual(valid)
  })

  it.each(Object.keys(job))('rejects a response missing %s', key => {
    const incomplete: Record<string, unknown> = { ...job }
    delete incomplete[key]
    expect(parseScopedManualRecordJob(incomplete, 'user-1', 'job-1')).toBeNull()
  })

  it.each([
    ['id', 'other-job'], ['userId', 'other-user'], ['company', null], ['role', 3],
    ['status', 'unknown'], ['workflowState', 'unknown'], ['score', NaN], ['score', '82'],
    ['notes', 1], ['finalResumeId', {}], ['createdAt', 'not-a-date'], ['updatedAt', ''],
    ['appliedAt', 'not-a-date'], ['followUpAt', 3],
  ])('rejects malformed or wrong-scope %s', (key, bad) => {
    expect(parseScopedManualRecordJob({ ...job, [key]: bad }, 'user-1', 'job-1')).toBeNull()
  })

  it('rejects missing scope and non-object data', () => {
    expect(parseScopedManualRecordJob(job, '', 'job-1')).toBeNull()
    expect(parseScopedManualRecordJob(job, 'user-1', '')).toBeNull()
    expect(parseScopedManualRecordJob(null, 'user-1', 'job-1')).toBeNull()
    expect(parseScopedManualRecordJob([], 'user-1', 'job-1')).toBeNull()
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
