/**
 * POST /api/jobs/[id]/cover-letters/generate
 * Body: { resumeId: string, tone?: string }
 * Generates a cover letter via AI and persists to CoverLetter table.
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { prepareAiRoute, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { modelChat, stripFences, type AiConfig } from '@/lib/model-router'
import type { ResumeContent } from '@/lib/types'

type Params = { params: Promise<{ id: string }> }

const COVER_FALLBACKS: AiConfig[] = [
  { provider: 'deepseek', model: 'deepseek-chat' },
  { provider: 'minimax',  model: 'MiniMax-M2.7'  },
]

export async function POST(req: NextRequest, { params }: Params) {
  const prep = await prepareAiRoute(req, 'coverLetter')
  if ('error' in prep) return prep.error

  const { id: jobId } = await params

  // Verify job belongs to user
  const job = await db.job.findFirst({ where: { id: jobId, userId: prep.userId } })
  if (!job) return err('Not found', 404)

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { resumeId, tone = 'professional' } = body as {
    resumeId: string
    tone?: string
  }

  if (!resumeId) return err('resumeId is required')

  // Prefer finalResume if job has one, otherwise use provided resumeId
  const effectiveResumeId = job.finalResumeId ?? resumeId

  const resume = await db.resume.findFirst({
    where: { id: effectiveResumeId, userId: prep.userId },
  })
  if (!resume) return err('Resume not found', 404)

  const resumeContent = resume.content as unknown as ResumeContent

  // Build prompt (same logic as /api/ai/cover-letter)
  const cfg = prep.cfg

  const name       = resumeContent.contact?.name ?? 'the applicant'
  const skills     = (resumeContent.skills ?? []).slice(0, 8).join(', ')
  const latestRole = resumeContent.experience?.[0]
  const greeting   = 'Dear Hiring Manager,'
  const toneGuide  = {
    professional: 'formal, confident, and polished',
    enthusiastic: 'warm, energetic, and genuine',
    concise:      'direct and punchy — no filler',
  }[tone] ?? 'professional'

  const jobRole    = job.role
  const jobCompany = job.company
  const jobDesc    = job.description

  const prompt = [
    'Write a cover letter for a job applicant.',
    '',
    'APPLICANT: ' + name + (latestRole ? `, ${latestRole.role} at ${latestRole.company}` : ''),
    'KEY SKILLS: ' + skills,
    resumeContent.summary ? 'SUMMARY: ' + resumeContent.summary : '',
    '',
    'TARGET: ' + jobRole + ' at ' + jobCompany,
    jobDesc ? 'JD EXCERPT:\n' + jobDesc.slice(0, 1500) : '',
    '',
    'Tone: ' + toneGuide,
    'Structure: ' + greeting + ' | hook | why this role | 2-3 achievements | CTA | Sincerely, / ' + name,
    'Rules: 250–320 words, no filler like "I am writing to express my interest", quantify achievements.',
    'Return ONLY the cover letter text.',
  ].filter(line => line !== undefined).join('\n')

  const messages = [
    { role: 'system' as const, content: 'You are a professional cover letter writer. Output ONLY the cover letter text — no preamble, no meta-commentary, no explanation. Start directly with the greeting.' },
    { role: 'user' as const, content: prompt },
  ]

  async function tryCoverLetter(): Promise<{ text: string; model: string }> {
    const attempts = [cfg, ...COVER_FALLBACKS.filter(f =>
      !(f.provider === cfg.provider && f.model === cfg.model)
    )]
    let lastErr: unknown
    for (const attempt of attempts) {
      try {
        const result = await modelChat(messages, attempt, 4096)
        return { text: result.text, model: attempt.provider + '/' + attempt.model }
      } catch (e) {
        lastErr = e
        console.warn('[/api/jobs/' + jobId + '/cover-letters/generate] ' + attempt.provider + '/' + attempt.model + ' failed:', (e as Error).message?.slice(0, 100))
      }
    }
    throw lastErr
  }

  try {
    const { text: raw, model } = await tryCoverLetter()
    let letter = stripFences(raw)
    const greetingIdx = letter.search(/Dear\s/i)
    if (greetingIdx > 20) letter = letter.slice(greetingIdx)
    const content = letter.trim()

    // Persist CoverLetter row, snapshotting template from resume
    const cl = await db.coverLetter.create({
      data: {
        userId:          prep.userId,
        jobId,
        resumeId:        effectiveResumeId,
        content,
        tone,
        templateId:      resume.templateId ?? null,
        templateOptions: resume.templateOptions ?? undefined,
        origin:          'ai-generated',
        isFinal:         false,
      },
    })

    return ok({ ...cl, _model: model }, 201)
  } catch (e) {
    console.error('[/api/jobs/' + jobId + '/cover-letters/generate]', e)
    return err('Cover letter generation failed (' + cfg.provider + '/' + cfg.model + '): ' + (e as Error).message, 500)
  }
}
