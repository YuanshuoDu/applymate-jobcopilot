/**
 * POST /api/ai/suggest
 *
 * Body: {
 *   resumeContent:   ResumeContent
 *   jobTitle?:       string
 *   jobCompany?:     string
 *   jobDescription?: string
 *   missingKeywords?: string[]
 * }
 *
 * Returns: { suggestions: Array<{ text: string }> }
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

  const { resumeContent, jobTitle, jobCompany, jobDescription, missingKeywords } = body as {
    resumeContent:    ResumeContent
    jobTitle?:        string
    jobCompany?:      string
    jobDescription?:  string
    missingKeywords?: string[]
  }

  if (!resumeContent) return err('resumeContent is required')

  const prompt = `You are an expert career coach helping a candidate improve their resume for a specific job.

CANDIDATE SUMMARY: ${resumeContent.summary || 'Not provided'}
SKILLS: ${(resumeContent.skills ?? []).join(', ') || 'None listed'}
EXPERIENCE ROLES: ${(resumeContent.experience ?? []).map(e => `${e.role} at ${e.company}`).join('; ') || 'None listed'}

TARGET JOB: ${jobTitle ?? 'Not specified'} at ${jobCompany ?? 'Not specified'}
${missingKeywords?.length ? `\nKEYWORDS MISSING FROM RESUME: ${missingKeywords.join(', ')}` : ''}
${jobDescription ? `\nJOB DESCRIPTION (excerpt):\n${jobDescription.slice(0, 1500)}` : ''}

Provide exactly 3 specific, actionable suggestions to improve this resume for this job.
Each suggestion must be concrete (mention specific skills, phrases, or metrics to add).

Return ONLY a JSON array of 3 strings — no markdown, no explanation, raw JSON only:
["suggestion 1", "suggestion 2", "suggestion 3"]`

  try {
    const message = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 768,
      messages:   [{ role: 'user', content: prompt }],
    })

    const raw  = message.content[0].type === 'text' ? message.content[0].text.trim() : '[]'
    const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
    const texts: string[] = JSON.parse(json)

    const suggestions = texts.map(text => ({ text, applied: false }))
    return ok({ suggestions })
  } catch (e) {
    console.error('[/api/ai/suggest] error:', e)
    return err('AI suggestions failed — check ANTHROPIC_API_KEY and try again', 500)
  }
}
