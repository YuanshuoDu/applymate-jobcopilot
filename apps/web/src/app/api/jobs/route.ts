/**
 * GET  /api/jobs  — list jobs for the current user
 * POST /api/jobs  — create a new job
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { JOB_STATUSES, type JobStatus, type JobStatusCounts } from '@/lib/types'

const MIN_EXTENSION_DESCRIPTION_LENGTH = 80

// ── GET ───────────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const { searchParams } = req.nextUrl
  const requestedStatus = searchParams.get('status')
  if (requestedStatus && !isJobStatus(requestedStatus)) return err('Invalid job status')
  const status        = requestedStatus as JobStatus | null
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

  const [jobs, total, groupedStatusCounts] = await Promise.all([
    db.job.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.job.count({ where }),
    db.job.groupBy({
      by: ['status'],
      where: { userId: auth.userId },
      _count: { _all: true },
    }),
  ])

  const statusCounts: JobStatusCounts = {
    saved: 0,
    applied: 0,
    interview: 0,
    offer: 0,
    rejected: 0,
  }
  for (const group of groupedStatusCounts) {
    if (isJobStatus(group.status)) statusCounts[group.status] = group._count._all
  }

  const repairedJobs = await Promise.all(jobs.map(async job => {
    const repairedRole = repairLinkedInDismissRole(job.role, job.source)
    if (!repairedRole) return job
    return db.job.update({ where: { id: job.id }, data: { role: repairedRole } })
  }))

  return ok({ jobs: repairedJobs, total, page, pageSize, statusCounts })
}

// ── POST ──────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { company, role, location, url, description, salary, source, score, status, logo } = body
  const canonicalUrl = canonicalizeJobUrl(url, source)

  if (!company || !role) return err('company and role are required')
  if (status !== undefined && !isJobStatus(status)) return err('Invalid job status')
  if (isExtensionSaveRequest(req) && !hasMinimumDescription(description)) {
    return err(
      'Job description could not be captured. Wait for the full job details to load, then retry Save to ApplyMate.',
      422,
    )
  }

  if (canonicalUrl) {
    const existing = await db.job.findFirst({ where: { userId: auth.userId, url: canonicalUrl } })
    if (existing) {
      const job = await db.job.update({
        where: { id: existing.id },
      data: {
          ...(shouldRepairCompany(existing.company, role, company) ? { company } : {}),
          ...(shouldRepairRole(existing.role, company, role) ? { role } : {}),
          ...(description ? { description } : {}),
          ...(shouldUpdateLocation(existing.location, location) ? { location } : {}),
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
      url:         canonicalUrl ?? null,
      description: description ?? null,
      salary:      salary      ?? null,
      source:      source      ?? 'manual',
      score:       score       ?? null,
      status:      status      ?? 'saved',
      workflowState: status && status !== 'saved' ? 'submitted' : 'draft',
      logo:        logo ?? company.slice(0, 2).toUpperCase(),
    },
  })

  // Log activity
  await db.activity.create({
    data: {
      userId: auth.userId,
      jobId:  job.id,
      type:   'note_added',
      text:   `Saved ${company} · ${role}`,
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

/**
 * List and detail pages often use different tracking URLs for the same job.
 * Store the provider's vacancy ID when available so the POST dedupe remains
 * effective after an extension restart or a page refresh.
 */
function canonicalizeJobUrl(value: unknown, source: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value)
    const provider = typeof source === 'string' ? source.toLowerCase() : ''
    if (provider === 'linkedin') {
      const id = url.searchParams.get('currentJobId') ||
        url.pathname.match(/\/jobs\/view\/(?:[^/?#]*-)?(\d{5,})(?:[/?#]|$)/i)?.[1]
      if (id) return `${url.origin}/jobs/view/${id}/`
    }
    if (provider === 'indeed') {
      const id = url.searchParams.get('jk') || url.searchParams.get('vjk')
      if (id) return `${url.origin}/viewjob?jk=${encodeURIComponent(id)}`
    }
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|trk|ref|source|campaign)/i.test(key)) url.searchParams.delete(key)
    }
    return url.href
  } catch {
    return value.trim()
  }
}

function isExtensionSaveRequest(req: NextRequest): boolean {
  return /^Bearer\s+/i.test(req.headers.get('authorization') ?? '')
}

function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && JOB_STATUSES.includes(value as JobStatus)
}

function hasMinimumDescription(value: unknown): value is string {
  return typeof value === 'string'
    && value.replace(/\s/g, '').length >= MIN_EXTENSION_DESCRIPTION_LENGTH
}

function shouldUpdateLocation(existingLocation: string | null, incomingLocation: unknown): incomingLocation is string {
  if (typeof incomingLocation !== 'string' || !incomingLocation.trim()) return false
  return !isMeaningfulLocation(existingLocation) || isMeaningfulLocation(incomingLocation)
}

function isMeaningfulLocation(value: unknown): value is string {
  return typeof value === 'string'
    && Boolean(value.trim())
    && !/^(unknown|n\/?a|not specified|unspecified)$/i.test(value.trim())
}

function repairLinkedInDismissRole(role: string, source: string | null): string | null {
  if (source !== 'linkedin') return null
  const match = role.trim().match(/^dismiss\s+(.+?)\s+job$/i)
  return match?.[1]?.trim() || null
}
