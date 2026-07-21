/**
 * POST /api/jobs/[id]/tailor-resume
 * Body: { resumeId: string }
 * Tailors a base resume to the target job and saves an adapted resume.
 */
import { NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { prepareAiRoute, ok, err } from '@/lib/api-helpers'
import { modelChat, parseAiJson } from '@/lib/model-router'
import type { ApplicationAuditFinding } from '@/lib/types'

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

export async function POST(req: NextRequest, { params }: Params) {
  const prep = await prepareAiRoute(req, 'suggest')
  if ('error' in prep) return prep.error

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
      select: { id: true, parentResumeId: true, content: true, name: true },
    }),
  ])

  if (!resume) return err('Resume not found', 404)
  if (!job) return err('Job not found', 404)
  if (!job.description) return err('Job description is required')
  if (existing && !forceRetailor) return ok({ adaptedResumeId: existing.id, changes: [], reused: true })

  const sourceResume = forceRetailor && existing?.parentResumeId
    ? await db.resume.findFirst({ where: { id: existing.parentResumeId, userId: prep.userId } })
    : resume
  if (!sourceResume) return err('The original resume for this tailored version could not be found', 404)

  const resumeContent = sourceResume.content as Record<string, unknown>
  const adaptedContent = cloneJson(resumeContent)
  const changes: ChangeDetail[] = []
  const corrections = Array.isArray(auditFindings)
    ? auditFindings.filter(finding => finding.severity !== 'pass').slice(0, 6)
      .map(finding => `- ${finding.area}: ${finding.title}. Required correction: ${finding.action}`)
    : []

  for (const section of SECTIONS) {
    const currentValue = resumeContent[section]
    if (currentValue === undefined || currentValue === null) continue

    const before = stringifySection(currentValue)
    const prompt = [
      'You are an expert ATS resume editor.',
      'Tailor the provided resume section to the target job while preserving truthful candidate facts.',
      'Use job-description keywords only where they are supported by the resume content.',
      '',
      `SECTION: ${section}`,
      `CURRENT SECTION JSON:\n${before}`,
      '',
      `TARGET JOB: ${job.role} at ${job.company}`,
      job.keywords ? `KNOWN KEYWORDS: ${job.keywords}` : '',
      `JOB DESCRIPTION:\n${job.description.slice(0, 1800)}`,
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

  const adapted = existing && forceRetailor
    ? await (async () => {
      await db.resumeVersion.create({
        data: { resumeId: existing.id, userId: prep.userId, content: existing.content as Prisma.InputJsonValue, name: existing.name },
      })
      return db.resume.update({ where: { id: existing.id }, data: { content: adaptedContent as Prisma.InputJsonValue } })
    })()
    : await db.resume.create({
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
