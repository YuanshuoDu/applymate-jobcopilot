/**
 * POST /api/jobs/:id/audit-application
 *
 * Independently audits the final resume and cover letter against the candidate's
 * pre-tailoring source material and the job description. This is a review gate,
 * not a truth oracle: unsupported claims are blocked for the candidate to fix.
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { prepareAiRoute, requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { modelChat, parseAiJson, type AiConfig } from '@/lib/model-router'
import type { ApplicationAudit, ApplicationAuditFinding, ResumeContent } from '@/lib/types'

type Params = { params: Promise<{ id: string }> }
type RawFinding = Partial<ApplicationAuditFinding>
type RawAudit = {
  verdict?: string
  summary?: string
  matchScore?: number
  findings?: RawFinding[]
}

const AREAS = new Set<ApplicationAuditFinding['area']>(['resume', 'cover_letter', 'job_match'])
const SEVERITIES = new Set<ApplicationAuditFinding['severity']>(['pass', 'warning', 'critical'])
const AUDIT_ACTIVITY_PREFIX = '[Auditor] application-audit '

type StoredApplicationAudit = {
  resumeId: string
  coverLetterId: string
  audit: ApplicationAudit
}

function toText(content: ResumeContent): string {
  return JSON.stringify(content, null, 2).slice(0, 12_000)
}

function normalize(raw: RawAudit, source: ApplicationAudit['source']): ApplicationAudit {
  const findings = (Array.isArray(raw.findings) ? raw.findings : []).slice(0, 12).map(finding => ({
    area: AREAS.has(finding.area as ApplicationAuditFinding['area']) ? finding.area as ApplicationAuditFinding['area'] : 'resume',
    severity: SEVERITIES.has(finding.severity as ApplicationAuditFinding['severity']) ? finding.severity as ApplicationAuditFinding['severity'] : 'warning',
    title: String(finding.title ?? 'Review application material').slice(0, 120),
    evidence: String(finding.evidence ?? 'The auditor could not establish enough evidence.').slice(0, 500),
    action: String(finding.action ?? 'Review and correct this item before confirming.').slice(0, 300),
  }))
  const auditedAreas = new Set(findings.map(finding => finding.area))
  // The audit gate verifies factual integrity of the submitted documents.
  // Job-fit gaps are useful advice, but absence of a requested skill is never
  // evidence that the candidate fabricated a claim.
  const incomplete = (['resume', 'cover_letter'] as const).filter(area => !auditedAreas.has(area))
  if (incomplete.length) findings.push({
    area: incomplete[0], severity: 'warning', title: 'Incomplete independent audit',
    evidence: `The Auditor did not return a result for: ${incomplete.join(', ')}.`,
    action: 'Run the audit again before confirming the application package.',
  })
  const hasCritical = findings.some(finding => finding.area !== 'job_match' && finding.severity === 'critical')
  const hasFactualWarning = findings.some(finding => finding.area !== 'job_match' && finding.severity === 'warning')
  const requestedVerdict = raw.verdict === 'pass' || raw.verdict === 'blocked' || raw.verdict === 'needs_review'
    ? raw.verdict : 'needs_review'
  return {
    verdict: hasCritical ? 'blocked' : (hasFactualWarning || incomplete.length) ? 'needs_review' : 'pass',
    summary: String(raw.summary ?? 'Independent audit completed. Review all findings before final confirmation.').slice(0, 600),
    matchScore: Math.max(0, Math.min(100, Number(raw.matchScore) || 0)),
    findings: findings.length ? findings : [{ area: 'resume', severity: 'warning', title: 'Audit needs review', evidence: 'The auditor returned no structured findings.', action: 'Run the audit again before final confirmation.' }],
    source,
    auditedAt: new Date().toISOString(),
  }
}

function auditActivityText(resumeId: string, coverLetterId: string, audit: ApplicationAudit) {
  return `${AUDIT_ACTIVITY_PREFIX}${JSON.stringify({ resumeId, coverLetterId, audit })}`
}

function parseStoredAudit(text: string): StoredApplicationAudit | null {
  if (!text.startsWith(AUDIT_ACTIVITY_PREFIX)) return null
  try {
    const stored = JSON.parse(text.slice(AUDIT_ACTIVITY_PREFIX.length)) as StoredApplicationAudit
    if (!stored.resumeId || !stored.coverLetterId || !stored.audit?.verdict || !Array.isArray(stored.audit.findings)) return null
    return stored
  } catch {
    return null
  }
}

/** The canonical persisted audit used by My Jobs, Resume, and the extension. */
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth
  const { id: jobId } = await params
  const activity = await db.activity.findFirst({
    where: { userId: auth.userId, jobId, text: { startsWith: AUDIT_ACTIVITY_PREFIX } },
    orderBy: { createdAt: 'desc' },
    select: { text: true },
  })
  return ok(parseStoredAudit(activity?.text ?? '') ?? null)
}

