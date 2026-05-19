/**
 * PATCH  /api/cover-letters/[id]  — update content or tone
 * DELETE /api/cover-letters/[id]  — delete, and clear finalCoverLetterId on job if needed
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'

type Params = { params: Promise<{ id: string }> }

// ── PATCH ─────────────────────────────────────────────────────────────────────
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { id } = await params

  const existing = await db.coverLetter.findFirst({
    where: { id, userId: auth.userId },
  })
  if (!existing) return err('Not found', 404)

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { content, tone } = body as { content?: string; tone?: string }

  const data: Record<string, unknown> = {}
  if (content !== undefined) data.content = content
  if (tone    !== undefined) data.tone    = tone

  const updated = await db.coverLetter.update({ where: { id }, data })
  return ok(updated)
}

// ── DELETE ────────────────────────────────────────────────────────────────────
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { id } = await params

  const cl = await db.coverLetter.findFirst({ where: { id, userId: auth.userId } })
  if (!cl) return err('Not found', 404)

  // If this CL is the final one, clear the pointer on the job
  if (cl.isFinal) {
    await db.job.updateMany({
      where: { id: cl.jobId, finalCoverLetterId: cl.id },
      data:  { finalCoverLetterId: null },
    })
  }

  await db.coverLetter.delete({ where: { id } })
  return new NextResponse(null, { status: 204 })
}
