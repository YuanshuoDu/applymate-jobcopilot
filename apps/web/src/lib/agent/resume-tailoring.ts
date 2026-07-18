import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { modelChat, parseAiJson, type AiConfig } from '@/lib/model-router'

export interface TailoredResumeArtifact {
  id: string
  name: string
  jobId: string
  company: string
  role: string
  reused: boolean
}

type TailoringInput = {
  userId: string
  resumeId: string
  jobId: string
  aiConfig: AiConfig
}

/**
 * Creates one reviewable resume artifact for a job. It deliberately does not
 * assign Job.finalResumeId: that is the separate Reviewer/user confirmation.
 */
export async function tailorResumeForAgent(input: TailoringInput): Promise<TailoredResumeArtifact> {
  const [resume, job] = await Promise.all([
    db.resume.findFirst({ where: { id: input.resumeId, userId: input.userId } }),
    db.job.findFirst({ where: { id: input.jobId, userId: input.userId } }),
  ])
  if (!resume) throw new Error('Selected resume was not found.')
  if (!job) throw new Error('Selected job was not found.')
  if (!job.description?.trim()) throw new Error('This job needs a description before tailoring the resume.')

  const existing = await db.resume.findFirst({
    where: { userId: input.userId, parentResumeId: resume.id, targetJobId: job.id, origin: 'ai-adapted' },
    orderBy: { updatedAt: 'desc' },
  })
  if (existing) return artifact(existing, job, true)

  const result = await modelChat([{ role: 'user', content: prompt(resume.content, job) }], input.aiConfig, 2400)
  const content = parseAiJson<Record<string, unknown>>(result.text)
  if (!content || Array.isArray(content)) throw new Error('The writer returned an invalid resume document.')

  const created = await db.resume.create({
    data: {
      userId: input.userId,
      name: `Tailored for ${job.company} - ${job.role}`,
      content: content as Prisma.InputJsonValue,
      templateId: resume.templateId,
      templateOptions: resume.templateOptions ?? undefined,
      isDefault: false,
      directionId: resume.directionId,
      kind: 'adapted',
      parentResumeId: resume.id,
      targetJobId: job.id,
      origin: 'ai-adapted',
      basicsDetached: resume.basicsDetached,
    },
  })
  await db.activity.create({
    data: {
      userId: input.userId,
      jobId: job.id,
      type: 'resume_tailored',
      text: `Writer created tailored resume "${created.name}" for review`,
      color: '#3B6D11',
    },
  }).catch(() => undefined)
  return artifact(created, job, false)
}

function artifact(resume: { id: string; name: string }, job: { id: string; company: string; role: string }, reused: boolean): TailoredResumeArtifact {
  return { id: resume.id, name: resume.name, jobId: job.id, company: job.company, role: job.role, reused }
}

function prompt(content: unknown, job: { company: string; role: string; description: string | null; keywords: string | null }) {
  return [
    'You are the ApplyMate Writer. Return ONLY a complete JSON resume object with the same structure as the source.',
    'Preserve truthful candidate facts. Do not invent employers, education, dates, metrics, tools, or achievements.',
    'Improve wording and add only job-description keywords supported by the source resume.',
    `TARGET JOB: ${job.role} at ${job.company}`,
    job.keywords ? `KNOWN ATS KEYWORDS: ${job.keywords}` : '',
    `JOB DESCRIPTION:\n${job.description?.slice(0, 5000) ?? ''}`,
    `SOURCE RESUME JSON:\n${JSON.stringify(content)}`,
  ].filter(Boolean).join('\n\n')
}