export async function POST(req: NextRequest, { params }: Params) {
  const prep = await prepareAiRoute(req, 'autoApply')
  if ('error' in prep) return prep.error
  const { id: jobId } = await params
  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')
  const { resumeId, coverLetterId } = body as { resumeId?: string; coverLetterId?: string }
  if (!resumeId) return err('resumeId is required')

  const [job, resume] = await Promise.all([
    db.job.findFirst({ where: { id: jobId, userId: prep.userId } }),
    db.resume.findFirst({ where: { id: resumeId, userId: prep.userId } }),
  ])
  if (!job) return err('Job not found', 404)
  if (!resume) return err('Resume not found', 404)
  if (!job.description) return err('A job description is required for an independent audit', 400)
  if (!coverLetterId) return err('Select a final cover letter before auditing', 400)

  const coverLetter = await db.coverLetter.findFirst({
    where: { id: coverLetterId, jobId, userId: prep.userId },
    select: { content: true },
  })
  if (!coverLetter) return err('Final cover letter not found for this job', 404)

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
    return err('No independent source resume is available. Save or import an original version before auditing AI changes.', 409)
  }

  const auditorRole = await db.agentRole.findFirst({
    where: { userId: prep.userId, role: 'auditor' }, select: { provider: true, model: true, apiKey: true, systemPrompt: true },
  }).catch(() => null)
  const cfg: AiConfig = auditorRole
    ? { provider: auditorRole.provider as AiConfig['provider'], model: auditorRole.model, apiKey: auditorRole.apiKey ?? undefined }
    : prep.cfg
  const rolePrompt = auditorRole?.systemPrompt ?? 'You are an independent application auditor. Be conservative and evidence-based.'

  const prompt = `${rolePrompt}

You are auditing, not rewriting. The SOURCE RESUME is the candidate's evidence baseline. The FINAL RESUME and COVER LETTER may contain AI edits.
Your only release gate is factual integrity. The SOURCE RESUME is the evidence baseline. Verify every concrete employer, current employment status or location, role, date or duration, credential, project, skill, metric, and outcome in the FINAL RESUME and COVER LETTER against that baseline.

Mark "critical" only for a specific unsupported or contradictory claim (including stale/current-status claims such as saying the candidate currently works in Shanghai when the source dates ended). Mark "warning" only when a claim might be supported but needs the candidate to confirm the precise evidence. Quote the exact final claim and the source fact or absence in "evidence", and state a precise correction in "action".

Do not treat a missing job requirement, indirect experience, a different presentation order, or lack of Copilot/MLOps exposure as a factual issue. Those are optional fit notes only: put them in "job_match" with severity "pass" and wording like "Optional future emphasis", and never downgrade the verdict for them. Do not infer LLM automation from a general AI or Q&A project. Do not infer security-threat detection metrics from cybersecurity work.

Return ONLY JSON. Always return at least one finding for EACH area: resume, cover_letter, and job_match. Use severity "pass" when an area is supported and safe. A pass verdict is valid only when resume and cover-letter claims are supported with no unresolved factual warnings.
{"verdict":"pass|needs_review|blocked","summary":"...","matchScore":0,"findings":[{"area":"resume|cover_letter|job_match","severity":"pass|warning|critical","title":"...","evidence":"quote or precise comparison","action":"..."}]}

SOURCE RESUME (truth baseline):
${toText(sourceContent)}

FINAL RESUME TO AUDIT:
${toText(resume.content as unknown as ResumeContent)}

TARGET JOB: ${job.role} at ${job.company}
JOB DESCRIPTION:
${job.description.slice(0, 8_000)}

FINAL COVER LETTER TO AUDIT:
${coverLetter.content.slice(0, 8_000)}`

  try {
    const result = await modelChat([{ role: 'user', content: prompt }], cfg, 3_000)
    const audit = normalize(parseAiJson<RawAudit>(result.text), source)
    await db.activity.create({
      data: {
        userId: prep.userId, jobId, type: 'agent_action',
        color: audit.verdict === 'pass' ? '#059669' : audit.verdict === 'blocked' ? '#dc2626' : '#d97706',
        text: auditActivityText(resume.id, coverLetterId, audit),
      },
    }).catch(() => {})
    return ok({ ...audit, _model: `${result.provider}/${result.model}` })
  } catch (error) {
    console.error('[/api/jobs/audit-application]', error)
    return err(`Application audit failed: ${(error as Error).message}`, 502)
  }
}
