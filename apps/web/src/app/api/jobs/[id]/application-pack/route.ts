import type { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, err } from '@/lib/api-helpers'
import { auditJobBasisHash, auditMaterialBasisHash, readAuditOperation } from '@/lib/application-audit-operation'
import { AuditMaterialBusyError, lockApplicationAuditMaterials, withApplicationAuditLock } from '@/lib/application-audit-transaction'
import { hasCurrentApplicationPackAudit, renderApplicationPack } from '@/lib/application-pack'
import { renderApplicationPackPrintHtml } from '@/lib/application-pack-print'
import { UnsupportedPdfTextError } from '@/lib/pdf-text-support'
import { isApplicationPdfUnsupportedCharactersError } from '@/lib/application-pdf-errors'
import type { CoverLetter, Resume } from '@/lib/types'

export const runtime = 'nodejs'
export const maxDuration = 60

type Params = { params: Promise<{ id: string }> }

async function loadAuditedPack(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth
  const { id: jobId } = await params
  const scope = { userId: auth.userId, jobId }
  try {
    const snapshot = await withApplicationAuditLock(scope, async tx => {
      const job = await tx.job.findFirst({ where: { id: jobId, userId: auth.userId } })
      if (!job) return err('Job not found.', 404)
      if (!job.finalResumeId) return err('Select and audit a final resume before downloading.', 409)
      if (!await lockApplicationAuditMaterials(tx, scope, job.finalResumeId, job.finalCoverLetterId)) {
        return err('Final application documents could not be found.', 404)
      }
      const resume = await tx.resume.findFirst({ where: { id: job.finalResumeId, userId: auth.userId } })
      const coverLetter = job.finalCoverLetterId
        ? await tx.coverLetter.findFirst({ where: { id: job.finalCoverLetterId, jobId, userId: auth.userId } })
        : null
      if (!resume || (job.finalCoverLetterId && !coverLetter)) return err('Final application documents could not be found.', 404)
      const operation = await readAuditOperation(tx, scope)
      const audit = operation.kind === 'completed' && operation.jobBasisHash === auditJobBasisHash(job)
        && operation.materialBasisHash === auditMaterialBasisHash(resume, coverLetter) ? operation.audit : null
      if (!hasCurrentApplicationPackAudit(audit, job, resume, coverLetter)) {
        return err('The selected document versions must pass a factual audit before downloading or printing. Recheck the audit after editing or if an older audit is no longer trusted.', 409)
      }
      return { job, resume: resume as unknown as Resume, coverLetter: coverLetter as unknown as CoverLetter | null, audit }
    })
    return snapshot ?? err('Job not found.', 404)
  } catch (error) {
    return error instanceof AuditMaterialBusyError
      ? err('The application materials are being changed. Refresh before downloading or printing.', 409)
      : err('Could not verify the application materials. Please refresh and try again.', 503)
  }
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
    if (error instanceof UnsupportedPdfTextError || isApplicationPdfUnsupportedCharactersError(error)) {
      return err('The PDF fonts cannot represent every character in these documents. Use Print view / Save as PDF and check the preview before saving.', 422)
    }
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
