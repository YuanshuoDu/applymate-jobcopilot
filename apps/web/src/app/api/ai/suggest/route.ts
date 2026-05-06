/**
 * POST /api/ai/suggest
 * Body: { resumeContent, jobTitle?, jobCompany?, jobDescription?, missingKeywords? }
 * Returns: { suggestions: Array<{ text: string }> }
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

  const { resumeContent, jobTitle, jobCompany, jobDescription, missingKeywords } = body as {
    resumeContent:    ResumeContent
    jobTitle?:        string
    jobCompany?:      string
    jobDescription?:  string
    missingKeywords?: string[]
  }

  if (!resumeContent) return err('resumeContent is required')

  const user  = await db.user.findUnique({ where: { id: auth.userId }, select: { preferences: true } })
  const prefs = (user?.preferences ?? {}) as Record<string, unknown>
  const cfg   = resolveConfig((prefs.aiConfig ?? null) as Parameters<typeof resolveConfig>[0])

  const prompt = `You are a career coach. Give 3 specific resume improvement suggestions.

RESUME SUMMARY: ${resumeContent.summary || 'None'}
SKILLS: ${(resumeContent.skills ?? []).join(', ') || 'None'}
ROLES: ${(resumeContent.experience ?? []).map(e => `${e.role} at ${e.company}`).join('; ') || 'None'}

TARGET: ${jobTitle ?? 'Not specified'} at ${jobCompany ?? 'Not specified'}
${missingKeywords?.length ? `MISSING KEYWORDS: ${missingKeywords.join(', ')}` : ''}
${jobDescription ? `JD:\n${jobDescription.slice(0, 1500)}` : ''}

Return ONLY a JSON array of 3 actionable strings — no markdown:
["suggestion 1", "suggestion 2", "suggestion 3"]`

  try {
    const result = await modelChat([{ role: 'user', content: prompt }], cfg, 768)
    const texts: string[] = JSON.parse(stripFences(result.text))
    return ok({ suggestions: texts.map(text => ({ text, applied: false })), _model: `${cfg.provider}/${cfg.model}` })
  } catch (e) {
    console.error('[/api/ai/suggest]', e)
    return err(`AI suggestions failed (${cfg.provider}/${cfg.model}): ${(e as Error).message}`, 500)
  }
}
