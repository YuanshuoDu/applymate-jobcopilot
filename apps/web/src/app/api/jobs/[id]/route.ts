/**
 * GET    /api/jobs/:id  — get a single job
 * PATCH  /api/jobs/:id  — update status, notes, followUpAt, etc.
 * DELETE /api/jobs/:id  — delete a job
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { acquireSourceMaterialFence } from '@/lib/agent/source-material-fence'
import type { JobStatus } from '@prisma/client'

type Params = { params: Promise<{ id: string }> }

const JOB_STATUSES: JobStatus[] = ['saved', 'applied', 'interview', 'offer', 'rejected']

function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && JOB_STATUSES.includes(value as JobStatus)
}

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
  const result = await db.$transaction(async tx => {
    await acquireSourceMaterialFence(tx, [auth.userId])
    const existing = await tx.job.findFirst({ where: { id, userId: auth.userId } })
    if (!existing) return { response: err('Not found', 404) }

    const body = await req.json().catch(() => null)
    if (!body) return { response: err('Invalid JSON body') }

    if (typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'expectedEmptyDescription')) {
      const keys = Object.keys(body)
      const expected = body.expectedEmptyDescription
      const description = body.description
      if (keys.length !== 2 || !keys.includes('description')
        || (expected !== null && (typeof expected !== 'string' || expected.trim() !== ''))
        || typeof description !== 'string' || !description.trim()) {
        return { response: err('Provide a non-empty description and the original empty description only', 400) }
      }
      const updated = await tx.job.updateMany({
        where: { id, userId: auth.userId, description: expected },
        data: { description },
      })
      if (updated.count !== 1) {
        return { response: err('The job description changed. Refresh and review it before trying again.', 409) }
      }
      return { response: ok({ id, userId: auth.userId, description }) }
    }

    const allowedFields = ['status', 'notes', 'followUpAt', 'salary', 'score', 'url', 'description', 'location', 'keywords']
    const data: Record<string, unknown> = {}
    for (const field of allowedFields) {
      if (field in body) data[field] = body[field]
    }

    if ('status' in data && !isJobStatus(data.status)) {
      return { response: err('Invalid job status') }
    }

    // Kanban status is tracking only. A manual submission record is created by
    // the canonical /apply endpoint after the candidate explicitly confirms it.
    if (data.status && data.status !== 'applied') data.workflowState = data.status === 'saved' ? 'draft' : 'submitted'

    const job = await tx.job.update({ where: { id, userId: auth.userId }, data })
    return { job, existing, data }
  })

  if (result.response) return result.response

  // Log status change
  if ('status' in result.data && result.data.status !== result.existing.status) {
    const statusLabels: Record<JobStatus, string> = {
      saved: 'Saved', applied: 'Applied',
      interview: 'Interview', offer: 'Offer received', rejected: 'Rejected',
    }
    await db.activity.create({
      data: {
        userId: auth.userId,
        jobId:  id,
        type:   'status_changed',
        text:   `${result.existing.company} moved to ${statusLabels[result.data.status as JobStatus]}`,
        color:  '#854F0B',
      },
    })
  }

  return ok(result.job)
}

// ── DELETE ────────────────────────────────────────────────────────────────────
export async function DELETE(_req: NextRequest, { params }: Params) {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const { id } = await params
  return db.$transaction(async tx => {
    await acquireSourceMaterialFence(tx, [auth.userId])
    const existing = await tx.job.findFirst({ where: { id, userId: auth.userId } })
    if (!existing) return err('Not found', 404)

    await tx.job.delete({ where: { id, userId: auth.userId } })
    return ok({ deleted: true })
  })
}
