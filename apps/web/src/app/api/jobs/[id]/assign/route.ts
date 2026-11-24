/**
 * PATCH /api/jobs/:id/assign
 * Body: { finalResumeId?: string | null, finalCoverLetterId?: string | null }
 *
 * Transactional: when finalCoverLetterId changes, syncs isFinal on CoverLetter rows.
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { acquireSourceMaterialFence } from '@/lib/agent/source-material-fence'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { id } = await params
  const body: unknown = await req.json().catch(() => null)

  const updated = await db.$transaction(async (tx) => {
    await acquireSourceMaterialFence(tx, [auth.userId])
    const job = await tx.job.findFirst({ where: { id, userId: auth.userId } })
    if (!job) return err('Not found', 404)
    if (!body || typeof body !== 'object' || Array.isArray(body)) return err('Invalid JSON body')

    const { finalResumeId, finalCoverLetterId } = body as {
      finalResumeId?: string | null
      finalCoverLetterId?: string | null
    }

    if (finalResumeId) {
      const resume = await tx.resume.findFirst({
        where: { id: finalResumeId, userId: auth.userId, OR: [{ isDefault: true }, { targetJobId: id }] },
        select: { id: true },
      })
      if (!resume) return err('Resume not found', 400)
    }

    // Handle CoverLetter isFinal side-effects
    if ('finalCoverLetterId' in body) {
      if (finalCoverLetterId) {
        // Verify CL belongs to this job + user
        const cl = await tx.coverLetter.findFirst({
          where: { id: finalCoverLetterId, jobId: id, userId: auth.userId },
        })
        if (!cl) throw new Error('CoverLetter not found')
        // Selection metadata does not edit the audited document. Preserve its
        // content revision, without masking a concurrent content edit.
        if (!cl.isFinal) {
          const selected = await tx.coverLetter.updateMany({
            where: { id: finalCoverLetterId, jobId: id, userId: auth.userId, updatedAt: cl.updatedAt },
            data: { isFinal: true, updatedAt: cl.updatedAt },
          })
          if (selected.count !== 1) throw new Error('CoverLetter changed during selection')
        }
        // Clear siblings
        await tx.coverLetter.updateMany({
          where: { jobId: id, userId: auth.userId, id: { not: finalCoverLetterId }, isFinal: true },
          data:  { isFinal: false },
        })
      } else {
        // Clearing final — unset all
        await tx.coverLetter.updateMany({
          where: { jobId: id, userId: auth.userId, isFinal: true },
          data:  { isFinal: false },
        })
      }
    }

    const data: Record<string, unknown> = {}
    if ('finalResumeId' in body)      data.finalResumeId      = finalResumeId      ?? null
    if ('finalCoverLetterId' in body) data.finalCoverLetterId = finalCoverLetterId ?? null

    return tx.job.update({ where: { id, userId: auth.userId }, data })
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message === 'CoverLetter changed during selection') {
      return err('The cover letter changed while selecting it. Review it and run the audit again.', 409)
    }
    if (error instanceof Error && error.message === 'CoverLetter not found') return err('Cover letter not found', 404)
    throw error
  })

  if (isErrorResponse(updated)) return updated
  return ok(updated)
}
