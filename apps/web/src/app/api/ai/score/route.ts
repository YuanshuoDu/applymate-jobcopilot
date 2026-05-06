/**
 * POST /api/ai/score
 * Body: { resumeContent, jobTitle?, jobCompany?, jobDescription? }
 * Returns: { score, matchedKeywords, missingKeywords, sectionScores, sectionTips }
 */
import { NextRequest } from 'next/server'
import { requireAuth, isErrorResponse, ok, err } from '@/lib/api-helpers'
import { checkRateLimit } from '@/lib/rate-limit'
import { modelChat, stripFences, resolveConfig } from '@/lib/model-router'
import { db } from '@/lib/db'
import type { ResumeContent } from '@/lib/types'

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const rl = checkRateLimit(`ai:${auth.userId}`)
  if (!rl.ok) return err(`Rate limit exceeded — retry in ${rl.retryAfter}s`, 429)

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { resumeContent, jobTitle, jobCompany, jobDescription } = body as {
    resumeContent?:  ResumeContent
    jobTitle?:       string
    jobCompany?:     string
    jobDescription?: string
  }

  if (!jobTitle && !jobDescription) return err('jobTitle or jobDescription is required')

  // Load user's AI config
  const user  = await db.user.findUnique({ where: { id: auth.userId }, select: { preferences: true } })
  const prefs = (user?.preferences ?? {}) as Record<string, unknown>
  const cfg   = resolveConfig((prefs.aiConfig ?? null) as Parameters<typeof resolveConfig>[0])

  const resumeText = resumeContent ? resumeToText(resumeContent) : '(no resume provided)'

  const prompt = `You are an expert ATS analyzer. Analyze how well the resume matches the job posting.

RESUME:
${resumeText}

JOB: ${jobTitle ?? 'Not specified'} at ${jobCompany ?? 'Not specified'}
${jobDescription ? `JOB DESCRIPTION:\n${jobDescription.slice(0, 2000)}` : ''}

Return ONLY a valid JSON object — no markdown, no explanation:
{
  "score": <integer 0-100>,
  "matchedKeywords": ["keyword", ...],
  "missingKeywords": ["keyword", ...],
  "sectionScores": { "Summary": <0-100>, "Experience": <0-100>, "Skills": <0-100>, "Education": <0-100> },
  "sectionTips": { "Summary": "<tip>", "Experience": "<tip>", "Skills": "<tip>", "Education": "<tip>" }
}`

  try {
    const result = await modelChat([{ role: 'user', content: prompt }], cfg, 1024)
    const parsed = JSON.parse(stripFences(result.text))
    return ok({ ...parsed, _model: `${cfg.provider}/${cfg.model}` })
  } catch (e) {
    console.error('[/api/ai/score]', e)
    return err(`AI scoring failed (${cfg.provider}/${cfg.model}): ${(e as Error).message}`, 500)
  }
}

function resumeToText(r: ResumeContent): string {
  const lines: string[] = []
  lines.push(`Name: ${r.contact?.name ?? ''}`)
  if (r.contact?.location) lines.push(`Location: ${r.contact.location}`)
  if (r.summary) { lines.push('\nSUMMARY:'); lines.push(r.summary) }
  if (r.experience?.length) {
    lines.push('\nEXPERIENCE:')
    for (const e of r.experience) {
      lines.push(`${e.role} at ${e.company} (${e.period})`)
      for (const b of (e.bullets ?? [])) lines.push(`  • ${b}`)
    }
  }
  if (r.skills?.length) { lines.push('\nSKILLS:'); lines.push(r.skills.join(', ')) }
  if (r.education?.length) {
    lines.push('\nEDUCATION:')
    for (const e of r.education) lines.push(`${e.degree} — ${e.institution} (${e.year})`)
  }
  return lines.join('\n')
}
