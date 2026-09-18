/**
 * POST /api/ai/suggest
 * Returns 3-5 structured suggestions targeting specific resume sections.
 * All suggestions MUST be based on the user's real resume data.
 */
import { NextRequest } from 'next/server'
import { prepareAiRoute, ok, err } from '@/lib/api-helpers'
import { modelChat, parseAiJson } from '@/lib/model-router'
import type { ResumeContent, Suggestion } from '@/lib/types'

const SUGGESTION_TARGETS = new Set<Exclude<Suggestion['target'], 'general'>>([
  'summary', 'skills', 'experience', 'education', 'projects',
])

export async function POST(req: NextRequest) {
  const prep = await prepareAiRoute(req, 'suggest')
  if ('error' in prep) return prep.error

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { resumeContent, jobTitle, jobCompany, jobDescription, section } = body as {
    resumeContent: ResumeContent; jobTitle?: string; jobCompany?: string; jobDescription?: string; section?: string
  }
  if (!resumeContent) return err('resumeContent is required')
  const requestedSection = typeof section === 'string' ? section.toLowerCase() : undefined
  if (requestedSection && !SUGGESTION_TARGETS.has(requestedSection as Exclude<Suggestion['target'], 'general'>)) {
    return err('section must be summary, skills, experience, education, or projects')
  }
  const cfg = prep.cfg

  const summary    = resumeContent.summary || 'none'
  const skills     = (resumeContent.skills ?? []).join(', ') || 'none'
  const experience = (resumeContent.experience ?? []).map(e =>
    `${e.role} at ${e.company}: ${(e.bullets ?? []).join('; ')}`
  ).join('\n') || 'none'
  const education = (resumeContent.education ?? []).map(e =>
    `${e.degree} at ${e.institution} (${e.year})`
  ).join('\n') || 'none'
  const projects = (resumeContent.projects ?? []).map(p =>
    `${p.name}: ${(p.bullets ?? []).join('; ')}`
  ).join('\n') || 'none'
  const sectionInstruction = requestedSection
    ? `Focus ONLY on the ${requestedSection} section. Every returned suggestion MUST use target "${requestedSection}". Do not return suggestions for any other section.`
    : 'Cover the resume sections that would most improve the match, using the target field to identify each section.'

  const prompt = `Resume summary: ${summary}
Resume skills: ${skills}
Resume experience: ${experience.slice(0, 2000)}
Resume education: ${education.slice(0, 1000)}
Resume projects: ${projects.slice(0, 1200)}
Target: ${jobTitle ?? ''} at ${jobCompany ?? ''}
${jobDescription ? `Job description: ${jobDescription.slice(0, 1000)}` : ''}
${sectionInstruction}

Give ${requestedSection ? '2-3' : '3'} improvement suggestions. ONLY use real info from the resume. Output ONLY this JSON array (no other text):
[
{"text":"suggestion","target":"summary","action":"rewrite","proposed":"new summary text"},
{"text":"suggestion","target":"skills","action":"reorder","proposed":"reordered skill list"},
{"text":"suggestion","target":"experience","action":"enhance","proposed":"improved bullet"}
]`

  try {
    const result = await modelChat([{ role: 'user', content: prompt }], cfg, 3000)
    let parsed: unknown[]
    try {
      const raw = parseAiJson<unknown>(result.text)
      parsed = Array.isArray(raw) ? raw : [raw]
    } catch {
      const snippet = result.text.replace(/<think>[\s\S]*?<\/think>/gi, '').slice(0, 300).replace(/[{}[\]"]/g, '').trim()
      return ok({
        suggestions: [{
          text: snippet || 'Could not generate suggestions. Try again.',
          target: (requestedSection ?? 'general') as Suggestion['target'], action: 'none' as const, applied: false,
        }],
        _model: `${cfg.provider}/${cfg.model}`,
      })
    }

    const TARGETS = new Set(['summary','skills','experience','education','projects','general'])
    const ACTIONS = new Set(['rewrite','reorder','enhance','add_keywords','none'])

    // Normalise to lowercase before set-lookup so "Summary" and "summary" both match
    const suggestions = (parsed as Array<Record<string, unknown>>).map((s) => {
      const targetNorm = String(s.target ?? '').toLowerCase()
      const actionNorm = String(s.action ?? '').toLowerCase()
      const normalizedTarget = requestedSection ?? (TARGETS.has(targetNorm) ? targetNorm : 'general')
      return {
        text:     String(s.text ?? ''),
        target:   normalizedTarget as Suggestion['target'],
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
