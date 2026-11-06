/**
 * POST /api/jobs/:id/audit-application
 *
 * Independently audits the final resume, and the optional cover letter, against
 * the candidate's pre-tailoring source material and the job description. This
 * is a review gate, not a truth oracle: unsupported claims are blocked for the
 * candidate to fix.
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { prepareAiRoute, requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { runParsedAudit } from '@/lib/application-audit-model'
import { roleAiConfig } from '@/lib/agent/role-config'
import { buildPersona } from '@/lib/persona'
import { auditJobBasisHash, auditMaterialBasisHash, completeAuditOperation, failAuditOperation, readAuditOperation, registerAuditOperation } from '@/lib/application-audit-operation'
import { AUDIT_LIMIT_MESSAGES, auditCoverLetterFallbackName, checkAuditDocumentLimits, checkAuditEvidenceLimits } from '@/lib/application-audit-limits'
import { AuditMaterialBusyError, lockApplicationAuditMaterials, withApplicationAuditLock } from '@/lib/application-audit-transaction'
import type { ApplicationAudit, ResumeContent } from '@/lib/types'

type Params = { params: Promise<{ id: string }> }
type ApplicationAuditResponse = ApplicationAudit & {
  resumeUpdatedAt?: string
  coverLetterUpdatedAt?: string
}

function toText(content: ResumeContent): string {
  return JSON.stringify(content, null, 2)
}

function toIso(value: unknown) {
  if (value instanceof Date) return value.toISOString()
  return typeof value === 'string' ? value : undefined
}

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store, private')
  return response
}

/** The canonical persisted audit used by My Jobs, Resume, and the extension. */
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return noStore(auth)
  const { id: jobId } = await params
  const scope = { userId: auth.userId, jobId }
  try {
    const snapshot = await withApplicationAuditLock(scope, async tx => {
      const job = await tx.job.findFirst({ where: { id: jobId, userId: auth.userId }, select: { role: true, company: true, description: true } })
      if (!job) return null
      const operation = await readAuditOperation(tx, scope)
      if (operation.kind === 'legacy') return { state: 'stale' as const }
      if (operation.kind !== 'completed') return operation
      if (operation.jobBasisHash !== auditJobBasisHash(job)
        || !await lockApplicationAuditMaterials(tx, scope, operation.audit.resumeId, operation.audit.coverLetterId)) return { state: 'stale' as const }
      const resume = await tx.resume.findFirst({ where: { id: operation.audit.resumeId, userId: auth.userId } })
      const letter = operation.audit.coverLetterId ? await tx.coverLetter.findFirst({ where: { id: operation.audit.coverLetterId, jobId, userId: auth.userId } }) : null
      if (!resume || (operation.audit.coverLetterId && !letter) || !checkAuditDocumentLimits(resume.content, letter?.content ?? null, resume.name).ok
        || operation.materialBasisHash !== auditMaterialBasisHash(resume, letter)) return { state: 'stale' as const }
      return operation
    })
    if (!snapshot) return noStore(err('Job not found.', 404))
    if ('state' in snapshot) return noStore(ok(snapshot))
    if (snapshot.kind === 'completed') return noStore(ok(snapshot.audit))
    if (snapshot.kind === 'none') return noStore(ok(null))
    return noStore(ok({ state: snapshot.kind === 'invalid' ? 'unavailable' : snapshot.kind }))
  } catch (error) {
    return noStore(error instanceof AuditMaterialBusyError
      ? err('The application materials are being changed. Refresh the review status.', 409)
      : err('The review status could not be read. Please refresh.', 503))
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  const prep = await prepareAiRoute(req, 'autoApply')
  if ('error' in prep) return prep.error
  const { id: jobId } = await params
  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')
  const { resumeId, coverLetterId } = body as { resumeId?: string; coverLetterId?: string | null }
  if (typeof resumeId !== 'string' || !resumeId || (coverLetterId != null && (typeof coverLetterId !== 'string' || !coverLetterId))) return err('A valid resume and optional cover letter are required')

  const [job, resume] = await Promise.all([
    db.job.findFirst({ where: { id: jobId, userId: prep.userId } }),
    db.resume.findFirst({ where: { id: resumeId, userId: prep.userId } }),
  ])
  if (!job) return err('Job not found', 404)
  if (!resume) return err('Resume not found', 404)
  if (!job.description) return err('A job description is required for an independent audit', 400)
  const coverLetter = coverLetterId ? await db.coverLetter.findFirst({ where: { id: coverLetterId, jobId, userId: prep.userId } }) : null
  if (coverLetterId && !coverLetter) return err('Final cover letter not found for this job', 404)
  const documentCheck = checkAuditDocumentLimits(resume.content, coverLetter?.content ?? null, resume.name)
  if (!documentCheck.ok) return err(AUDIT_LIMIT_MESSAGES[documentCheck.reason], 422)
  const includeCoverLetter = Boolean(coverLetter)

  const scope = { userId: prep.userId, jobId }
  let operationId: string | null = null
  try {
    // Register after the basic ownership/version checks, before potentially
    // slow Persona, source-material or model work.
    const started = await withApplicationAuditLock(scope, async tx => {
      if (!await lockApplicationAuditMaterials(tx, scope, resume.id, coverLetterId ?? null)) return { kind: 'changed' as const }
      const currentJob = await tx.job.findFirst({ where: { id: jobId, userId: prep.userId }, select: { description: true, role: true, company: true } })
      const currentResume = await tx.resume.findFirst({ where: { id: resume.id, userId: prep.userId } })
      const currentLetter = coverLetterId ? await tx.coverLetter.findFirst({ where: { id: coverLetterId, jobId, userId: prep.userId } }) : null
      if (!currentJob || currentJob.description !== job.description || currentJob.role !== job.role || currentJob.company !== job.company || !currentResume
        || !toIso(resume.updatedAt) || toIso(currentResume.updatedAt) !== toIso(resume.updatedAt)
        || (coverLetterId && (!currentLetter || !toIso(coverLetter?.updatedAt) || toIso(currentLetter.updatedAt) !== toIso(coverLetter?.updatedAt)))
        || auditMaterialBasisHash(currentResume, currentLetter) !== auditMaterialBasisHash(resume, coverLetter)) return { kind: 'changed' as const }
      return { kind: 'started' as const, operationId: await registerAuditOperation(tx, scope) }
    })
    if (!started) return err('Job not found.', 404)
    if (started.kind === 'changed') return err('The application materials changed. Reload them before reviewing again.', 409)
    operationId = started.operationId
    const persona = await buildPersona(prep.userId, 'tailor')

  let sourceContent = resume.content as unknown as ResumeContent
  let source: ApplicationAudit['source'] = 'current_resume'
  if (resume.parentResumeId) {
    const parent = await db.resume.findFirst({ where: { id: resume.parentResumeId, userId: prep.userId }, select: { content: true } })
    if (parent) { sourceContent = parent.content as unknown as ResumeContent; source = 'parent_resume' }
  } else {
    const prior = await db.resumeVersion.findFirst({
      where: { resumeId: resume.id, userId: prep.userId }, orderBy: { createdAt: 'desc' }, select: { content: true },
    })
    if (prior) { sourceContent = prior.content as unknown as ResumeContent; source = 'previous_version' }
  }
  if (source === 'current_resume') {
    await withApplicationAuditLock(scope, tx => failAuditOperation(tx, scope, operationId!))
    return err('No independent source resume is available. Save or import an original version before auditing AI changes.', 409)
  }
  const evidenceCheck = checkAuditEvidenceLimits(sourceContent, persona)
  if (!evidenceCheck.ok) {
    await withApplicationAuditLock(scope, tx => failAuditOperation(tx, scope, operationId!))
    return err(AUDIT_LIMIT_MESSAGES[evidenceCheck.reason], 422)
  }

  const auditorRole = await db.agentRole.findFirst({
    where: { userId: prep.userId, role: 'auditor' }, select: { enabled: true, provider: true, model: true, apiKey: true, systemPrompt: true },
  }).catch(() => null)
  const cfg = roleAiConfig('auditor', auditorRole
    ? { ...auditorRole, apiKey: auditorRole.apiKey ?? undefined }
    : undefined, prep.cfg)
  const rolePrompt = auditorRole?.systemPrompt ?? 'You are an independent application auditor. Be conservative and evidence-based.'

  const coverLetterGuidance = coverLetter
    ? 'The FINAL RESUME and FINAL COVER LETTER may contain AI edits. Audit both documents.'
    : 'No final cover letter is supplied. A cover letter is optional, so audit the FINAL RESUME only and do not create a cover_letter finding.'
  const auditedAreas = coverLetter ? 'resume, cover_letter, and job_match' : 'resume and job_match'
  const fallbackName = coverLetter ? auditCoverLetterFallbackName(resume.content, resume.name) : null
  const finalCoverLetterSection = coverLetter
    ? `FINAL COVER LETTER TO AUDIT:\n${coverLetter.content}${fallbackName !== null ? `\n\nCOVER LETTER HEADER NAME (used when the resume contact name is missing):\n${fallbackName}` : ''}`
    : 'NO FINAL COVER LETTER SUPPLIED (optional)'
  const prompt = `${rolePrompt}

You are auditing, not rewriting. The SOURCE RESUME is the candidate's evidence baseline. ${coverLetterGuidance}
Your only release gate is factual integrity. The SOURCE RESUME and CONFIRMED PERSONA are the evidence baseline. Verify every concrete employer, current employment status or location, role, date or duration, credential, project, skill, metric, and outcome in the FINAL RESUME${coverLetter ? ' and COVER LETTER' : ''} against that baseline.

Use "resolution":"contradiction" and severity "critical" only when a source explicitly contradicts the final claim (including stale/current-status claims such as saying the candidate currently works in Shanghai when the source dates ended). Use "resolution":"evidence_needed" and severity "warning" when the source simply does not contain enough evidence to verify a claim: this is not fabrication, and the candidate may add a confirmed Persona fact or remove/soften the claim. Quote the exact final claim and the source fact or absence in "evidence", and state a precise correction in "action".

For every unresolved resume or cover_letter finding, also return "target" and a "proposedValue". The target must be the smallest affected section: contact, summary, skills, experience, education, languages, projects, certifications, or cover_letter. proposedValue must be a complete replacement for that section using the same JSON type as the final material. It must remove or soften unsupported claims, or use a confirmed Persona fact when one exists; never invent a metric, employer, title, date, credential, project, or outcome. If no safe replacement can be generated, omit proposedValue and explain the required user evidence in action. Do not return proposedValue for job_match findings or pass findings.

Do not treat a missing job requirement, indirect experience, a different presentation order, or lack of Copilot/MLOps exposure as a factual issue. Those are optional fit notes only: put them in "job_match" with severity "pass" and wording like "Optional future emphasis", and never downgrade the verdict for them. Do not infer LLM automation from a general AI or Q&A project. Do not infer security-threat detection metrics from cybersecurity work.

Return ONLY JSON. Always return at least one finding for EACH area: ${auditedAreas}. Use severity "pass" when an area is supported and safe. A pass verdict is valid only when the audited document claims are supported with no unresolved factual warnings.
{"verdict":"pass|needs_review|blocked","summary":"...","matchScore":0,"findings":[{"area":"resume|cover_letter|job_match","severity":"pass|warning|critical","resolution":"contradiction|evidence_needed","target":"contact|summary|skills|experience|education|languages|projects|certifications|cover_letter","title":"...","evidence":"quote or precise comparison","action":"...","proposedValue":"complete replacement value or null"}]}

SOURCE RESUME (truth baseline):
${toText(sourceContent)}

CONFIRMED PERSONA (user-confirmed facts, also valid evidence):
${persona}

FINAL RESUME TO AUDIT:
${toText(resume.content as unknown as ResumeContent)}

TARGET JOB: ${job.role} at ${job.company}
JOB DESCRIPTION:
${job.description.slice(0, 8_000)}

${finalCoverLetterSection}`

    const { result, audit } = await runParsedAudit(prompt, cfg, source, includeCoverLetter)
    const finished = await withApplicationAuditLock(scope, async tx => {
      if (!await lockApplicationAuditMaterials(tx, scope, resume.id, coverLetterId ?? null)) {
        await failAuditOperation(tx, scope, operationId!)
        return false
      }
      const currentJob = await tx.job.findFirst({ where: { id: jobId, userId: prep.userId }, select: { description: true, role: true, company: true } })
      const currentResume = await tx.resume.findFirst({ where: { id: resume.id, userId: prep.userId } })
      const currentLetter = coverLetterId ? await tx.coverLetter.findFirst({ where: { id: coverLetterId, jobId, userId: prep.userId } }) : null
      if (!currentJob || currentJob.description !== job.description || currentJob.role !== job.role || currentJob.company !== job.company
        || !currentResume || toIso(currentResume.updatedAt) !== toIso(resume.updatedAt)
        || (coverLetterId && (!currentLetter || toIso(currentLetter.updatedAt) !== toIso(coverLetter?.updatedAt)))
        || auditMaterialBasisHash(currentResume, currentLetter) !== auditMaterialBasisHash(resume, coverLetter)) {
        await failAuditOperation(tx, scope, operationId!)
        return false
      }
      return completeAuditOperation(tx, scope, operationId!, {
        resumeId: resume.id, coverLetterId: coverLetterId ?? null, audit, jobBasis: job, materialBasis: { resume: currentResume, coverLetter: currentLetter },
        versions: { resumeUpdatedAt: toIso(resume.updatedAt), coverLetterUpdatedAt: toIso(coverLetter?.updatedAt) },
      })
    })
    if (!finished) return err('This review was superseded or the application materials changed. Check the current state.', 409)
    const response: ApplicationAuditResponse = {
      ...audit,
      ...(toIso(resume.updatedAt) ? { resumeUpdatedAt: toIso(resume.updatedAt) } : {}),
      ...(toIso(coverLetter?.updatedAt) ? { coverLetterUpdatedAt: toIso(coverLetter?.updatedAt) } : {}),
    }
    return ok({ ...response, _model: `${result.provider}/${result.model}` })
  } catch (error) {
    if (operationId) {
      try { await withApplicationAuditLock(scope, tx => failAuditOperation(tx, scope, operationId!)) } catch { /* Keep an uncertain operation fenced until an explicit new review. */ }
    }
    if (error instanceof AuditMaterialBusyError) return err('The application materials are being changed. Refresh before reviewing again.', 409)
    console.error('[/api/jobs/audit-application]', error)
    return err(`Application audit failed: ${(error as Error).message}`, 502)
  }
}
