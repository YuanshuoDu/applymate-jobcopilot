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
  if (!body || typeof body !== 'object' || Array.isArray(body)) return err('Invalid JSON body')
  const input = body as Record<string, unknown>
  const rawResumeId = input.resumeId
  const resumeId = typeof rawResumeId === 'string' ? rawResumeId.trim() : null
  const tone = typeof input.tone === 'string' && input.tone.trim() ? input.tone.trim() : 'professional'
  const content = typeof input.content === 'string' ? input.content : ''
  if (rawResumeId !== undefined && (!resumeId || typeof rawResumeId !== 'string')) return err('resumeId must be a non-empty string')

  if (resumeId) {
    const resume = await db.resume.findFirst({
      where: { id: resumeId, userId: auth.userId },
      select: { id: true },
    })
    if (!resume) return err('Resume not found', 404)
  }

  const coverLetter = await db.coverLetter.create({
    data: {
      userId:   auth.userId,
      jobId,
      resumeId,
      content,
      tone,
      origin:   'manual',
      isFinal:  false,
    },
  })

  return ok(coverLetter, 201)
}
