/**
 * GET  /api/jobs/[id]/cover-letters  — list cover letters for a job
 * POST /api/jobs/[id]/cover-letters  — create a blank draft
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'

type Params = { params: Promise<{ id: string }> }

// ── GET ───────────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { id: jobId } = await params

  const job = await db.job.findFirst({ where: { id: jobId, userId: auth.userId } })
  if (!job) return err('Not found', 404)

  const coverLetters = await db.coverLetter.findMany({
    where:   { jobId, userId: auth.userId },
    orderBy: { createdAt: 'desc' },
  })

  return ok(coverLetters)
}

// ── POST ──────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { id: jobId } = await params

  const job = await db.job.findFirst({ where: { id: jobId, userId: auth.userId } })
  if (!job) return err('Not found', 404)

  const body = await req.json().catch(() => ({}))
  const { resumeId, tone = 'professional', content = '' } = body as {
    resumeId?: string
    tone?: string
    content?: string
  }

  const coverLetter = await db.coverLetter.create({
    data: {
      userId:   auth.userId,
      jobId,
      resumeId: resumeId ?? null,
      content,
      tone,
      origin:   'manual',
      isFinal:  false,
    },
  })

  return ok(coverLetter, 201)
}
