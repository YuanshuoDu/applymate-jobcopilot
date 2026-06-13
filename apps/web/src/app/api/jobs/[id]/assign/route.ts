/**
 * PATCH /api/jobs/:id/assign
 * Body: { finalResumeId?: string | null, finalCoverLetterId?: string | null }
 *
 * Transactional: when finalCoverLetterId changes, syncs isFinal on CoverLetter rows.
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { id } = await params
  const job = await db.job.findFirst({ where: { id, userId: auth.userId } })
  if (!job) return err('Not found', 404)

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { finalResumeId, finalCoverLetterId } = body as {
    finalResumeId?: string | null
    finalCoverLetterId?: string | null
  }

  const updated = await db.$transaction(async (tx) => {
    // Handle CoverLetter isFinal side-effects
    if ('finalCoverLetterId' in body) {
      if (finalCoverLetterId) {
        // Verify CL belongs to this job + user
        const cl = await tx.coverLetter.findFirst({
          where: { id: finalCoverLetterId, jobId: id, userId: auth.userId },
        })
        if (!cl) throw new Error('CoverLetter not found')
        // Set new final
        await tx.coverLetter.update({
          where: { id: finalCoverLetterId },
          data:  { isFinal: true },
        })
        // Clear siblings
        await tx.coverLetter.updateMany({
          where: { jobId: id, id: { not: finalCoverLetterId } },
          data:  { isFinal: false },
        })
      } else {
        // Clearing final — unset all
        await tx.coverLetter.updateMany({
          where: { jobId: id },
          data:  { isFinal: false },
        })
      }
    }

    const data: Record<string, unknown> = {}
    if ('finalResumeId' in body)      data.finalResumeId      = finalResumeId      ?? null
    if ('finalCoverLetterId' in body) data.finalCoverLetterId = finalCoverLetterId ?? null

    return tx.job.update({ where: { id }, data })
  })

  return ok(updated)
}
