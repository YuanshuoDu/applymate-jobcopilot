/**
 * POST /api/ai/cover-letter
 *
 * Body: {
 *   resumeContent:   ResumeContent
 *   jobTitle:        string
 *   jobCompany:      string
 *   jobDescription?: string
 *   tone?:           'professional' | 'enthusiastic' | 'concise'  (default: 'professional')
 *   recipientName?:  string
 * }
 *
 * Returns: { coverLetter: string }
 */
import { NextRequest } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import type { ResumeContent } from '@/lib/types'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function POST(req: NextRequest) {
  const auth = await requireAuth()
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const {
    resumeContent,
    jobTitle,
    jobCompany,
    jobDescription,
    tone = 'professional',
    recipientName,
  } = body as {
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

  const name        = resumeContent.contact?.name ?? 'the applicant'
  const skills      = (resumeContent.skills ?? []).slice(0, 8).join(', ')
  const latestRole  = resumeContent.experience?.[0]
  const roleContext = latestRole ? `currently ${latestRole.role} at ${latestRole.company}` : 'an experienced professional'
  const greeting    = recipientName ? `Dear ${recipientName},` : 'Dear Hiring Manager,'

  const toneGuide = {
    professional:  'formal, confident, and polished — suitable for corporate roles',
    enthusiastic:  'warm, energetic, and genuine — shows real passion for the company',
    concise:       'direct and punchy — get to the point fast, no filler phrases',
  }[tone] ?? 'professional'

  const prompt = `You are an expert career coach writing a cover letter for a job applicant.

APPLICANT: ${name}, ${roleContext}
KEY SKILLS: ${skills}
SUMMARY: ${resumeContent.summary || 'Not provided'}
${latestRole ? `RECENT ACHIEVEMENT: ${latestRole.bullets?.[0] ?? ''}` : ''}

TARGET JOB: ${jobTitle} at ${jobCompany}
${jobDescription ? `JOB DESCRIPTION (excerpt):\n${jobDescription.slice(0, 1500)}` : ''}

Write a cover letter with this tone: ${toneGuide}

Structure:
1. Opening: ${greeting} then a compelling hook (1–2 sentences)
2. Body paragraph 1: Why this specific role at this company excites the applicant (connect to JD if given)
3. Body paragraph 2: 2–3 specific accomplishments from their experience that match the role
4. Closing: A confident call-to-action paragraph + sign-off

Rules:
- 3–4 paragraphs total, around 250–320 words
- Never use generic filler like "I am writing to express my interest"
- Make accomplishments specific and quantified where possible
- End with: Sincerely, / ${name}

Return ONLY the cover letter text — no preamble, no explanation.`

  try {
    const message = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1024,
      messages:   [{ role: 'user', content: prompt }],
    })

    const coverLetter = message.content[0].type === 'text' ? message.content[0].text.trim() : ''
    return ok({ coverLetter })
  } catch (e) {
    console.error('[/api/ai/cover-letter] error:', e)
    return err('Cover letter generation failed — check ANTHROPIC_API_KEY', 500)
  }
}
