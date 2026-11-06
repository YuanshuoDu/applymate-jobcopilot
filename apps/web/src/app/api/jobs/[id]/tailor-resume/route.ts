/**
 * POST /api/jobs/[id]/tailor-resume
 * Body: { resumeId: string }
 * Tailors a base resume to the target job and saves an adapted resume.
 */
import { NextRequest } from 'next/server'
import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { prepareAiRoute, ok, err } from '@/lib/api-helpers'
import { modelChat, parseAiJson } from '@/lib/model-router'
import { buildPersona } from '@/lib/persona'
import { personaEvidenceContext } from '@/lib/persona-evidence'
import { hasEffectiveEntitlement } from '@/lib/entitlements'
import type { ApplicationAuditFinding } from '@/lib/types'
import { requireLegacyPolicy } from '@/lib/agent/policy/legacy'

type Params = { params: Promise<{ id: string }> }

type ChangeDetail = {
  section: string
  field: string
  before: string
  after: string
  reason: string
}

type TailoredSection = {
  after?: unknown
  reason?: string
}

const SECTIONS = ['summary', 'skills', 'experience', 'education', 'projects', 'certifications'] as const

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function stringifySection(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value ?? null, null, 2)
}

function parseAfterValue(after: unknown): unknown {
  if (typeof after !== 'string') return after
  try {
    return JSON.parse(after)
  } catch {
    return after
  }
}

function sameSectionShape(before: unknown, after: unknown): boolean {
  if (Array.isArray(before)) return Array.isArray(after)
  if (before && typeof before === 'object') return Boolean(after && typeof after === 'object' && !Array.isArray(after))
  return after !== null && typeof before === typeof after
}

function sectionsForAuditRepair(findings: ApplicationAuditFinding[]) {
  const matches: Array<typeof SECTIONS[number]> = []
  for (const finding of findings.filter(item => item && item.area === 'resume' && item.severity !== 'pass')) {
    if (finding.target) {
      if (!SECTIONS.includes(finding.target as typeof SECTIONS[number])) return null
      matches.push(finding.target as typeof SECTIONS[number])
      continue
    }
    const text = `${finding.title} ${finding.evidence} ${finding.action}`.toLowerCase()
    const inferred: Array<typeof SECTIONS[number]> = []
    const add = (section: typeof SECTIONS[number], terms: string[]) => {
      if (terms.some(term => text.includes(term))) inferred.push(section)
    }
    add('experience', ['experience', 'employer', 'employment', 'company', 'role', 'title', 'date', 'duration'])
    add('summary', ['summary', 'profile', 'headline'])
    add('skills', ['skill', 'technology', 'tooling'])
    add('education', ['education', 'degree', 'university'])
    add('projects', ['project', 'portfolio'])
    add('certifications', ['certification', 'certificate', 'credential'])
    if (inferred.length !== 1) return null
    matches.push(inferred[0])
  }
  return matches.length ? [...new Set(matches)] : null
}

