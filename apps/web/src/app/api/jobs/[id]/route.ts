/**
 * GET    /api/jobs/:id  — get a single job
 * PATCH  /api/jobs/:id  — update status, notes, followUpAt, etc.
 * DELETE /api/jobs/:id  — delete a job
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import type { JobStatus } from '@prisma/client'

type Params = { params: Promise<{ id: string }> }

// ── GET ───────────────────────────────────────────────────────────────────────
export async function GET(_req: NextRequest, { params }: Params) {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const { id } = await params
  const job = await db.job.findUnique({ where: { id } })
  if (!job || job.userId !== auth.userId) return err('Not found', 404)

  return ok(job)
}

// ── PATCH ─────────────────────────────────────────────────────────────────────
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const { id } = await params
  const existing = await db.job.findUnique({ where: { id } })
  if (!existing || existing.userId !== auth.userId) return err('Not found', 404)

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const allowedFields = [('status', 'notes', 'followUpAt', 'salary', 'score', 'url', 'description', 'location', 'keywords')]
  const data: Record<string, unknown> = {}
  for (const field of allowedFields) {
    if (field in body) data[field] = body[field]
  }

  const job = await db.job.update({ where: { id }, data })

  // Log status change
  if ('status' in data && data.status !== existing.status) {
    const statusLabels: Record<JobStatus, string> = {
      saved: 'Saved', applied: 'Applied', review: 'In Review',
      interview: 'Interview', offer: 'Offer received', rejected: 'Rejected',
    }
    await db.activity.create({
      data: {
        userId: auth.userId,
        jobId:  id,
        type:   'status_changed',
        text:   `${existing.company} moved to ${statusLabels[data.status as JobStatus]}`,
        color:  '#854F0B',
      },
    })

    // Set appliedAt when status becomes 'applied'
    if (data.status === 'applied' && !existing.appliedAt) {
      await db.job.update({ where: { id }, data: { appliedAt: new Date() } })
    }
  }

  return ok(job)
}

// ── DELETE ────────────────────────────────────────────────────────────────────
export async function DELETE(_req: NextRequest, { params }: Params) {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const { id } = await params
  const existing = await db.job.findUnique({ where: { id } })
  if (!existing || existing.userId !== auth.userId) return err('Not found', 404)

  await db.job.delete({ where: { id } })
  return ok({ deleted: true })
}
