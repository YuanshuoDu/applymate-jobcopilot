/**
 * GET  /api/jobs  — list jobs for the current user
 * POST /api/jobs  — create a new job
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import type { JobStatus } from '@prisma/client'

// ── GET ───────────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { searchParams } = req.nextUrl
  const status        = searchParams.get('status') as JobStatus | null
  const source        = searchParams.get('source')
  const q             = searchParams.get('q')              // text search
  const finalResumeId = searchParams.get('finalResumeId')  // M4: reverse-link filter
  const page     = Math.max(1, Number(searchParams.get('page') ?? 1))
  const pageSize = Math.min(100, Math.max(1, Number(searchParams.get('pageSize') ?? 50)))

  const where = {
    userId: auth.userId,
    ...(status        ? { status }        : {}),
    ...(source        ? { source }        : {}),
    ...(finalResumeId ? { finalResumeId } : {}),
    ...(q
      ? {
          OR: [
            { company: { contains: q, mode: 'insensitive' as const } },
            { role:    { contains: q, mode: 'insensitive' as const } },
            { location:{ contains: q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  }

  const [jobs, total] = await Promise.all([
    db.job.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.job.count({ where }),
  ])

  return ok({ jobs, total, page, pageSize })
}

// ── POST ──────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { company, role, location, url, description, salary, source, score, status, logo } = body

  if (!company || !role) return err('company and role are required')

  const job = await db.job.create({
    data: {
      userId:      auth.userId,
      company,
      role,
      location:    location    ?? null,
      url:         url         ?? null,
      description: description ?? null,
      salary:      salary      ?? null,
      source:      source      ?? 'manual',
      score:       score       ?? null,
      status:      status      ?? 'saved',
      logo:        logo ?? company.slice(0, 2).toUpperCase(),
    },
  })

  // Log activity
  await db.activity.create({
    data: {
      userId: auth.userId,
      jobId:  job.id,
      type:   'applied',
      text:   `Added ${company} · ${role}`,
      color:  '#185FA5',
    },
  })

  return ok(job, 201)
}
