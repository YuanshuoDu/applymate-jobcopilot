import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { prepareAiRoute, requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { modelChat, parseAiJson } from '@/lib/model-router'
import { buildPersona } from '@/lib/persona'
import { auditActivityText, AUDIT_ACTIVITY_PREFIX, parseStoredApplicationAudit, sanitizeProposedValue, targetForAuditFinding } from '@/lib/application-audit'
import type { ApplicationAudit, ApplicationAuditFinding, ResumeContent } from '@/lib/types'

type Params = { params: Promise<{ id: string }> }
type GeneratedRepair = { proposedValue?: unknown }

function iso(value: unknown) {
  return value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : undefined
}

function sameVersion(expected: string | undefined, actual: unknown) {
  if (!expected) return true
  const actualIso = iso(actual)
  return Boolean(actualIso && actualIso === expected)
}

function sectionText(content: ResumeContent, target: ApplicationAuditFinding['target']) {
  if (!target || target === 'cover_letter') return ''
  return JSON.stringify(content[target], null, 2).slice(0, 10_000)
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
  const currentContent = resume.content as unknown as ResumeContent
  const current = target === 'cover_letter' ? coverLetter?.content ?? '' : sectionText(currentContent, target)
  const source = sourceResume?.content ? JSON.stringify(sourceResume.content, null, 2).slice(0, 10_000) : 'No separate source section was available.'
  const prompt = [
    'You are a careful resume and application editor applying exactly one independent-audit correction.',
    'Return ONLY JSON: {"proposedValue": <complete replacement value>}.',
    'Use only the source resume, confirmed Persona, current material, and job description. Never invent a fact, metric, employer, title, date, credential, project, or outcome.',
    'If the audit says evidence is missing, remove or soften the unsupported claim instead of making one up.',
    `TARGET SECTION: ${target}`,
    `CURRENT TARGET CONTENT:\n${current}`,
    `SOURCE RESUME EVIDENCE:\n${source}`,
    `CONFIRMED PERSONA:\n${persona.slice(0, 9_000)}`,
    `JOB: ${job.role} at ${job.company}\n${job.description?.slice(0, 5_000) ?? ''}`,
    `AUDIT FINDING:\nTitle: ${finding.title}\nEvidence: ${finding.evidence}\nRecommended fix: ${finding.action}`,
    target === 'cover_letter'
      ? 'proposedValue must be the complete corrected cover-letter string.'
      : 'proposedValue must be the complete replacement JSON value for the target resume section, preserving supported content not related to this finding.',
  ].join('\n\n')
  try {
    const result = await modelChat([{ role: 'user', content: prompt }], prep.cfg, target === 'cover_letter' ? 4_096 : 2_500)
    const parsed = parseAiJson<GeneratedRepair>(result.text)
    const proposedValue = sanitizeProposedValue(target, parsed.proposedValue)
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

  const activity = await db.activity.findFirst({
    where: { userId: auth.userId, jobId, text: { startsWith: AUDIT_ACTIVITY_PREFIX } },
    orderBy: { createdAt: 'desc' }, select: { text: true },
  })
  const stored = parseStoredApplicationAudit(activity?.text ?? '')
  if (!stored || stored.resumeId !== resumeId) return err('Run the independent audit again before applying a correction.', 409)
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
  if (!sameVersion(stored.resumeUpdatedAt, resume.updatedAt)) return err('The resume changed after this audit. Run the audit again.', 409)

  const coverLetter = stored.coverLetterId
    ? await db.coverLetter.findFirst({ where: { id: stored.coverLetterId, jobId, userId: auth.userId } })
    : null
  if (stored.coverLetterId && !coverLetter) return err('The audited cover letter is no longer available.', 409)
  if (!sameVersion(stored.coverLetterUpdatedAt, coverLetter?.updatedAt)) return err('The cover letter changed after this audit. Run the audit again.', 409)

  let proposedValue = sanitizeProposedValue(target, finding.proposedValue)
  if (proposedValue === null) {
    const generated = await generateRepair(req, { ...job, description: job.description }, { id: resume.id, content: resume.content, parentResumeId: resume.parentResumeId }, finding, target, coverLetter)
    if ('error' in generated) return generated.error
    proposedValue = generated.proposedValue
  }
  if (proposedValue === null || proposedValue === undefined) return err('No safe generated correction is available. Add confirmed Persona evidence or edit this item manually.', 422)

  let updatedResume: typeof resume | null = null
  let updatedCoverLetter: typeof coverLetter = null
  if (target === 'cover_letter') {
    if (!coverLetter) return err('A cover letter is not attached to this audit.', 409)
    updatedCoverLetter = await db.coverLetter.update({ where: { id: coverLetter.id }, data: { content: proposedValue as string } })
  } else {
    const nextContent = { ...(resume.content as unknown as ResumeContent), [target]: proposedValue }
    await db.resumeVersion.create({ data: { resumeId, userId: auth.userId, content: resume.content as object, name: resume.name } })
    updatedResume = await db.resume.update({ where: { id: resumeId }, data: { content: nextContent } })
  }

  const appliedAt = new Date().toISOString()
  const updatedAudit: ApplicationAudit = {
    ...stored.audit,
    verdict: 'needs_review',
    summary: 'A generated correction was applied. Run the independent audit again before final confirmation.',
    auditedAt: appliedAt,
    findings: stored.audit.findings.map((item, index) => index === findingIndex
      ? { ...item, target, proposedValue, applied: true, appliedAt }
      : item),
  }
  await db.activity.create({
    data: {
      userId: auth.userId, jobId, type: 'agent_action', color: '#d97706',
      text: auditActivityText(resumeId, stored.coverLetterId, updatedAudit, {
        resumeUpdatedAt: iso(updatedResume?.updatedAt) ?? stored.resumeUpdatedAt,
        coverLetterUpdatedAt: iso(updatedCoverLetter?.updatedAt) ?? stored.coverLetterUpdatedAt,
      }),
    },
  })

  return ok({
    audit: updatedAudit,
    target,
    appliedContent: proposedValue,
    resume: updatedResume,
    coverLetter: updatedCoverLetter,
    resumeUpdatedAt: iso(updatedResume?.updatedAt) ?? stored.resumeUpdatedAt,
    coverLetterUpdatedAt: iso(updatedCoverLetter?.updatedAt) ?? stored.coverLetterUpdatedAt,
  })
}
