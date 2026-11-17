import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import {
  auditJobBasisHash,
  auditMaterialBasisHash,
  readAuditOperation,
  registerAuditOperation,
  staleAuditOperation,
} from '@/lib/application-audit-operation'
import { lockApplicationAuditMaterials, withApplicationAuditLock } from '@/lib/application-audit-transaction'

export type AuditScope = { userId: string; jobId: string }

type ExistingAdaptedResume = {
  id: string
  parentResumeId: string | null
  content: unknown
  name: string
  updatedAt: Date
}

export async function guardedRepairBasis(
  tx: Prisma.TransactionClient,
  scope: AuditScope,
  resumeId: string,
  signature: string,
  operationId: string,
) {
  const operation = await readAuditOperation(tx, scope)
  if (operation.kind !== 'completed' || operation.operationId !== operationId
    || operation.audit.receipt?.signature !== signature || operation.audit.resumeId !== resumeId) return null
  if (!await lockApplicationAuditMaterials(tx, scope, resumeId, operation.audit.coverLetterId)) return null
  const [job, resume, letter] = await Promise.all([
    tx.job.findFirst({ where: { id: scope.jobId, userId: scope.userId } }),
    tx.resume.findFirst({ where: { id: resumeId, userId: scope.userId } }),
    operation.audit.coverLetterId
      ? tx.coverLetter.findFirst({ where: { id: operation.audit.coverLetterId, jobId: scope.jobId, userId: scope.userId } })
      : null,
  ])
  const iso = (value: Date | undefined) => value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null
  if (!job || !resume || (operation.audit.coverLetterId && !letter)
    || (job.finalResumeId && job.finalResumeId !== resumeId)
    || (job.finalCoverLetterId ?? null) !== operation.audit.coverLetterId
    || !operation.audit.resumeUpdatedAt || iso(resume.updatedAt) !== operation.audit.resumeUpdatedAt
    || (letter ? !operation.audit.coverLetterUpdatedAt || iso(letter.updatedAt) !== operation.audit.coverLetterUpdatedAt : Boolean(operation.audit.coverLetterUpdatedAt))
    || operation.jobBasisHash !== auditJobBasisHash(job)
    || operation.materialBasisHash !== auditMaterialBasisHash(resume, letter)) return null
  return { operation, job, resume, letter }
}

export type PersistAdaptedResumeResult =
  | { kind: 'saved'; adapted: { id: string; name: string } }
  | { kind: 'conflict' }
  | { kind: 'job-missing' }

type PersistAdaptedResumeInput = {
  scope: AuditScope
  job: { id: string; company: string; role: string; description: string | null; keywords: string | null; finalResumeId: string | null }
  sourceResume: {
    id: string
    content: unknown
    updatedAt: Date
    templateId: string | null
    templateOptions: Prisma.JsonValue | null
    directionId: string | null
    basicsDetached: boolean | null
  }
  existing: ExistingAdaptedResume | null
  forceRetailor: boolean
  repairBasis: Awaited<ReturnType<typeof guardedRepairBasis>>
  auditReceiptSignature?: string
  auditOperationId?: string
  adaptedContent: unknown
}

export async function persistAdaptedResume(input: PersistAdaptedResumeInput): Promise<PersistAdaptedResumeResult> {
  const { scope, job, sourceResume, existing, forceRetailor, repairBasis } = input
  const result = await withApplicationAuditLock(scope, async tx => {
    const currentJob = await tx.job.findFirst({
      where: { id: scope.jobId, userId: scope.userId },
      select: { company: true, role: true, description: true, keywords: true },
    })
    if (!currentJob || currentJob.company !== job.company || currentJob.role !== job.role
      || currentJob.description !== job.description || currentJob.keywords !== job.keywords) return { kind: 'conflict' } as const
    if (!await lockApplicationAuditMaterials(tx, scope, sourceResume.id, null)) return { kind: 'conflict' } as const
    const currentSource = await tx.resume.findFirst({
      where: {
        id: sourceResume.id,
        userId: scope.userId,
        updatedAt: sourceResume.updatedAt,
        content: { equals: sourceResume.content as Prisma.InputJsonValue },
      },
      select: { id: true },
    })
    if (!currentSource) return { kind: 'conflict' } as const

    if (existing && forceRetailor) {
      if (!input.auditReceiptSignature || !input.auditOperationId) return { kind: 'conflict' } as const
      const current = await guardedRepairBasis(tx, scope, existing.id, input.auditReceiptSignature, input.auditOperationId)
      if (!current || !repairBasis || current.operation.operationId !== repairBasis.operation.operationId
        || current.job.keywords !== job.keywords || current.job.finalResumeId !== repairBasis.job.finalResumeId) return { kind: 'conflict' } as const
      const update = await tx.resume.updateMany({
        where: {
          id: existing.id,
          userId: scope.userId,
          targetJobId: scope.jobId,
          kind: 'adapted',
          origin: 'ai-adapted',
          parentResumeId: existing.parentResumeId,
          updatedAt: existing.updatedAt,
          content: { equals: existing.content as Prisma.InputJsonValue },
        },
        data: { content: input.adaptedContent as Prisma.InputJsonValue },
      })
      if (update.count !== 1) return { kind: 'conflict' } as const
      await tx.resumeVersion.create({
        data: { resumeId: existing.id, userId: scope.userId, content: existing.content as Prisma.InputJsonValue, name: existing.name },
      })
      const invalidation = await registerAuditOperation(tx, scope)
      if (!await staleAuditOperation(tx, scope, invalidation)) throw new Error('Could not invalidate the previous audit')
      return { kind: 'saved', adapted: existing } as const
    }

    const adapted = await tx.resume.create({
      data: {
        userId: scope.userId,
        name: `Tailored for ${job.company} - ${job.role}`,
        content: input.adaptedContent as Prisma.InputJsonValue,
        templateId: sourceResume.templateId,
        templateOptions: sourceResume.templateOptions ?? undefined,
        isDefault: false,
        directionId: sourceResume.directionId,
        kind: 'adapted',
        parentResumeId: sourceResume.id,
        targetJobId: job.id,
        origin: 'ai-adapted',
        basicsDetached: sourceResume.basicsDetached ?? false,
      },
    })
    return { kind: 'saved', adapted } as const
  }, { sourceMaterialFence: true })

  if (!result) return forceRetailor ? { kind: 'conflict' } : { kind: 'job-missing' }
  if (result.kind !== 'saved') return result
  await db.activity.create({
    data: {
      userId: scope.userId,
      jobId: job.id,
      type: 'resume_tailored',
      text: `${forceRetailor ? 'Revised' : 'Created'} tailored resume "${result.adapted.name}"`,
      color: '#3B6D11',
    },
  }).catch(() => null)
  return result
}
