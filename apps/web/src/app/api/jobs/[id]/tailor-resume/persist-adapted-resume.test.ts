import { beforeEach, describe, expect, it, vi } from 'vitest'
import { guardedRepairBasis, persistAdaptedResume } from './persist-adapted-resume'
import type { AuditScope } from './persist-adapted-resume'

const signature = 'a'.repeat(64)
const operationId = '11111111-1111-4111-8111-111111111111'
const updateTime = new Date('2026-01-01T00:00:00Z')
const scope: AuditScope = { userId: 'authenticated-user', jobId: 'job_1' }
const job = { id: 'job_1', company: 'Acme', role: 'Engineer', description: 'Build systems.', keywords: 'TypeScript', finalResumeId: null, finalCoverLetterId: null }
const sourceResume = { id: 'resume_base', content: { summary: 'Original' }, updatedAt: updateTime, templateId: null, templateOptions: null, directionId: null, basicsDetached: false }

const mocks = vi.hoisted(() => ({
  withAuditLock: vi.fn(),
  lockMaterials: vi.fn(),
  readAudit: vi.fn(),
  registerAudit: vi.fn(),
  staleAudit: vi.fn(),
  resumeCreate: vi.fn(),
  resumeFindFirst: vi.fn(),
  resumeUpdateMany: vi.fn(),
  resumeVersionCreate: vi.fn(),
  jobFindFirst: vi.fn(),
  coverLetterFindFirst: vi.fn(),
  activityCreate: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ db: { activity: { create: mocks.activityCreate } } }))
vi.mock('@/lib/application-audit-operation', () => ({
  auditJobBasisHash: () => 'job-hash',
  auditMaterialBasisHash: () => 'material-hash',
  readAuditOperation: mocks.readAudit,
  registerAuditOperation: mocks.registerAudit,
  staleAuditOperation: mocks.staleAudit,
}))
vi.mock('@/lib/application-audit-transaction', () => ({
  lockApplicationAuditMaterials: mocks.lockMaterials,
  withApplicationAuditLock: mocks.withAuditLock,
}))

function transactionClient() {
  return {
    job: { findFirst: mocks.jobFindFirst },
    resume: { create: mocks.resumeCreate, findFirst: mocks.resumeFindFirst, updateMany: mocks.resumeUpdateMany },
    resumeVersion: { create: mocks.resumeVersionCreate },
    coverLetter: { findFirst: mocks.coverLetterFindFirst },
  }
}

function basisFixture() {
  return {
    kind: 'completed',
    operationId,
    jobBasisHash: 'job-hash',
    materialBasisHash: 'material-hash',
    audit: {
      receipt: { signature },
      resumeId: 'resume_adapted',
      coverLetterId: null,
      resumeUpdatedAt: updateTime.toISOString(),
      coverLetterUpdatedAt: null,
    },
  }
}

function existingFixture() {
  return {
    id: 'resume_adapted',
    parentResumeId: sourceResume.id,
    content: { summary: 'Before' },
    name: 'Tailored',
    updatedAt: updateTime,
  }
}

