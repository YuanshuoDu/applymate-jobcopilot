/**
 * POST /api/ai/suggest
 * Returns 3-5 structured suggestions targeting specific resume sections.
 * All suggestions MUST be based on the user's real resume data.
 */
import { NextRequest } from 'next/server'
import { prepareAiRoute, ok, err } from '@/lib/api-helpers'
import { modelChat, stripFences } from '@/lib/model-router'
import type { ResumeContent } from '@/lib/types'

export async function POST(req: NextRequest) {
  const prep = await prepareAiRoute(req, 'suggest')
  if ('error' in prep) return prep.error

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { resumeContent, jobTitle, jobCompany, jobDescription } = body as {
    resumeContent: ResumeContent; jobTitle?: string; jobCompany?: string; jobDescription?: string
  }
  if (!resumeContent) return err('resumeContent is required')
  const cfg = prep.cfg

  const summary    = resumeContent.summary || 'none'
  const skills     = (resumeContent.skills ?? []).join(', ') || 'none'
  const experience = (resumeContent.experience ?? []).map(e =>
    `${e.role} at ${e.company}: ${(e.bullets ?? []).join('; ')}`
  ).join('\n') || 'none'

  const prompt = `Resume summary: ${summary}
Resume skills: ${skills}
Resume experience: ${experience.slice(0, 2000)}
Target: ${jobTitle ?? ''} at ${jobCompany ?? ''}
${jobDescription ? `Job description: ${jobDescription.slice(0, 1000)}` : ''}

Give 3 improvement suggestions. ONLY use real info from the resume. Output ONLY this JSON array (no other text):
[
{"text":"suggestion","target":"summary","action":"rewrite","proposed":"new summary text"},
{"text":"suggestion","target":"skills","action":"reorder","proposed":"reordered skill list"},
{"text":"suggestion","target":"experience","action":"enhance","proposed":"improved bullet"}
]`

  try {
    const result = await modelChat([{ role: 'user', content: prompt }], cfg, 3000)
    const text   = stripFences(result.text)
    let parsed: unknown[]
    try {
      parsed = JSON.parse(text)
      if (!Array.isArray(parsed)) parsed = [parsed]
    } catch {
      // Last-resort fallback: return the raw text as a single general suggestion
      const snippet = text.slice(0, 300).replace(/[{}[\]"]/g, '')
      return ok({
        suggestions: [{
          text: snippet || 'Could not generate suggestions. Try again.',
          target: 'general' as const, action: 'none' as const, applied: false,
        }],
        _model: `${cfg.provider}/${cfg.model}`,
      })
    }

    const TARGETS = new Set(['summary','skills','experience','education','general'])
    const ACTIONS = new Set(['rewrite','reorder','enhance','add_keywords','none'])

    // Normalise to lowercase before set-lookup so "Summary" and "summary" both match
    const suggestions = (parsed as Array<Record<string, unknown>>).map((s) => {
      const targetNorm = String(s.target ?? '').toLowerCase()
      const actionNorm = String(s.action ?? '').toLowerCase()
      return {
        text:     String(s.text ?? ''),
        target:   TARGETS.has(targetNorm) ? targetNorm as 'summary'|'skills'|'experience'|'education'|'general' : 'general',
        action:   ACTIONS.has(actionNorm) ? actionNorm as 'rewrite'|'reorder'|'enhance'|'add_keywords'|'none' : 'none',
        proposed: s.proposed ? String(s.proposed) : undefined,
        applied:  false,
      }
    })

    return ok({ suggestions, _model: `${cfg.provider}/${cfg.model}` })
  } catch (e) {
    console.error('[/api/ai/suggest]', e)
    return err(`AI suggestions failed: ${(e as Error).message}`, 500)
  }
}
