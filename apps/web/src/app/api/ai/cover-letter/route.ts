/**
 * POST /api/ai/cover-letter
 * Body: { resumeContent, jobTitle, jobCompany, jobDescription?, tone?, recipientName? }
 * Returns: { coverLetter: string }
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { checkRateLimit } from '@/lib/rate-limit'
import { modelChat, resolveConfig } from '@/lib/model-router'
import { db } from '@/lib/db'
import type { ResumeContent } from '@/lib/types'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const rl = checkRateLimit(`ai:${auth.userId}`)
  if (!rl.ok) return err(`Rate limit exceeded — retry in ${rl.retryAfter}s`, 429)

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { resumeContent, jobTitle, jobCompany, jobDescription, tone = 'professional', recipientName } = body as {
    resumeContent:   ResumeContent
    jobTitle:        string
    jobCompany:      string
    jobDescription?: string
    tone?:           string
    recipientName?:  string
  }

  if (!resumeContent) return err('resumeContent is required')
  if (!jobTitle)      return err('jobTitle is required')
  if (!jobCompany)    return err('jobCompany is required')

  const user  = await db.user.findUnique({ where: { id: auth.userId }, select: { preferences: true } })
  const prefs = (user?.preferences ?? {}) as Record<string, unknown>
  const cfg   = resolveConfig((prefs.aiConfig ?? null) as Parameters<typeof resolveConfig>[0])

  const name       = resumeContent.contact?.name ?? 'the applicant'
  const skills     = (resumeContent.skills ?? []).slice(0, 8).join(', ')
  const latestRole = resumeContent.experience?.[0]
  const greeting   = recipientName ? `Dear ${recipientName},` : 'Dear Hiring Manager,'
  const toneGuide  = {
    professional: 'formal, confident, and polished',
    enthusiastic: 'warm, energetic, and genuine',
    concise:      'direct and punchy — no filler',
  }[tone] ?? 'professional'

  const prompt = `Write a cover letter for a job applicant.

APPLICANT: ${name}${latestRole ? `, ${latestRole.role} at ${latestRole.company}` : ''}
KEY SKILLS: ${skills}
${resumeContent.summary ? `SUMMARY: ${resumeContent.summary}` : ''}

TARGET: ${jobTitle} at ${jobCompany}
${jobDescription ? `JD EXCERPT:\n${jobDescription.slice(0, 1500)}` : ''}

Tone: ${toneGuide}
Structure: ${greeting} | hook | why this role | 2-3 achievements | CTA | Sincerely, / ${name}
Rules: 250–320 words, no filler like "I am writing to express my interest", quantify achievements.
Return ONLY the cover letter text.`

  try {
    const result = await modelChat([{ role: 'user', content: prompt }], cfg, 1024)
    return ok({ coverLetter: result.text, _model: `${cfg.provider}/${cfg.model}` })
  } catch (e) {
    console.error('[/api/ai/cover-letter]', e)
    return err(`Cover letter failed (${cfg.provider}/${cfg.model}): ${(e as Error).message}`, 500)
  }
}