describe('persistAdaptedResume', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.withAuditLock.mockImplementation(async (_scope, run) => run(transactionClient()))
    mocks.lockMaterials.mockResolvedValue(true)
    mocks.readAudit.mockResolvedValue(basisFixture())
    mocks.registerAudit.mockResolvedValue('operation-next')
    mocks.staleAudit.mockResolvedValue(true)
    mocks.resumeCreate.mockResolvedValue({ id: 'resume_new', name: 'Tailored for Acme - Engineer' })
    mocks.resumeFindFirst.mockResolvedValue({ id: sourceResume.id, content: sourceResume.content, updatedAt: sourceResume.updatedAt })
    mocks.resumeUpdateMany.mockResolvedValue({ count: 1 })
    mocks.resumeVersionCreate.mockResolvedValue({})
    mocks.jobFindFirst.mockResolvedValue(job)
    mocks.coverLetterFindFirst.mockResolvedValue(null)
    mocks.activityCreate.mockResolvedValue({})
  })

  it('creates through the fenced transaction using the authenticated tenant and keeps Activity outside it', async () => {
    const tx = transactionClient()
    const order: string[] = []
    mocks.withAuditLock.mockImplementation(async (...args) => {
      order.push('transaction')
      const [, run, options] = args as [AuditScope, (tx: unknown) => Promise<unknown>, { sourceMaterialFence?: true }]
      expect(options).toEqual({ sourceMaterialFence: true })
      const result = await run(tx)
      order.push('transaction-complete')
      return result
    })
    mocks.resumeCreate.mockImplementation(async () => ({ id: 'resume_new', name: 'Tailored for Acme - Engineer' }))
    mocks.activityCreate.mockImplementation(async () => { order.push('activity'); return {} })

    const result = await persistAdaptedResume({
      scope,
      job,
      sourceResume,
      existing: null,
      forceRetailor: false,
      repairBasis: null,
      adaptedContent: { summary: 'After' },
    })

    expect(result).toEqual({ kind: 'saved', adapted: { id: 'resume_new', name: 'Tailored for Acme - Engineer' } })
    expect(mocks.withAuditLock).toHaveBeenCalledWith(scope, expect.any(Function), { sourceMaterialFence: true })
    expect(mocks.resumeCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: scope.userId, targetJobId: scope.jobId, parentResumeId: sourceResume.id, kind: 'adapted' }) })
    expect(mocks.jobFindFirst.mock.invocationCallOrder[0]).toBeLessThan(mocks.lockMaterials.mock.invocationCallOrder[0])
    expect(mocks.lockMaterials.mock.invocationCallOrder[0]).toBeLessThan(mocks.resumeFindFirst.mock.invocationCallOrder[0])
    expect(order).toEqual(['transaction', 'transaction-complete', 'activity'])
  })

  it('uses the same fenced transaction for repair, version history, and audit invalidation', async () => {
    const existing = existingFixture()
    const tx = transactionClient()
    mocks.withAuditLock.mockImplementation(async (_scope, run, options) => {
      expect(options).toEqual({ sourceMaterialFence: true })
      return run(tx)
    })
    const repairBasis = await guardedRepairBasis(tx as never, scope, existing.id, signature, operationId)
    expect(repairBasis).not.toBeNull()

    const result = await persistAdaptedResume({
      scope,
      job,
      sourceResume,
      existing,
      forceRetailor: true,
      repairBasis,
      auditReceiptSignature: signature,
      auditOperationId: operationId,
      adaptedContent: { summary: 'After' },
    })

    expect(result).toEqual({ kind: 'saved', adapted: existing })
    expect(mocks.withAuditLock).toHaveBeenLastCalledWith(scope, expect.any(Function), { sourceMaterialFence: true })
    expect(mocks.resumeUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: existing.id, userId: scope.userId, targetJobId: scope.jobId }) }))
    expect(mocks.resumeVersionCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ resumeId: existing.id, userId: scope.userId, content: existing.content }) })
    expect(mocks.registerAudit).toHaveBeenCalledWith(tx, scope)
    expect(mocks.staleAudit).toHaveBeenCalledWith(tx, scope, 'operation-next')
    expect(mocks.resumeCreate).not.toHaveBeenCalled()
  })

  it('propagates failed fence acquisition before writing or creating Activity', async () => {
    mocks.withAuditLock.mockRejectedValue(new Error('fence failed'))

    await expect(persistAdaptedResume({
      scope,
      job,
      sourceResume,
      existing: null,
      forceRetailor: false,
      repairBasis: null,
      adaptedContent: { summary: 'After' },
    })).rejects.toThrow('fence failed')

    expect(mocks.resumeCreate).not.toHaveBeenCalled()
    expect(mocks.resumeUpdateMany).not.toHaveBeenCalled()
    expect(mocks.resumeVersionCreate).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
  })

  it.each(['company', 'role', 'description', 'keywords'] as const)('rejects Job %s drift before creating an adapted Resume', async field => {
    mocks.withAuditLock.mockImplementation(async (_scope, run, options) => {
      expect(options).toEqual({ sourceMaterialFence: true })
      const changedValue = field === 'keywords' ? 'Changed after model work.' : `Changed ${field} after model work.`
      mocks.jobFindFirst.mockResolvedValueOnce({ ...job, [field]: changedValue })
      return run(transactionClient())
    })

    const result = await persistAdaptedResume({
      scope,
      job,
      sourceResume,
      existing: null,
      forceRetailor: false,
      repairBasis: null,
      adaptedContent: { summary: 'After' },
    })

    expect(result).toEqual({ kind: 'conflict' })
    expect(mocks.resumeCreate).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
  })

  it.each([
    ['content', { id: sourceResume.id, userId: scope.userId, content: { summary: 'Changed after model work.' }, updatedAt: updateTime }],
    ['updatedAt', { id: sourceResume.id, userId: scope.userId, content: sourceResume.content, updatedAt: new Date('2026-01-02T00:00:00Z') }],
  ] as const)('rejects a still-existing source Resume with %s drift using the exact scoped snapshot predicate', async (_field, currentSource) => {
    const sourceWhere = {
      id: sourceResume.id,
      userId: scope.userId,
      updatedAt: sourceResume.updatedAt,
      content: { equals: sourceResume.content },
    }
    mocks.withAuditLock.mockImplementation(async (_scope, run, options) => {
      expect(options).toEqual({ sourceMaterialFence: true })
      mocks.resumeFindFirst.mockImplementationOnce(async (input: unknown) => {
        const args = input as { where: typeof sourceWhere; select: { id: true } }
        expect(args.where).toEqual(sourceWhere)
        const contentMatches = JSON.stringify(currentSource.content) === JSON.stringify(args.where.content.equals)
        const versionMatches = currentSource.updatedAt.getTime() === args.where.updatedAt.getTime()
        return currentSource.id === args.where.id && currentSource.userId === args.where.userId
          && contentMatches && versionMatches ? { id: currentSource.id } : null
      })
      return run(transactionClient())
    })

    const result = await persistAdaptedResume({
      scope,
      job,
      sourceResume,
      existing: null,
      forceRetailor: false,
      repairBasis: null,
      adaptedContent: { summary: 'After' },
    })

    expect(result).toEqual({ kind: 'conflict' })
    expect(mocks.resumeFindFirst).toHaveBeenCalledWith({ where: sourceWhere, select: { id: true } })
    expect(mocks.resumeCreate).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
  })

  it('rolls the correction forward only when all writes succeed', async () => {
    const existing = existingFixture()
    const tx = transactionClient()
    const repairBasis = await guardedRepairBasis(tx as never, scope, existing.id, signature, operationId)
    mocks.withAuditLock.mockImplementation(async (_scope, run, options) => {
      expect(options).toEqual({ sourceMaterialFence: true })
      return run(tx)
    })
    mocks.resumeVersionCreate.mockRejectedValue(new Error('version write failed'))

    await expect(persistAdaptedResume({
      scope,
      job,
      sourceResume,
      existing,
      forceRetailor: true,
      repairBasis,
      auditReceiptSignature: signature,
      auditOperationId: operationId,
      adaptedContent: { summary: 'After' },
    })).rejects.toThrow('version write failed')

    expect(mocks.activityCreate).not.toHaveBeenCalled()
    expect(mocks.registerAudit).not.toHaveBeenCalled()
  })
})
