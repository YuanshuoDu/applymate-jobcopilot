/**
 * POST /api/ai/cover-letter
 * Body: { resumeContent, jobTitle, jobCompany, jobDescription?, tone?, recipientName? }
 * Returns: { coverLetter: string }
 */
import { NextRequest } from 'next/server'
import { prepareAiRoute, ok, err } from '@/lib/api-helpers'
import { modelChat } from '@/lib/model-router'
import type { ResumeContent } from '@/lib/types'

export async function POST(req: NextRequest) {
  const prep = await prepareAiRoute(req, 'coverLetter')
  if ('error' in prep) return prep.error

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { resumeContent, jobTitle, jobCompany, jobDescription, tone = 'professional', recipientName } = body as {
    resumeContent: ResumeContent; jobTitle: string; jobCompany: string; jobDescription?: string; tone?: string; recipientName?: string
  }

  if (!resumeContent) return err('resumeContent is required')
  if (!jobTitle)      return err('jobTitle is required')
  if (!jobCompany)    return err('jobCompany is required')
  const cfg = prep.cfg

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
    const result = await modelChat([{ role: 'user', content: prompt }], cfg, 4096)
    return ok({ coverLetter: result.text, _model: `${cfg.provider}/${cfg.model}` })
  } catch (e) {
    console.error('[/api/ai/cover-letter]', e)
    return err(`Cover letter failed (${cfg.provider}/${cfg.model}): ${(e as Error).message}`, 500)
  }
}
