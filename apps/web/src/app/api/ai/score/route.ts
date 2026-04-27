/**
 * POST /api/ai/score
 *
 * Body: {
 *   resumeContent: ResumeContent   — the resume to score
 *   jobTitle?:     string          — job role name
 *   jobCompany?:   string          — company name
 *   jobDescription?: string        — full JD text (optional but improves accuracy)
 * }
 *
 * Returns: {
 *   score:           number                     0-100 overall match
 *   matchedKeywords: string[]
 *   missingKeywords: string[]
 *   sectionScores:   Record<string, number>
 *   sectionTips:     Record<string, string>
 * }
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

  const { resumeContent, jobTitle, jobCompany, jobDescription } = body as {
    resumeContent:  ResumeContent
    jobTitle?:      string
    jobCompany?:    string
    jobDescription?: string
  }

  if (!resumeContent) return err('resumeContent is required')
  if (!jobTitle && !jobDescription) return err('jobTitle or jobDescription is required')

  const resumeText = resumeToText(resumeContent)

  const prompt = `You are an expert ATS (Applicant Tracking System) analyzer and career coach.
Analyze how well the resume matches the job posting.

RESUME:
${resumeText}

JOB: ${jobTitle ?? 'Not specified'} at ${jobCompany ?? 'Not specified'}
${jobDescription ? `JOB DESCRIPTION:\n${jobDescription.slice(0, 2000)}` : ''}

Return ONLY a valid JSON object — no markdown, no explanation, raw JSON only:
{
  "score": <integer 0-100, overall ATS match percentage>,
  "matchedKeywords": ["keyword", ...],
  "missingKeywords": ["keyword", ...],
  "sectionScores": {
    "Summary": <integer 0-100>,
    "Experience": <integer 0-100>,
    "Skills": <integer 0-100>,
    "Education": <integer 0-100>
  },
  "sectionTips": {
    "Summary": "<one actionable sentence>",
    "Experience": "<one actionable sentence>",
    "Skills": "<one actionable sentence>",
    "Education": "<one actionable sentence>"
  }
}`

  try {
    const message = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1024,
      messages:   [{ role: 'user', content: prompt }],
    })

    const raw  = message.content[0].type === 'text' ? message.content[0].text.trim() : '{}'
    // Strip possible markdown code fences
    const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
    const result = JSON.parse(json)
    return ok(result)
  } catch (e) {
    console.error('[/api/ai/score] error:', e)
    return err('AI scoring failed — check ANTHROPIC_API_KEY and try again', 500)
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function resumeToText(r: ResumeContent): string {
  const lines: string[] = []
  lines.push(`Name: ${r.contact?.name ?? ''}`)
  if (r.contact?.location) lines.push(`Location: ${r.contact.location}`)
  if (r.contact?.email)    lines.push(`Email: ${r.contact.email}`)

  if (r.summary) {
    lines.push('\nSUMMARY:')
    lines.push(r.summary)
  }

  if (r.experience?.length) {
    lines.push('\nEXPERIENCE:')
    for (const e of r.experience) {
      lines.push(`${e.role} at ${e.company} (${e.period})`)
      for (const b of (e.bullets ?? [])) lines.push(`  • ${b}`)
    }
  }

  if (r.skills?.length) {
    lines.push('\nSKILLS:')
    lines.push(r.skills.join(', '))
  }

  if (r.education?.length) {
    lines.push('\nEDUCATION:')
    for (const e of r.education) {
      lines.push(`${e.degree} — ${e.institution} (${e.year})`)
    }
  }

  if (r.languages?.length) {
    lines.push('\nLANGUAGES:')
    lines.push(r.languages.map(l => `${l.lang} (${l.level})`).join(', '))
  }

  return lines.join('\n')
}
