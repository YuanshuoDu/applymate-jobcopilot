import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { prepareAiRoute, requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { modelChat, parseAiJson } from '@/lib/model-router'
import { buildPersona } from '@/lib/persona'
import { targetForAuditFinding } from '@/lib/application-audit'
import { sanitizeLosslessProposedValue } from '@/lib/application-audit-repair-safety'
import { auditJobBasisHash, auditMaterialBasisHash, completeAuditOperation, readAuditOperation, registerAuditOperation } from '@/lib/application-audit-operation'
import { AUDIT_LIMIT_MESSAGES, checkAuditEvidenceLimits } from '@/lib/application-audit-limits'
import { AuditMaterialBusyError, lockApplicationAuditMaterials, withApplicationAuditLock } from '@/lib/application-audit-transaction'
import type { ApplicationAudit, ApplicationAuditFinding, ResumeContent } from '@/lib/types'

type Params = { params: Promise<{ id: string }> }
type GeneratedRepair = { proposedValue?: unknown }

function iso(value: unknown) {
  return value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : undefined
}

function sameVersion(expected: string | undefined, actual: unknown) {
  if (!expected) return actual == null
  const actualIso = iso(actual)
  return Boolean(actualIso && actualIso === expected)
}

function sectionText(content: ResumeContent, target: ApplicationAuditFinding['target']) {
  if (!target || target === 'cover_letter') return ''
  return JSON.stringify(content[target], null, 2)
}

async function generateRepair(
  req: NextRequest,
  job: { role: string; company: string; description: string | null },
  resume: { id: string; content: unknown; parentResumeId: string | null },
  finding: ApplicationAuditFinding,
  target: NonNullable<ApplicationAuditFinding['target']>,
  coverLetter: { content: string } | null,
) {
  const prep = await prepareAiRoute(req, target === 'cover_letter' ? 'coverLetter' : 'suggest', target === 'cover_letter' ? 'cover_letters:ai' : 'tailored_resume')
  if ('error' in prep) return { error: prep.error }

  const [persona, sourceResume] = await Promise.all([
    buildPersona(prep.userId, 'tailor'),
    resume.parentResumeId
      ? db.resume.findFirst({ where: { id: resume.parentResumeId, userId: prep.userId }, select: { content: true } })
      : db.resumeVersion.findFirst({ where: { resumeId: resume.id, userId: prep.userId }, orderBy: { createdAt: 'desc' }, select: { content: true } }),
  ])
  if (!sourceResume?.content) return { error: err('The source resume is no longer available. Restore it and run the review again.', 409) }
  const evidenceCheck = checkAuditEvidenceLimits(sourceResume.content, persona)
  if (!evidenceCheck.ok) return { error: err(AUDIT_LIMIT_MESSAGES[evidenceCheck.reason], 422) }
  const currentContent = resume.content as unknown as ResumeContent
  const current = target === 'cover_letter' ? coverLetter?.content ?? '' : sectionText(currentContent, target)
  const source = JSON.stringify(sourceResume.content, null, 2)
  const prompt = [
    'You are a careful resume and application editor applying exactly one independent-audit correction.',
    'Return ONLY JSON: {"proposedValue": <complete replacement value>}.',
    'Use only the source resume, confirmed Persona, current material, and job description. Never invent a fact, metric, employer, title, date, credential, project, or outcome.',
    'If the audit says evidence is missing, remove or soften the unsupported claim instead of making one up.',
    `TARGET SECTION: ${target}`,
    `CURRENT TARGET CONTENT:\n${current}`,
    `SOURCE RESUME EVIDENCE:\n${source}`,
    `CONFIRMED PERSONA:\n${persona}`,
    `JOB: ${job.role} at ${job.company}\n${job.description?.slice(0, 5_000) ?? ''}`,
    `AUDIT FINDING:\nTitle: ${finding.title}\nEvidence: ${finding.evidence}\nRecommended fix: ${finding.action}`,
    target === 'cover_letter'
      ? 'proposedValue must be the complete corrected cover-letter string.'
      : 'proposedValue must be the complete replacement JSON value for the target resume section, preserving supported content not related to this finding.',
  ].join('\n\n')
  try {
    const result = await modelChat([{ role: 'user', content: prompt }], prep.cfg, target === 'cover_letter' ? 4_096 : 2_500)
    const parsed = parseAiJson<GeneratedRepair>(result.text)
    const proposedValue = sanitizeLosslessProposedValue(target, parsed.proposedValue)
    return proposedValue === null ? { error: err('The AI did not return a safe generated correction.', 502) } : { proposedValue }
  } catch (error) {
    return { error: err(`Could not generate a safe correction: ${(error as Error).message}`, 502) }
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth
  const { id: jobId } = await params
  const body = await req.json().catch(() => null)
  const resumeId = typeof body?.resumeId === 'string' ? body.resumeId : ''
  const findingIndex = Number.isInteger(body?.findingIndex) ? body.findingIndex as number : -1
  if (!resumeId || findingIndex < 0) return err('resumeId and findingIndex are required')

  const scope = { userId: auth.userId, jobId }
  let original: Awaited<ReturnType<typeof readAuditOperation>> | null
  try { original = await withApplicationAuditLock(scope, tx => readAuditOperation(tx, scope)) }
  catch { return err('The review status could not be read. Refresh before applying a correction.', 503) }
  if (!original) return err('Job not found', 404)
  const stored = original.kind === 'completed' ? original.audit : null
  if (!stored || stored.resumeId !== resumeId) {
    return err('Run the independent audit again before applying a correction.', 409)
  }
  const requestedCoverLetterId = body?.coverLetterId === undefined ? stored.coverLetterId : body.coverLetterId
  if ((requestedCoverLetterId ?? null) !== stored.coverLetterId) return err('The audit no longer matches this cover letter. Run it again.', 409)

  const finding = stored.audit.findings[findingIndex]
  if (!finding || finding.severity === 'pass') return err('This audit finding cannot be applied.', 400)
  if (finding.applied) return err('This audit finding is already applied. Run the audit again to verify it.', 409)
  const target = targetForAuditFinding(finding)
  if (!target) return err('Job-match guidance does not change the resume or cover letter.', 400)

  const [job, resume] = await Promise.all([
    db.job.findFirst({ where: { id: jobId, userId: auth.userId }, select: { role: true, company: true, description: true } }),
    db.resume.findFirst({ where: { id: resumeId, userId: auth.userId } }),
  ])
  if (!job) return err('Job not found', 404)
  if (!resume) return err('Resume not found', 404)
  if (original.kind !== 'completed' || original.jobBasisHash !== auditJobBasisHash(job)) return err('The job changed or the audit is too old. Run the audit again.', 409)
  if (!sameVersion(stored.resumeUpdatedAt, resume.updatedAt)) return err('The resume changed after this audit. Run the audit again.', 409)

  const coverLetter = stored.coverLetterId
    ? await db.coverLetter.findFirst({ where: { id: stored.coverLetterId, jobId, userId: auth.userId } })
    : null
  if (stored.coverLetterId && !coverLetter) return err('The audited cover letter is no longer available.', 409)
  if (!sameVersion(stored.coverLetterUpdatedAt, coverLetter?.updatedAt)) return err('The cover letter changed after this audit. Run the audit again.', 409)
  if (original.materialBasisHash !== auditMaterialBasisHash(resume, coverLetter)) return err('The materials changed after this audit. Run it again.', 409)

  let proposedValue = sanitizeLosslessProposedValue(target, finding.proposedValue)
  if (proposedValue === null) {
    const generated = await generateRepair(req, { ...job, description: job.description }, { id: resume.id, content: resume.content, parentResumeId: resume.parentResumeId }, finding, target, coverLetter)
    if ('error' in generated) return generated.error
    proposedValue = generated.proposedValue
  }
  if (proposedValue === null || proposedValue === undefined) return err('No safe generated correction is available. Add confirmed Persona evidence or edit this item manually.', 422)

  try {
    const result = await withApplicationAuditLock(scope, async tx => {
      const current = await readAuditOperation(tx, scope)
      if (current.kind !== 'completed' || original.kind !== 'completed'
        || current.operationId !== original.operationId || current.jobBasisHash !== original.jobBasisHash || current.materialBasisHash !== original.materialBasisHash
        || current.audit.receipt?.signature !== stored.receipt?.signature) return err('The audit changed. Review the current result before applying a correction.', 409)
      if (!await lockApplicationAuditMaterials(tx, scope, resumeId, stored.coverLetterId)) return err('The audited materials are no longer available.', 409)
      const currentJob = await tx.job.findFirst({ where: { id: jobId, userId: auth.userId }, select: { role: true, company: true, description: true } })
      const currentResume = await tx.resume.findFirst({ where: { id: resumeId, userId: auth.userId } })
      const currentLetter = stored.coverLetterId ? await tx.coverLetter.findFirst({ where: { id: stored.coverLetterId, jobId, userId: auth.userId } }) : null
      if (!currentJob || currentJob.role !== job.role || currentJob.company !== job.company || currentJob.description !== job.description
        || !currentResume || !sameVersion(stored.resumeUpdatedAt, currentResume.updatedAt)
        || (stored.coverLetterId && !currentLetter) || !sameVersion(stored.coverLetterUpdatedAt, currentLetter?.updatedAt)
        || current.materialBasisHash !== auditMaterialBasisHash(currentResume, currentLetter)) {
        return err('The application materials changed. Run the audit again.', 409)
      }
      let updatedResume: typeof resume | null = null
      let updatedCoverLetter: typeof coverLetter = null
      if (target === 'cover_letter') {
        if (!currentLetter) return err('A cover letter is not attached to this audit.', 409)
        updatedCoverLetter = await tx.coverLetter.update({ where: { id: currentLetter.id }, data: { content: proposedValue as string } })
      } else {
        const nextContent = { ...(currentResume.content as unknown as ResumeContent), [target]: proposedValue }
        await tx.resumeVersion.create({ data: { resumeId, userId: auth.userId, content: currentResume.content as object, name: currentResume.name } })
        updatedResume = await tx.resume.update({ where: { id: resumeId }, data: { content: nextContent } })
      }
      const appliedAt = new Date().toISOString()
      const updatedAudit: ApplicationAudit = {
        ...stored.audit, verdict: 'needs_review',
        summary: 'A generated correction was applied. Run the independent audit again before final confirmation.',
        auditedAt: appliedAt,
        findings: stored.audit.findings.map((item, index) => index === findingIndex
          ? { ...item, target, proposedValue, applied: true, appliedAt } : item),
      }
      const nextOperation = await registerAuditOperation(tx, scope)
      const resumeUpdatedAt = iso(updatedResume?.updatedAt) ?? stored.resumeUpdatedAt
      const coverLetterUpdatedAt = iso(updatedCoverLetter?.updatedAt) ?? stored.coverLetterUpdatedAt
      if (!await completeAuditOperation(tx, scope, nextOperation, { resumeId, coverLetterId: stored.coverLetterId, audit: updatedAudit, jobBasis: currentJob,
        materialBasis: { resume: updatedResume ?? currentResume, coverLetter: updatedCoverLetter ?? currentLetter }, versions: { resumeUpdatedAt, coverLetterUpdatedAt } })) {
        throw new Error('Could not persist audit correction')
      }
      return ok({ audit: updatedAudit, target, appliedContent: proposedValue, resume: updatedResume, coverLetter: updatedCoverLetter, resumeUpdatedAt, coverLetterUpdatedAt })
    })
    return result ?? err('Job not found', 404)
  } catch (error) {
    return error instanceof AuditMaterialBusyError
      ? err('The application materials are being changed. Refresh before applying a correction.', 409)
      : err('The correction could not be confirmed. Reload and check the materials before trying again.', 503)
  }
}
