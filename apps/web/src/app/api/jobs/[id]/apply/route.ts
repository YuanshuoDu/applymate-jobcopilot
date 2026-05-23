/**
 * POST /api/jobs/[id]/apply
 * User confirms they manually applied to a job.
 * Updates status to 'applied' and sets appliedAt.
 */
import { NextRequest }                          from 'next/server'
import { db }                                    from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { id } = await params
  const job = await db.job.findFirst({ where: { id, userId: auth.userId } })
  if (!job) return err('Job not found', 404)

  await db.job.update({
    where: { id },
    data:  { status: 'applied', appliedAt: new Date() },
  })

  await db.activity.create({
    data: {
      userId: auth.userId,
      jobId:  id,
      type:   'applied',
      text:   `你手动申请了 ${job.company} · ${job.role}`,
      color:  '#059669',
    },
  })

  return ok({ applied: true })
}
