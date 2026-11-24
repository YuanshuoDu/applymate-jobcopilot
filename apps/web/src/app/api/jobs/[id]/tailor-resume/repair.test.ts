import type { Prisma } from '@prisma/client'
import type { ApplicationAuditFinding } from '@/lib/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readAuditOperation: vi.fn(),
  lockApplicationAuditMaterials: vi.fn(),
  auditJobBasisHash: vi.fn(),
  auditMaterialBasisHash: vi.fn(),
}))

vi.mock('@/lib/application-audit-operation', () => ({
  readAuditOperation: mocks.readAuditOperation,
  auditJobBasisHash: mocks.auditJobBasisHash,
  auditMaterialBasisHash: mocks.auditMaterialBasisHash,
}))
vi.mock('@/lib/application-audit-transaction', () => ({
  lockApplicationAuditMaterials: mocks.lockApplicationAuditMaterials,
}))

import { guardedRepairBasis, sectionsForAuditRepair } from './repair'

const scope = { userId: 'user_1', jobId: 'job_1' }
const updatedAt = new Date('2026-06-01T12:00:00.000Z')
const operationId = '11111111-1111-4111-8111-111111111111'

function auditFinding(overrides: Partial<ApplicationAuditFinding> = {}): ApplicationAuditFinding {
  return { area: 'resume', severity: 'critical', title: 'Improve experience', evidence: 'Work history', action: 'Add role scope', ...overrides }
}

function transaction(resumeUpdatedAt = updatedAt) {
  const job = { finalResumeId: 'resume_1', finalCoverLetterId: null, role: 'Engineer', company: 'Example', description: 'Build systems.' }
  const resume = { id: 'resume_1', updatedAt: resumeUpdatedAt, name: 'Tailored', content: { summary: 'Current' }, templateId: null, templateOptions: null }
  const tx = {
    job: { findFirst: vi.fn().mockResolvedValue(job) },
    resume: { findFirst: vi.fn().mockResolvedValue(resume) },
    coverLetter: { findFirst: vi.fn() },
  }
  return { tx: tx as unknown as Prisma.TransactionClient, job, resume }
}

describe('forced resume repair admission', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.readAuditOperation.mockResolvedValue({
      kind: 'completed', operationId, jobBasisHash: 'job-hash', materialBasisHash: 'material-hash',
      audit: { receipt: { signature: 'receipt-signature' }, resumeId: 'resume_1', coverLetterId: null, resumeUpdatedAt: updatedAt.toISOString(), coverLetterUpdatedAt: null },
    })
    mocks.lockApplicationAuditMaterials.mockResolvedValue(true)
    mocks.auditJobBasisHash.mockReturnValue('job-hash')
    mocks.auditMaterialBasisHash.mockReturnValue('material-hash')
  })

  it('rechecks the exact completed receipt and current owned materials', async () => {
    const { tx, job, resume } = transaction()
    const result = await guardedRepairBasis(tx, scope, 'resume_1', 'receipt-signature', operationId)

    expect(result).toEqual({ operation: expect.objectContaining({ operationId }), job, resume, letter: null })
    expect(mocks.readAuditOperation).toHaveBeenCalledWith(tx, scope)
    expect(mocks.lockApplicationAuditMaterials).toHaveBeenCalledWith(tx, scope, 'resume_1', null)
    expect(tx.job.findFirst).toHaveBeenCalledWith({ where: { id: 'job_1', userId: 'user_1' } })
    expect(tx.resume.findFirst).toHaveBeenCalledWith({ where: { id: 'resume_1', userId: 'user_1' } })
  })

  it('rejects a changed Resume timestamp or a material lock miss', async () => {
    const changed = transaction(new Date('2026-06-01T12:00:01.000Z'))
    await expect(guardedRepairBasis(changed.tx, scope, 'resume_1', 'receipt-signature', operationId)).resolves.toBeNull()

    mocks.lockApplicationAuditMaterials.mockResolvedValue(false)
    const unlocked = transaction()
    await expect(guardedRepairBasis(unlocked.tx, scope, 'resume_1', 'receipt-signature', operationId)).resolves.toBeNull()
    expect(unlocked.tx.job.findFirst).not.toHaveBeenCalled()
  })

  it('maps only an explicit or uniquely inferred resume section', () => {
    expect(sectionsForAuditRepair([auditFinding({ target: 'summary', title: 'Unrelated wording' })])).toEqual(['summary'])
    expect(sectionsForAuditRepair([auditFinding({ title: 'Improve experience' })])).toEqual(['experience'])
    expect(sectionsForAuditRepair([auditFinding({ title: 'Improve experience summary' })])).toBeNull()
    expect(sectionsForAuditRepair([auditFinding({ target: 'cover_letter' })])).toBeNull()
  })
})