export async function POST(req: NextRequest, { params }: Params) {
  const prep = await prepareAiRoute(req, 'suggest', 'tailored_resume')
  if ('error' in prep) return prep.error
  if (!await hasEffectiveEntitlement(prep.userId, 'cv:tailoring')) return err('Your current plan does not include AI CV tailoring.', 403)

  const { id: jobId } = await params
  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { resumeId, forceRetailor = false, auditFindings = [] } = body as {
    resumeId?: string
    forceRetailor?: boolean
    auditFindings?: ApplicationAuditFinding[]
  }
  if (!resumeId) return err('resumeId is required')

  const [resume, job, existing] = await Promise.all([
    db.resume.findFirst({ where: { id: resumeId, userId: prep.userId } }),
    db.job.findFirst({ where: { id: jobId, userId: prep.userId } }),
    db.resume.findFirst({
      where: { userId: prep.userId, targetJobId: jobId, kind: 'adapted', origin: 'ai-adapted' },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, parentResumeId: true, content: true, name: true, updatedAt: true },
    }),
  ])

  if (!resume) return err('Resume not found', 404)
  if (!job) return err('Job not found', 404)
  if (!job.description) return err('Job description is required')
  // Repair must never mutate or create a different resume from the one selected.
  if (forceRetailor && (!existing || existing.id !== resume.id)) {
    return err('The selected resume cannot be repaired automatically for this application. Open it to edit or select the current tailored resume.', 409)
  }
  if (forceRetailor && (!Array.isArray(auditFindings)
    || !auditFindings.some(finding => finding && finding.area === 'resume' && finding.severity !== 'pass'))) {
    return err('Select a resume review issue before applying an automatic correction.', 400)
  }
  if (existing && !forceRetailor) return ok({ adaptedResumeId: existing.id, changes: [], reused: true })

  if (forceRetailor && !existing?.parentResumeId) return err('The original resume for this tailored version could not be found', 404)
  const sourceResume = forceRetailor && existing?.parentResumeId
    ? await db.resume.findFirst({ where: { id: existing.parentResumeId, userId: prep.userId } })
    : resume
  if (!sourceResume?.content) return err('The original resume for this tailored version could not be found', 404)

  requireLegacyPolicy({
    userId: prep.userId,
    sessionId: `legacy-resume:${jobId}`,
    turnId: `legacy-tailor:${jobId}:${resumeId}`,
    stepId: `tailor:${jobId}`,
    toolCallId: randomUUID(),
    toolName: 'resume.tailor',
    domain: 'resume',
    risk: 'draft_write',
    capabilities: ['read', 'write'],
    input: { jobId, resumeId, sourceResumeId: sourceResume.id, unknownSensitiveFacts: false },
  })

  // For repair, preserve the selected tailored document as the output base.
  // The parent remains separate evidence; it must not replace unrelated edits.
  const resumeContent = (forceRetailor ? existing?.content : sourceResume.content) as Record<string, unknown>
  if (!resumeContent || typeof resumeContent !== 'object' || Array.isArray(resumeContent)) return err('The selected resume content is unavailable.', 409)
  const persona = await buildPersona(prep.userId, 'tailor')
  const evidence = await personaEvidenceContext(prep.userId, 'tailor', `${job.role} ${job.description}`).catch(() => '')
  const adaptedContent = cloneJson(resumeContent)
  const changes: ChangeDetail[] = []
  const resumeFindings = Array.isArray(auditFindings)
    ? auditFindings.filter(finding => finding && finding.area === 'resume' && finding.severity !== 'pass') : []
  if (forceRetailor && resumeFindings.length > 6) return err('Too many resume issues to correct at once. Open the resume and review them manually.', 422)
  const corrections = resumeFindings.map(finding => `- ${finding.area}: ${finding.title}. Required correction: ${finding.action}`)
  const sectionsToTailor = forceRetailor ? sectionsForAuditRepair(resumeFindings) : SECTIONS
  if (!sectionsToTailor) return err('The affected resume section is unclear. Open the resume and edit it manually.', 422)

  for (const section of sectionsToTailor) {
    const currentValue = resumeContent[section]
    if (currentValue === undefined || currentValue === null) continue

    const before = stringifySection(currentValue)
    const prompt = [
      'You are an expert ATS resume editor.',
      'Tailor the provided resume section to the target job while preserving truthful candidate facts.',
      'The confirmed Persona is a hard factual boundary. Do not add facts that are unsupported by BOTH the source resume and Persona. If there is any conflict, preserve the source resume.',
      'Use job-description keywords only where they are supported by the resume content or Persona.',
      '',
      `SECTION: ${section}`,
      `CURRENT SECTION JSON:\n${before}`,
      ...(forceRetailor ? [`ORIGINAL RESUME EVIDENCE:\n${JSON.stringify(sourceResume.content, null, 2)}`] : []),
      '',
      `TARGET JOB: ${job.role} at ${job.company}`,
      job.keywords ? `KNOWN KEYWORDS: ${job.keywords}` : '',
      `JOB DESCRIPTION:\n${job.description.slice(0, 1800)}`,
      `CONFIRMED PERSONA:\n${persona.slice(0, 9000)}`,
      evidence,
      corrections.length ? `AUDIT CORRECTIONS (remove or rewrite unsupported claims; never invent evidence):\n${corrections.join('\n')}` : '',
      '',
      'Return ONLY JSON in this shape:',
      '{"after": <the tailored section value, same JSON type as the current section>, "reason": "brief explanation of the keyword/positioning changes"}',
    ].filter(Boolean).join('\n')

    try {
      const result = await modelChat([{ role: 'user', content: prompt }], prep.cfg, 2000)
      const parsed = parseAiJson<TailoredSection>(result.text)
      if (parsed.after === undefined) continue

      const afterValue = parseAfterValue(parsed.after)
      if (forceRetailor && !sameSectionShape(currentValue, afterValue)) continue
      adaptedContent[section] = afterValue
      changes.push({
        section,
        field: section,
        before,
        after: stringifySection(afterValue),
        reason: parsed.reason || 'Tailored to better match the target job description.',
      })
    } catch (e) {
      console.warn('[/api/jobs/' + jobId + '/tailor-resume] section "' + section + '" skipped:', (e as Error).message?.slice(0, 160))
    }
  }

  if (changes.length === 0) return err('No resume sections could be tailored', 502)

  let adapted: { id: string; name: string }
  if (existing && forceRetailor) {
    if (!(existing.updatedAt instanceof Date) || !Number.isFinite(existing.updatedAt.getTime())) return err('The selected resume version is unavailable. Refresh before correcting it.', 409)
    try {
      const updated = await db.$transaction(async tx => {
        const result = await tx.resume.updateMany({
          where: { id: existing.id, userId: prep.userId, updatedAt: existing.updatedAt, content: { equals: existing.content as Prisma.InputJsonValue } },
          data: { content: adaptedContent as Prisma.InputJsonValue },
        })
        if (result.count !== 1) return false
        await tx.resumeVersion.create({ data: { resumeId: existing.id, userId: prep.userId, content: existing.content as Prisma.InputJsonValue, name: existing.name } })
        return true
      })
      if (!updated) return err('The resume changed during correction. Refresh and review the latest version.', 409)
      adapted = existing
    } catch {
      return err('The correction could not be confirmed. Refresh and review the latest resume.', 503)
    }
  } else {
    adapted = await db.resume.create({
      data: {
      userId:          prep.userId,
      name:            `Tailored for ${job.company} - ${job.role}`,
      content:         adaptedContent as Prisma.InputJsonValue,
      templateId:      sourceResume.templateId ?? null,
      templateOptions: sourceResume.templateOptions ?? undefined,
      isDefault:       false,
      directionId:     sourceResume.directionId ?? null,
      kind:            'adapted',
      parentResumeId:  sourceResume.id,
      targetJobId:     job.id,
      origin:          'ai-adapted',
      basicsDetached:  sourceResume.basicsDetached ?? false,
    },
    })
  }

  await db.activity.create({
    data: {
      userId: prep.userId,
      jobId:  job.id,
      type:   'resume_tailored',
      text:   `${forceRetailor ? 'Revised' : 'Created'} tailored resume "${adapted.name}"`,
      color:  '#3B6D11',
    },
  }).catch(() => null)

  return ok({ adaptedResumeId: adapted.id, changes, revised: Boolean(existing && forceRetailor) })
}
