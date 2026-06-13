/**
 * GET  /api/activity  — activity feed for the current user
 * POST /api/activity  — create a new activity entry
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import type { ActivityType } from '@prisma/client'

export async function GET(req: NextRequest) {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const { searchParams } = req.nextUrl
  const limit = Math.min(50, Math.max(1, Number(searchParams.get('limit') ?? 20)))
  const jobId = searchParams.get('jobId')

  const activities = await db.activity.findMany({
    where: {
      userId: auth.userId,
      ...(jobId ? { jobId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { job: { select: { company: true, role: true } } },
  })

  return ok(activities)
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { type, text, jobId, color } = body
  if (!type || !text) return err('type and text are required')

  // Validate jobId belongs to user
  if (jobId) {
    const job = await db.job.findUnique({ where: { id: jobId } })
    if (!job || job.userId !== auth.userId) return err('Job not found', 404)
  }

  const activity = await db.activity.create({
    data: {
      userId: auth.userId,
      type:   type as ActivityType,
      text,
      jobId:  jobId ?? null,
      color:  color ?? null,
    },
  })

  return ok(activity, 201)
}
