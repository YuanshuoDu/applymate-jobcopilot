import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'

type AuditScope = { userId: string; jobId: string }

export class AuditMaterialBusyError extends Error {
  constructor() { super('Application materials are being changed') }
}

function lockNotAvailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { code?: unknown; meta?: { code?: unknown }; cause?: unknown }
  return value.code === '55P03' || value.meta?.code === '55P03' || (value.cause !== error && lockNotAvailable(value.cause))
}

/** A short tenant-scoped transaction serializes decisions for one application. */
export async function withApplicationAuditLock<T>(scope: AuditScope, run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T | null> {
  try {
    return await db.$transaction(async tx => {
      const jobs = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "Job" WHERE "id" = ${scope.jobId} AND "userId" = ${scope.userId} FOR UPDATE
      `)
      return jobs.length === 1 ? run(tx) : null
    })
  } catch (error) {
    if (lockNotAvailable(error)) throw new AuditMaterialBusyError()
    throw error
  }
}

/** Always acquire material locks in the same order, after the application lock. */
export async function lockApplicationAuditMaterials(
  tx: Prisma.TransactionClient, scope: AuditScope, resumeId: string, coverLetterId: string | null,
): Promise<boolean> {
  const resumes = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "Resume" WHERE "id" = ${resumeId} AND "userId" = ${scope.userId} FOR UPDATE NOWAIT
  `)
  if (resumes.length !== 1) return false
  if (!coverLetterId) return true
  const letters = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "CoverLetter" WHERE "id" = ${coverLetterId} AND "userId" = ${scope.userId}
      AND "jobId" = ${scope.jobId} FOR UPDATE NOWAIT
  `)
  return letters.length === 1
}
