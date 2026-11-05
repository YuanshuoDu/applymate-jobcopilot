import type { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, isErrorResponse, err } from '@/lib/api-helpers'
import { AUDIT_ACTIVITY_PREFIX, parseStoredApplicationAudit } from '@/lib/application-audit'
import { verifyApplicationAuditReceipt } from '@/lib/application-audit-receipt'
import { hasCurrentApplicationPackAudit, renderApplicationPack } from '@/lib/application-pack'
import { renderApplicationPackPrintHtml } from '@/lib/application-pack-print'
import { UnsupportedPdfTextError } from '@/lib/pdf-text-support'
import type { CoverLetter, Resume } from '@/lib/types'

export const runtime = 'nodejs'
export const maxDuration = 60

type Params = { params: Promise<{ id: string }> }

async function loadAuditedPack(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth
  const { id: jobId } = await params
  const job = await db.job.findFirst({ where: { id: jobId, userId: auth.userId } })
  if (!job) return err('Job not found.', 404)
  if (!job.finalResumeId) return err('Select and audit a final resume before downloading.', 409)

  const [resume, coverLetter, activity] = await Promise.all([
    db.resume.findFirst({ where: { id: job.finalResumeId, userId: auth.userId } }),
    job.finalCoverLetterId
      ? db.coverLetter.findFirst({ where: { id: job.finalCoverLetterId, jobId, userId: auth.userId } })
      : Promise.resolve(null),
    db.activity.findFirst({
      where: { userId: auth.userId, jobId, text: { startsWith: AUDIT_ACTIVITY_PREFIX } },
      orderBy: { createdAt: 'desc' }, select: { text: true },
    }),
  ])
  if (!resume || (job.finalCoverLetterId && !coverLetter)) return err('Final application documents could not be found.', 404)
  const audit = parseStoredApplicationAudit(activity?.text ?? '')
  if (!verifyApplicationAuditReceipt({ userId: auth.userId, jobId }, audit)
    || !hasCurrentApplicationPackAudit(audit, job, resume, coverLetter)) {
    return err('The selected document versions must pass a factual audit before downloading or printing. Recheck the audit after editing or if an older audit is no longer trusted.', 409)
  }
  return { job, resume: resume as unknown as Resume, coverLetter: coverLetter as unknown as CoverLetter | null, audit }
}

export async function POST(req: NextRequest, params: Params) {
  const result = await loadAuditedPack(req, params)
  if (isErrorResponse(result)) return result
  const { job, resume, coverLetter, audit } = result
  try {
    const pack = await renderApplicationPack(job, resume, coverLetter, audit)
    return new Response(pack.bytes, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="ApplyMate-application-pack.zip"; filename*=UTF-8''${encodeURIComponent(pack.filename)}`,
        'Cache-Control': 'no-store, private',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    if (error instanceof UnsupportedPdfTextError) return err(error.message, 422)
    console.error('[/api/jobs/application-pack] PDF rendering failed', error)
    return err('Could not generate the application PDFs. Please try again.', 500)
  }
}

/** The same gate protects the Unicode-capable browser printing alternative. */
export async function GET(req: NextRequest, params: Params) {
  const result = await loadAuditedPack(req, params)
  if (isErrorResponse(result)) return result
  return new Response(renderApplicationPackPrintHtml(result.job, result.resume, result.coverLetter), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  })
}
