import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), query: vi.fn(), sourceFence: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { $transaction: mocks.transaction } }))
vi.mock('@/lib/agent/source-material-fence', () => ({ acquireSourceMaterialFence: mocks.sourceFence }))
import { AuditMaterialBusyError, lockApplicationAuditMaterials, withApplicationAuditLock } from './application-audit-transaction'

const scope = { userId: 'user_1', jobId: 'job_1' }

describe('application audit transaction', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.sourceFence.mockResolvedValue(undefined)
    mocks.transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback({ $queryRaw: mocks.query }))
  })

  it('runs a decision only after locking the owned job', async () => {
    mocks.query.mockResolvedValue([{ id: 'job_1' }])
    const decision = vi.fn().mockResolvedValue('locked')
    await expect(withApplicationAuditLock(scope, decision)).resolves.toBe('locked')
    expect(mocks.sourceFence).not.toHaveBeenCalled()
    expect(mocks.query.mock.calls[0][0].strings.join('?')).toContain('FOR UPDATE')
    expect(mocks.query.mock.calls[0][0].values).toEqual(['job_1', 'user_1'])
    expect(decision).toHaveBeenCalledTimes(1)
  })

  it('acquires the optional source fence before the owned job lock and callback', async () => {
    const order: string[] = []
    mocks.sourceFence.mockImplementation(async (_tx: unknown, userIds: readonly string[]) => {
      expect(userIds).toEqual(['user_1'])
      order.push('source_fence')
    })
    mocks.query.mockImplementation(async () => { order.push('job_lock'); return [{ id: 'job_1' }] })
    const decision = vi.fn(async () => { order.push('callback'); return 'locked' })

    await expect(withApplicationAuditLock(scope, decision, { sourceMaterialFence: true })).resolves.toBe('locked')

    expect(order).toEqual(['source_fence', 'job_lock', 'callback'])
    expect(mocks.sourceFence).toHaveBeenCalledTimes(1)
    expect(mocks.query.mock.calls[0][0].values).toEqual(['job_1', 'user_1'])
  })

  it('does not read the job or run the callback when the optional source fence fails', async () => {
    const failure = new Error('source fence unavailable')
    mocks.sourceFence.mockRejectedValue(failure)
    const decision = vi.fn()

    await expect(withApplicationAuditLock(scope, decision, { sourceMaterialFence: true })).rejects.toBe(failure)

    expect(mocks.query).not.toHaveBeenCalled()
    expect(decision).not.toHaveBeenCalled()
  })

  it('does not run a decision for an absent or foreign job', async () => {
    mocks.query.mockResolvedValue([])
    const decision = vi.fn()
    await expect(withApplicationAuditLock(scope, decision)).resolves.toBeNull()
    expect(decision).not.toHaveBeenCalled()
  })

  it('locks the owned resume before the job-scoped letter and stops on a missing row', async () => {
    mocks.query.mockResolvedValueOnce([{ id: 'resume_1' }]).mockResolvedValueOnce([{ id: 'letter_1' }])
    const tx = { $queryRaw: mocks.query } as never
    await expect(lockApplicationAuditMaterials(tx, scope, 'resume_1', 'letter_1')).resolves.toBe(true)
    expect(mocks.query.mock.calls[0][0].values).toEqual(['resume_1', 'user_1'])
    expect(mocks.query.mock.calls[1][0].values).toEqual(['letter_1', 'user_1', 'job_1'])
    expect(mocks.query.mock.calls[0][0].strings.join('?')).toContain('FOR UPDATE NOWAIT')
    expect(mocks.query.mock.calls[1][0].strings.join('?')).toContain('FOR UPDATE NOWAIT')
    mocks.query.mockReset().mockResolvedValueOnce([])
    await expect(lockApplicationAuditMaterials(tx, scope, 'resume_1', 'letter_1')).resolves.toBe(false)
    expect(mocks.query).toHaveBeenCalledTimes(1)
  })

  it('maps only the database lock-not-available SQLSTATE after transaction failure', async () => {
    mocks.transaction.mockRejectedValueOnce({ code: 'P2010', meta: { code: '55P03' } })
    await expect(withApplicationAuditLock(scope, vi.fn())).rejects.toBeInstanceOf(AuditMaterialBusyError)
    const other = { code: 'P2010', meta: { code: '23505' } }
    mocks.transaction.mockRejectedValueOnce(other)
    await expect(withApplicationAuditLock(scope, vi.fn())).rejects.toBe(other)
  })
})
