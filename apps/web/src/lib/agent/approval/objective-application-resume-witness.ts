import type { Prisma } from '@prisma/client'
import {
  buildObjectiveApplicationResumeWitness,
  type ObjectiveApplicationResumeMaterial,
  type ObjectiveApplicationResumeWitness,
} from '@jobcopilot/shared'

export type ObjectiveApplicationResumeWitnessScope = Readonly<{ userId: string; jobId: string }>

/**
 * Reads one assigned, job-adapted Resume inside the caller's transaction.
 * The caller must acquire the source-material fence before calling this reader
 * and keep the transaction open through the approval decision write.
 */
export async function readObjectiveApplicationResumeWitness(
  tx: Prisma.TransactionClient,
  scope: ObjectiveApplicationResumeWitnessScope,
): Promise<ObjectiveApplicationResumeWitness | null> {
  if (!validScope(scope)) return null

  const rows = await tx.$queryRaw<unknown[]>`
    SELECT job."id" AS "jobId", job."userId", job."finalResumeId",
      job."finalResumeAssignmentRevision", resume."id" AS "resumeId",
      resume."userId" AS "resumeUserId", resume."name", resume."content",
      resume."templateId", resume."templateOptions", resume."kind", resume."targetJobId",
      resume."parentResumeId", resume."basicsDetached", resume."materialRevision"
    FROM "Job" AS job
    INNER JOIN "Resume" AS resume
      ON resume."id" = job."finalResumeId"
      AND resume."userId" = job."userId"
      AND resume."targetJobId" = job."id"
      AND resume."kind" = 'adapted'
    WHERE job."id" = ${scope.jobId} AND job."userId" = ${scope.userId}
    FOR SHARE OF job, resume
  `
  if (!Array.isArray(rows) || rows.length !== 1 || !isRecord(rows[0])) return null
  const row = rows[0]
  if (row.jobId !== scope.jobId || row.userId !== scope.userId
    || typeof row.finalResumeId !== 'string' || typeof row.resumeId !== 'string' || row.resumeId !== row.finalResumeId
    || row.resumeUserId !== scope.userId || row.targetJobId !== scope.jobId || row.kind !== 'adapted'
    || typeof row.name !== 'string' || !(row.templateId === null || typeof row.templateId === 'string')
    || !(row.parentResumeId === null || typeof row.parentResumeId === 'string') || typeof row.basicsDetached !== 'boolean'
    || !validRevision(row.finalResumeAssignmentRevision) || !validRevision(row.materialRevision)) return null

  const material: ObjectiveApplicationResumeMaterial = {
    name: row.name,
    content: row.content,
    templateId: row.templateId,
    templateOptions: row.templateOptions,
    kind: row.kind,
    targetJobId: row.targetJobId,
    parentResumeId: row.parentResumeId,
    basicsDetached: row.basicsDetached,
  }
  return buildObjectiveApplicationResumeWitness({
    userId: scope.userId,
    jobId: scope.jobId,
    resumeId: row.resumeId,
    finalResumeAssignmentRevision: row.finalResumeAssignmentRevision,
    materialRevision: row.materialRevision,
    material,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validScope(value: unknown): value is ObjectiveApplicationResumeWitnessScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const scope = value as Record<string, unknown>
  return typeof scope.userId === 'string' && scope.userId.trim().length > 0 && scope.userId === scope.userId.trim() && scope.userId.length <= 256
    && typeof scope.jobId === 'string' && scope.jobId.trim().length > 0 && scope.jobId === scope.jobId.trim() && scope.jobId.length <= 256
}

function validRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
