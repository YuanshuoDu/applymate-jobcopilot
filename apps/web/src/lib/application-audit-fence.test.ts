import { webcrypto } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { APPLICATION_AUDIT_FENCE_EVENT, beginAuditFence, beginRetryableAuditFence, confirmAuditFence, markAuditFenceRetryable, postApplicationAudit, postApplicationAuditCorrection, readAuditFence, reconcileAuditFence, waitForAuditFencePost, type AuditFencePost } from './application-audit-fence'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

const operationId = '123e4567-e89b-42d3-a456-426614174000'
const audit: AuditFencePost = { operationId, resumeUpdatedAt: '2026-11-05T12:00:00.000Z', verdict: 'pass', auditedAt: '2026-11-05T12:01:00.000Z', summary: 'Private fixture', matchScore: 75, source: 'parent_resume', findings: [{ area: 'resume', severity: 'pass', title: 'Private finding', evidence: 'Private fact', action: 'None' }] }
const receipt = { resumeId: 'resume-1', coverLetterId: null, operationId, resumeUpdatedAt: audit.resumeUpdatedAt, receipt: { version: 1 as const, signature: 'a'.repeat(64) }, audit }

describe('same-tab audit fence', () => {
  beforeEach(() => vi.stubGlobal('crypto', webcrypto))

  it('keeps an unconfirmed POST fenced even when a GET returns a prior valid receipt', async () => {
    const store = new MemoryStorage()
    expect(beginAuditFence(store, 'user-a', 'job-a', 'resume-1', null)).toBeTruthy()
    expect(readAuditFence(store, 'user-a', 'job-a').state).toBe('pending')
    expect(await reconcileAuditFence(store, 'user-a', 'job-a', receipt)).toBe(false)
    expect(beginAuditFence(store, 'user-a', 'job-a', 'resume-1', null)).toBeNull()
    expect(readAuditFence(store, 'user-a', 'job-a').state).toBe('pending')
    expect(readAuditFence(store, 'user-b', 'job-a').state).toBe('none')
    expect(readAuditFence(store, 'user-a', 'job-b').state).toBe('none')
  })

  it('clears only an exact matching signed GET after a confirmed POST without storing private audit text', async () => {
    const store = new MemoryStorage()
    const attempt = beginAuditFence(store, 'user-a', 'job-a', 'resume-1', null)!
    expect(await confirmAuditFence(store, 'user-a', 'job-a', attempt, audit)).toBe(true)
    expect(store.getItem(store.key(0)!)).not.toContain('Private')
    expect(await reconcileAuditFence(store, 'user-a', 'job-a', { ...receipt, operationId: '123e4567-e89b-42d3-a456-426614174001' })).toBe(false)
    expect(await reconcileAuditFence(store, 'user-a', 'job-a', { ...receipt, audit: { ...audit, summary: 'Altered' } })).toBe(false)
    expect(await reconcileAuditFence(store, 'user-a', 'job-a', { ...receipt, receipt: undefined })).toBe(false)
    expect(await reconcileAuditFence(store, 'user-a', 'job-a', { ...receipt, resumeUpdatedAt: '2026-11-05T12:02:00.000Z' })).toBe(false)
    expect(await reconcileAuditFence(store, 'user-a', 'job-a', receipt)).toBe(true)
    expect(readAuditFence(store, 'user-a', 'job-a').state).toBe('none')
  })

  it('persists a matching stale completion for an explicit same-material retry', async () => {
    const store = new MemoryStorage()
    const attempt = beginAuditFence(store, 'user-a', 'job-a', 'resume-1', null)!
    expect(await confirmAuditFence(store, 'user-a', 'job-a', attempt, audit)).toBe(true)
    expect(await markAuditFenceRetryable(store, 'user-a', 'job-a', { state: 'stale', completedProof: receipt })).toBe(true)
    // A fresh read models reload; only identifiers and the digest are stored.
    expect(readAuditFence(store, 'user-a', 'job-a')).toMatchObject({ state: 'retryable', fence: { operationId, resumeId: 'resume-1' } })
    expect(store.getItem(store.key(0)!)).not.toContain('Private')
    expect(beginAuditFence(store, 'user-a', 'job-a', 'resume-1', null)).toBeNull()
    expect(beginRetryableAuditFence(store, 'user-a', 'job-a', ' ', null)).toBeNull()
    expect(beginRetryableAuditFence(store, 'user-a', 'job-a', 'resume-1', ' ')).toBeNull()
    expect(beginRetryableAuditFence(store, 'user-b', 'job-a', 'resume-1', null)).toBeNull()
    expect(beginRetryableAuditFence(store, 'user-a', 'job-b', 'resume-1', null)).toBeNull()
    const retry = beginRetryableAuditFence(store, 'user-a', 'job-a', 'resume-1', null)!
    expect(retry).not.toBe(attempt)
    expect(readAuditFence(store, 'user-a', 'job-a')).toMatchObject({ state: 'pending', fence: { attemptId: retry, expectedOperationId: operationId } })
    expect(await postApplicationAuditCorrection(store, 'user-a', 'job-a', retry, { resumeId: 'resume-1', coverLetterId: null, findingIndex: 0, auditOperationId: operationId })).toMatchObject({ data: null, preflightRejected: false })
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: 'Review changed', code: 'AUDIT_PREDECESSOR_CHANGED', auditAttemptId: retry }, { status: 409 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      expect(await postApplicationAudit(store, 'user-a', 'job-a', retry, { resumeId: 'resume-1' })).toMatchObject({ data: null, preflightRejected: false })
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(fetchMock.mock.calls[0][1].headers['X-Expected-Audit-Operation-Id']).toBe(operationId)
      expect(readAuditFence(store, 'user-a', 'job-a')).toMatchObject({ state: 'pending', fence: { attemptId: retry, expectedOperationId: operationId } })
    } finally { vi.unstubAllGlobals() }
  })

  it('does not use one retry handler precheck to release an uncertain duplicated attempt', async () => {
    const store = new MemoryStorage()
    const first = beginAuditFence(store, 'user-a', 'job-a', 'resume-1', null)!
    expect(await confirmAuditFence(store, 'user-a', 'job-a', first, audit)).toBe(true)
    expect(await markAuditFenceRetryable(store, 'user-a', 'job-a', { state: 'stale', completedProof: receipt })).toBe(true)
    const retry = beginRetryableAuditFence(store, 'user-a', 'job-a', 'resume-1', null)!
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'Too long', code: 'AUDIT_PRECHECK_NOT_REGISTERED', auditRegistration: 'not_started', auditAttemptId: retry }, { status: 422 })))
    try {
      expect((await postApplicationAudit(store, 'user-a', 'job-a', retry, { resumeId: 'resume-1' })).preflightRejected).toBe(false)
      expect(readAuditFence(store, 'user-a', 'job-a')).toMatchObject({ state: 'pending', fence: { attemptId: retry, expectedOperationId: operationId } })
    } finally { vi.unstubAllGlobals() }
  })

  it('can confirm a successful retry without persisting the predecessor as its new identity', async () => {
    const store = new MemoryStorage()
    const first = beginAuditFence(store, 'user-a', 'job-a', 'resume-1', null)!
    expect(await confirmAuditFence(store, 'user-a', 'job-a', first, audit)).toBe(true)
    expect(await markAuditFenceRetryable(store, 'user-a', 'job-a', { state: 'stale', completedProof: receipt })).toBe(true)
    const retry = beginRetryableAuditFence(store, 'user-a', 'job-a', 'resume-1', null)!
    const result = { ...audit, operationId: '123e4567-e89b-42d3-a456-426614174001', resumeUpdatedAt: '2026-11-05T12:02:00.000Z' }
    expect(await confirmAuditFence(store, 'user-a', 'job-a', retry, result)).toBe(true)
    expect(readAuditFence(store, 'user-a', 'job-a')).toMatchObject({ state: 'confirmed', fence: { attemptId: retry, operationId: result.operationId } })
    expect(store.getItem(store.key(0)!)).not.toContain('expectedOperationId')
  })

  it.each([
    ['plain stale', { state: 'stale' }],
    ['not stale', { state: 'pending', completedProof: receipt }],
    ['wrong operation', { state: 'stale', completedProof: { ...receipt, operationId: '123e4567-e89b-42d3-a456-426614174001' } }],
    ['wrong resume', { state: 'stale', completedProof: { ...receipt, resumeId: 'other' } }],
    ['wrong letter', { state: 'stale', completedProof: { ...receipt, coverLetterId: 'other' } }],
    ['wrong version', { state: 'stale', completedProof: { ...receipt, resumeUpdatedAt: '2026-11-05T12:02:00.000Z' } }],
    ['wrong digest', { state: 'stale', completedProof: { ...receipt, audit: { ...audit, summary: 'Changed' } } }],
    ['missing receipt', { state: 'stale', completedProof: { ...receipt, receipt: undefined } }],
    ['bad receipt', { state: 'stale', completedProof: { ...receipt, receipt: { version: 1, signature: 'not-a-signature' } } }],
  ])('retains the confirmed fence for %s', async (_label, proof) => {
    const store = new MemoryStorage()
    const attempt = beginAuditFence(store, 'user-a', 'job-a', 'resume-1', null)!
    expect(await confirmAuditFence(store, 'user-a', 'job-a', attempt, audit)).toBe(true)
    expect(await markAuditFenceRetryable(store, 'user-a', 'job-a', proof)).toBe(false)
    expect(readAuditFence(store, 'user-a', 'job-a').state).toBe('confirmed')
  })

  it('does not release pending, unavailable, another scope, or a newer attempt', async () => {
    const store = new MemoryStorage()
    const attempt = beginAuditFence(store, 'user-a', 'job-a', 'resume-1', null)!
    const proof = { state: 'stale', completedProof: receipt }
    expect(await markAuditFenceRetryable(store, 'user-a', 'job-a', proof)).toBe(false)
    expect(await markAuditFenceRetryable(null, 'user-a', 'job-a', proof)).toBe(false)
    expect(await confirmAuditFence(store, 'user-a', 'job-a', attempt, audit)).toBe(true)
    expect(await markAuditFenceRetryable(store, 'user-b', 'job-a', proof)).toBe(false)
    expect(await markAuditFenceRetryable(store, 'user-a', 'job-b', proof)).toBe(false)
    const late = markAuditFenceRetryable(store, 'user-a', 'job-a', proof)
    store.clear()
    const newer = beginAuditFence(store, 'user-a', 'job-a', 'resume-1', null)!
    expect(await late).toBe(false)
    expect(readAuditFence(store, 'user-a', 'job-a')).toMatchObject({ state: 'pending', fence: { attemptId: newer } })
  })

  it('preserves a confirmed fence if storing the retryable state fails', async () => {
    const store = new MemoryStorage()
    const attempt = beginAuditFence(store, 'user-a', 'job-a', 'resume-1', null)!
    expect(await confirmAuditFence(store, 'user-a', 'job-a', attempt, audit)).toBe(true)
    vi.spyOn(store, 'setItem').mockImplementation(() => { throw new Error('denied') })
    expect(await markAuditFenceRetryable(store, 'user-a', 'job-a', { state: 'stale', completedProof: receipt })).toBe(false)
    expect(readAuditFence(store, 'user-a', 'job-a').state).toBe('confirmed')
  })

  it('does not let a late response overwrite a newer attempt', async () => {
    const store = new MemoryStorage()
    const old = beginAuditFence(store, 'user-a', 'job-a', 'resume-1', null)!
    const late = confirmAuditFence(store, 'user-a', 'job-a', old, audit)
    store.clear()
    const newer = beginAuditFence(store, 'user-a', 'job-a', 'resume-1', null)!
    expect(newer).not.toBe(old)
    expect(await late).toBe(false)
    expect(readAuditFence(store, 'user-a', 'job-a')).toMatchObject({ state: 'pending', fence: { attemptId: newer } })
  })

  it('fails closed on missing storage, denied writes, or malformed persisted state', () => {
    const store = new MemoryStorage()
    expect(readAuditFence(null, 'user-a', 'job-a').state).toBe('unavailable')
    expect(beginAuditFence(null, 'user-a', 'job-a', 'resume-1', null)).toBeNull()
    const denied = new MemoryStorage()
    vi.spyOn(denied, 'setItem').mockImplementation(() => { throw new Error('denied') })
    expect(beginAuditFence(denied, 'user-a', 'job-a', 'resume-1', null)).toBeNull()
    store.setItem('applymate:audit-fence:user-a:job-a', '{bad')
    expect(readAuditFence(store, 'user-a', 'job-a').state).toBe('unavailable')
    expect(beginAuditFence(store, 'user-a', 'job-a', 'resume-1', null)).toBeNull()
  })

  it('requires and compares the selected letter and its revision', async () => {
    const store = new MemoryStorage()
    const attempt = beginAuditFence(store, 'user-a', 'job-a', 'resume-1', 'letter-1')!
    expect(await confirmAuditFence(store, 'user-a', 'job-a', attempt, audit)).toBe(false)
    const letterAudit = { ...audit, coverLetterUpdatedAt: '2026-11-05T12:00:01.000Z' }
    expect(await confirmAuditFence(store, 'user-a', 'job-a', attempt, letterAudit)).toBe(true)
    expect(await reconcileAuditFence(store, 'user-a', 'job-a', { ...receipt, coverLetterId: 'letter-2', coverLetterUpdatedAt: letterAudit.coverLetterUpdatedAt })).toBe(false)
    expect(await reconcileAuditFence(store, 'user-a', 'job-a', { ...receipt, coverLetterId: 'letter-1', coverLetterUpdatedAt: letterAudit.coverLetterUpdatedAt })).toBe(true)
  })

  it('recovers a stale corrected letter only for its exact selected identity and version', async () => {
    const store = new MemoryStorage()
    const attempt = beginAuditFence(store, 'user-a', 'job-a', 'resume-1', 'letter-1')!
    const result = { ...audit, coverLetterUpdatedAt: '2026-11-05T12:00:01.000Z' }
    expect(await confirmAuditFence(store, 'user-a', 'job-a', attempt, result)).toBe(true)
    const proof = { ...receipt, audit: result, coverLetterId: 'letter-1', coverLetterUpdatedAt: result.coverLetterUpdatedAt }
    expect(await markAuditFenceRetryable(store, 'user-a', 'job-a', { state: 'stale', completedProof: { ...proof, coverLetterUpdatedAt: '2026-11-05T12:00:02.000Z' } })).toBe(false)
    expect(await markAuditFenceRetryable(store, 'user-a', 'job-a', { state: 'stale', completedProof: proof })).toBe(true)
    expect(beginRetryableAuditFence(store, 'user-a', 'job-a', 'resume-1', 'letter-1')).toBeTruthy()
  })

  it.each([
    ['different resume', null, 'resume-2', null],
    ['add letter', null, 'resume-1', 'letter-2'],
    ['remove letter', 'letter-1', 'resume-1', null],
    ['replace letter', 'letter-1', 'resume-1', 'letter-2'],
  ] as const)('explicitly retries with %s while retaining the verified predecessor', async (_case, oldLetterId, nextResumeId, nextLetterId) => {
    const store = new MemoryStorage()
    const first = beginAuditFence(store, 'user-a', 'job-a', 'resume-1', oldLetterId)!
    const result = oldLetterId ? { ...audit, coverLetterUpdatedAt: '2026-11-05T12:00:01.000Z' } : audit
    expect(await confirmAuditFence(store, 'user-a', 'job-a', first, result)).toBe(true)
    const proof = { ...receipt, audit: result, coverLetterId: oldLetterId, ...(oldLetterId ? { coverLetterUpdatedAt: result.coverLetterUpdatedAt } : {}) }
    expect(await markAuditFenceRetryable(store, 'user-a', 'job-a', { state: 'stale', completedProof: proof })).toBe(true)
    expect(beginAuditFence(store, 'user-a', 'job-a', nextResumeId, nextLetterId)).toBeNull()
    expect(beginRetryableAuditFence(store, 'other-user', 'job-a', nextResumeId, nextLetterId)).toBeNull()
    expect(beginRetryableAuditFence(store, 'user-a', 'other-job', nextResumeId, nextLetterId)).toBeNull()
    const next = beginRetryableAuditFence(store, 'user-a', 'job-a', nextResumeId, nextLetterId)!
    expect(next).toBeTruthy()
    expect(readAuditFence(store, 'user-a', 'job-a')).toMatchObject({ state: 'pending', fence: { attemptId: next, resumeId: nextResumeId, coverLetterId: nextLetterId, expectedOperationId: operationId } })
    expect(beginRetryableAuditFence(store, 'user-a', 'job-a', nextResumeId, nextLetterId)).toBeNull()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'Review changed', code: 'AUDIT_PREDECESSOR_CHANGED', auditAttemptId: next }, { status: 409 })))
    try {
      expect((await postApplicationAudit(store, 'user-a', 'job-a', next, { resumeId: nextResumeId, coverLetterId: nextLetterId })).preflightRejected).toBe(false)
      expect(readAuditFence(store, 'user-a', 'job-a')).toMatchObject({ state: 'pending', fence: { attemptId: next, expectedOperationId: operationId } })
    } finally { vi.unstubAllGlobals() }
  })

  it('keeps an unresolved timeout fenced and records a late response without retrying', async () => {
    const store = new MemoryStorage()
    const attempt = beginAuditFence(store, 'user-a', 'job-a', 'resume-1', null)!
    let resolve!: (result: { data: AuditFencePost | null; error: string | null }) => void
    const request = new Promise<{ data: AuditFencePost | null; error: string | null }>(done => { resolve = done })
    vi.useFakeTimers()
    const waiting = waitForAuditFencePost(request, store, 'user-a', 'job-a', attempt, 50)
    await vi.advanceTimersByTimeAsync(50)
    expect(await waiting).toBeNull()
    expect(readAuditFence(store, 'user-a', 'job-a').state).toBe('pending')
    vi.useRealTimers()
    resolve({ data: audit, error: null })
    await vi.waitFor(() => expect(readAuditFence(store, 'user-a', 'job-a').state).toBe('confirmed'))
    expect(await reconcileAuditFence(store, 'user-a', 'job-a', receipt)).toBe(true)
  })

  it('does not clear a confirmed fence when storage refuses removal', async () => {
    const store = new MemoryStorage()
    const attempt = beginAuditFence(store, 'user-a', 'job-a', 'resume-1', null)!
    expect(await confirmAuditFence(store, 'user-a', 'job-a', attempt, audit)).toBe(true)
    vi.spyOn(store, 'removeItem').mockImplementation(() => { throw new Error('denied') })
    expect(await reconcileAuditFence(store, 'user-a', 'job-a', receipt)).toBe(false)
    expect(readAuditFence(store, 'user-a', 'job-a').state).toBe('confirmed')
  })

  it('notifies same-document listeners after registration, confirmation and reconciliation', async () => {
    const target = new EventTarget()
    const listener = vi.fn()
    target.addEventListener(APPLICATION_AUDIT_FENCE_EVENT, listener)
    vi.stubGlobal('window', target)
    try {
      const store = new MemoryStorage()
      const attempt = beginAuditFence(store, 'user-a', 'job-a', 'resume-1', null)!
      expect(await confirmAuditFence(store, 'user-a', 'job-a', attempt, audit)).toBe(true)
      expect(await reconcileAuditFence(store, 'user-a', 'job-a', receipt)).toBe(true)
      expect(listener).toHaveBeenCalledTimes(3)
    } finally { vi.unstubAllGlobals() }
  })

  it('releases only the same request on a certified pre-registration 422', async () => {
    const store = new MemoryStorage()
    const attempt = beginAuditFence(store, 'user-a', 'job-a', 'resume-1', null)!
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: 'Too long', code: 'AUDIT_PRECHECK_NOT_REGISTERED', auditRegistration: 'not_started', auditAttemptId: attempt }, { status: 422 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      expect(await postApplicationAudit(store, 'user-a', 'job-a', attempt, { resumeId: 'resume-1' })).toMatchObject({ data: null, error: 'Too long', preflightRejected: true })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0][1].headers['X-Application-Audit-Attempt-Id']).toBe(attempt)
      expect(readAuditFence(store, 'user-a', 'job-a').state).toBe('none')
    } finally { vi.unstubAllGlobals() }
  })

  it.each(['wrong-id', 'wrong-code', 'wrong-registration', 'wrong-status', 'missing-proof', 'network', 'old-attempt'] as const)(
    'retains the fence for untrusted or uncertain %s', async mode => {
      const store = new MemoryStorage()
      const old = beginAuditFence(store, 'user-a', 'job-a', 'resume-1', null)!
      if (mode === 'old-attempt') { store.clear(); beginAuditFence(store, 'user-a', 'job-a', 'resume-1', null) }
      const body = { error: 'Unavailable', code: mode === 'wrong-code' ? 'OTHER' : 'AUDIT_PRECHECK_NOT_REGISTERED', auditRegistration: mode === 'wrong-registration' ? 'unknown' : 'not_started', auditAttemptId: mode === 'wrong-id' ? operationId : old }
      const fetchMock = mode === 'network' ? vi.fn().mockRejectedValue(new Error('offline')) : vi.fn().mockResolvedValue(Response.json(mode === 'missing-proof' ? { error: 'Old service' } : body, { status: mode === 'wrong-status' ? 500 : 422 }))
      vi.stubGlobal('fetch', fetchMock)
      try {
        const result = await postApplicationAudit(store, 'user-a', 'job-a', old, { resumeId: 'resume-1' })
        expect(result.preflightRejected).toBe(false)
        expect(readAuditFence(store, 'user-a', 'job-a').state).toBe('pending')
        expect(fetchMock).toHaveBeenCalledTimes(mode === 'old-attempt' ? 0 : 1)
      } finally { vi.unstubAllGlobals() }
    },
  )

  it('does not remove a confirmed fence or a pending fence when storage denies removal', async () => {
    const confirmed = new MemoryStorage(), pending = new MemoryStorage()
    const first = beginAuditFence(confirmed, 'user-a', 'job-a', 'resume-1', null)!
    expect(await confirmAuditFence(confirmed, 'user-a', 'job-a', first, audit)).toBe(true)
    const second = beginAuditFence(pending, 'user-a', 'job-a', 'resume-1', null)!
    vi.spyOn(pending, 'removeItem').mockImplementation(() => { throw new Error('denied') })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, options: RequestInit) => Response.json({ error: 'Too long', code: 'AUDIT_PRECHECK_NOT_REGISTERED', auditRegistration: 'not_started', auditAttemptId: (options.headers as Record<string, string>)['X-Application-Audit-Attempt-Id'] }, { status: 422 })))
    try {
      expect((await postApplicationAudit(confirmed, 'user-a', 'job-a', first, { resumeId: 'resume-1' })).preflightRejected).toBe(false)
      expect((await postApplicationAudit(pending, 'user-a', 'job-a', second, { resumeId: 'resume-1' })).preflightRejected).toBe(false)
      expect(readAuditFence(confirmed, 'user-a', 'job-a').state).toBe('confirmed')
      expect(readAuditFence(pending, 'user-a', 'job-a').state).toBe('pending')
    } finally { vi.unstubAllGlobals() }
  })

  it('ignores an old certified response after a newer attempt owns the fence', async () => {
    const store = new MemoryStorage()
    const old = beginAuditFence(store, 'user-a', 'job-a', 'resume-1', null)!
    let release!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise<Response>(resolve => { release = resolve })))
    try {
      const pending = postApplicationAudit(store, 'user-a', 'job-a', old, { resumeId: 'resume-1' })
      store.clear()
      const newer = beginAuditFence(store, 'user-a', 'job-a', 'resume-1', null)!
      release(Response.json({ error: 'Too long', code: 'AUDIT_PRECHECK_NOT_REGISTERED', auditRegistration: 'not_started', auditAttemptId: old }, { status: 422 }))
      expect((await pending).preflightRejected).toBe(false)
      expect(readAuditFence(store, 'user-a', 'job-a')).toMatchObject({ state: 'pending', fence: { attemptId: newer } })
    } finally { vi.unstubAllGlobals() }
  })

  it('can release a matching certified response arriving after the UI timeout', async () => {
    const store = new MemoryStorage()
    const attempt = beginAuditFence(store, 'user-a', 'job-a', 'resume-1', null)!
    let release!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise<Response>(resolve => { release = resolve })))
    try {
      const request = postApplicationAudit(store, 'user-a', 'job-a', attempt, { resumeId: 'resume-1' })
      vi.useFakeTimers()
      const waiting = waitForAuditFencePost(request, store, 'user-a', 'job-a', attempt, 50)
      await vi.advanceTimersByTimeAsync(50)
      expect(await waiting).toBeNull()
      expect(readAuditFence(store, 'user-a', 'job-a').state).toBe('pending')
      vi.useRealTimers()
      release(Response.json({ error: 'Too long', code: 'AUDIT_PRECHECK_NOT_REGISTERED', auditRegistration: 'not_started', auditAttemptId: attempt }, { status: 422 }))
      await vi.waitFor(() => expect(readAuditFence(store, 'user-a', 'job-a').state).toBe('none'))
    } finally { vi.useRealTimers(); vi.unstubAllGlobals() }
  })
  it.each(['valid', 'wrong-id', 'wrong-code', 'wrong-marker', 'wrong-status', 'old-service', 'network'] as const)(
    'releases a correction only for its matching no-write certificate: %s', async mode => {
      const store = new MemoryStorage()
      const attempt = beginAuditFence(store, 'user-a', 'job-a', 'resume-1', null)!
      const response = { error: 'Review changed', code: mode === 'wrong-code' ? 'OTHER' : 'AUDIT_CORRECTION_NOT_STARTED', correctionWrite: mode === 'wrong-marker' ? 'unknown' : 'not_started', auditAttemptId: mode === 'wrong-id' ? operationId : attempt }
      const fetchMock = mode === 'network' ? vi.fn().mockRejectedValue(new Error('offline')) : vi.fn().mockResolvedValue(Response.json(mode === 'old-service' ? { error: 'Old service' } : response, { status: mode === 'wrong-status' ? 500 : 409 }))
      vi.stubGlobal('fetch', fetchMock)
      try {
        const result = await postApplicationAuditCorrection(store, 'user-a', 'job-a', attempt, { resumeId: 'resume-1', coverLetterId: null, findingIndex: 0, auditOperationId: operationId })
        expect(result.preflightRejected).toBe(mode === 'valid')
        expect(readAuditFence(store, 'user-a', 'job-a').state).toBe(mode === 'valid' ? 'none' : 'pending')
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(fetchMock.mock.calls[0][1].headers['X-Application-Audit-Attempt-Id']).toBe(attempt)
      } finally { vi.unstubAllGlobals() }
    },
  )

  it('does not clear a newer correction attempt when an old certificate arrives late', async () => {
    const store = new MemoryStorage()
    const old = beginAuditFence(store, 'user-a', 'job-a', 'resume-1', null)!
    let release!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise<Response>(resolve => { release = resolve })))
    try {
      const request = postApplicationAuditCorrection(store, 'user-a', 'job-a', old, { resumeId: 'resume-1', coverLetterId: null, findingIndex: 0, auditOperationId: operationId })
      store.clear()
      const newer = beginAuditFence(store, 'user-a', 'job-a', 'resume-1', null)!
      release(Response.json({ error: 'Review changed', code: 'AUDIT_CORRECTION_NOT_STARTED', correctionWrite: 'not_started', auditAttemptId: old }, { status: 409 }))
      expect((await request).preflightRejected).toBe(false)
      expect(readAuditFence(store, 'user-a', 'job-a')).toMatchObject({ state: 'pending', fence: { attemptId: newer } })
    } finally { vi.unstubAllGlobals() }
  })

})
