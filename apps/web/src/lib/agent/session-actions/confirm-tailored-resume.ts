import type { Job, Prisma, Resume } from '@prisma/client'
import { acquireSourceMaterialFence } from '@/lib/agent/source-material-fence'

export type ConfirmTailoredResumePayload = { jobId: string; resumeId: string }

export type ConfirmTailoredResumeWriteResult =
  | { kind: 'saved'; job: Pick<Job, 'id' | 'company' | 'role' | 'url' | 'status'>; resume: Pick<Resume, 'id' | 'name'> }
  | { kind: 'missing' }
  | { kind: 'already_submitted' }

/** Revalidates and writes the approved final-resume selection under the user's source fence. */
export async function confirmTailoredResumeSourceWrite(
  tx: Prisma.TransactionClient,
  userId: string,
  payload: ConfirmTailoredResumePayload,
): Promise<ConfirmTailoredResumeWriteResult> {
  await acquireSourceMaterialFence(tx, [userId])

  const lockedJobs = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Job"
    WHERE "id" = ${payload.jobId} AND "userId" = ${userId}
    FOR UPDATE
  `
  if (lockedJobs.length !== 1) return { kind: 'missing' }

  const job = await tx.job.findFirst({
    where: { id: payload.jobId, userId },
    select: { id: true, company: true, role: true, url: true, status: true },
  })
  const resume = await tx.resume.findFirst({
    where: { id: payload.resumeId, userId, targetJobId: payload.jobId },
    select: { id: true, name: true },
  })
  if (!job || !resume) return { kind: 'missing' }
  if (job.status === 'applied') return { kind: 'already_submitted' }

  const updated = await tx.job.updateMany({
    where: { id: job.id, userId },
    data: {
      finalResumeId: resume.id,
      status: 'saved',
      workflowState: 'ready_to_apply',
      analysisNote: job.url
        ? '[Application ready] Open the employer form, use the ApplyMate extension to fill it, then review and submit it yourself.'
        : '[Application ready] Missing application URL.',
    },
  })
  if (updated.count !== 1) return { kind: 'missing' }

  return { kind: 'saved', job, resume }
}
