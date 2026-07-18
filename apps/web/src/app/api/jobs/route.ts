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

  const repairedJobs = await Promise.all(jobs.map(async job => {
    const repairedRole = repairLinkedInDismissRole(job.role, job.source)
    if (!repairedRole) return job
    return db.job.update({ where: { id: job.id }, data: { role: repairedRole } })
  }))

  return ok({ jobs: repairedJobs, total, page, pageSize })
}

// ── POST ──────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { company, role, location, url, description, salary, source, score, status, logo } = body

  if (!company || !role) return err('company and role are required')

  if (url) {
    const existing = await db.job.findFirst({ where: { userId: auth.userId, url } })
    if (existing) {
      const job = await db.job.update({
        where: { id: existing.id },
      data: {
          ...(shouldRepairCompany(existing.company, role, company) ? { company } : {}),
          ...(shouldRepairRole(existing.role, company, role) ? { role } : {}),
          ...(description ? { description } : {}),
          ...(location ? { location } : {}),
          ...(salary ? { salary } : {}),
          ...(score != null ? { score } : {}),
        },
      })
      return ok(job)
    }
  }

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

// ── DELETE ───────────────────────────────────────────────────────────────────
// Deletes only jobs owned by the authenticated user. The single-job endpoint
// remains available for the detail drawer; this endpoint powers list bulk actions.
export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  const inputIds: unknown[] = Array.isArray(body?.ids) ? body.ids : []
  const ids = [...new Set(inputIds.filter((id): id is string => typeof id === 'string'))]
  if (!ids.length) return err('At least one job id is required')
  if (ids.length > 100) return err('A maximum of 100 jobs can be deleted at once')

  const result = await db.job.deleteMany({ where: { userId: auth.userId, id: { in: ids } } })
  return ok({ deleted: result.count })
}

function isMalformedSavedText(value: string | null): boolean {
  return !value || /^(unknown|company\s*for\b|dismiss\b|save\b)/i.test(value.trim())
}

function isMalformedIncomingText(value: unknown): boolean {
  return typeof value !== 'string' || !value.trim() || /^(unknown|company\s*for\b|dismiss\b|save\b)/i.test(value.trim())
}

function shouldRepairCompany(existingCompany: string | null, incomingRole: unknown, incomingCompany: unknown): boolean {
  if (isMalformedIncomingText(incomingCompany)) return false
  return isMalformedSavedText(existingCompany) || normalizedText(existingCompany) === normalizedText(incomingRole)
}

function shouldRepairRole(existingRole: string | null, incomingCompany: unknown, incomingRole: unknown): boolean {
  if (isMalformedIncomingText(incomingRole)) return false
  return isMalformedSavedText(existingRole) || normalizedText(existingRole) === normalizedText(incomingCompany)
}

function normalizedText(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]+/g, '') : ''
}

function repairLinkedInDismissRole(role: string, source: string | null): string | null {
  if (source !== 'linkedin') return null
  const match = role.trim().match(/^dismiss\s+(.+?)\s+job$/i)
  return match?.[1]?.trim() || null
}
