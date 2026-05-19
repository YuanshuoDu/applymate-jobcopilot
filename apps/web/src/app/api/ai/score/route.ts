/**
 * POST /api/ai/score
 * Analyses resume against target job across all sections.
 */
import { NextRequest } from 'next/server'
import { prepareAiRoute, ok, err } from '@/lib/api-helpers'
import { modelChat, parseAiJson, type AiConfig } from '@/lib/model-router'
import type { ResumeContent } from '@/lib/types'

// Fallback providers tried in order when primary model fails
const SCORE_FALLBACKS: AiConfig[] = [
  { provider: 'deepseek', model: 'deepseek-chat' },
  { provider: 'minimax',  model: 'MiniMax-M2.7'  },
]

export async function POST(req: NextRequest) {
  const prep = await prepareAiRoute(req, 'scoring')
  if ('error' in prep) return prep.error

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { resumeContent, jobTitle, jobCompany, jobDescription, keySkills } = body as {
    resumeContent?: ResumeContent; jobTitle?: string; jobCompany?: string
    jobDescription?: string; keySkills?: string[]
  }
  if (!jobTitle && !jobDescription) return err('jobTitle or jobDescription is required')

  const cfg        = prep.cfg
  const resumeText = resumeContent ? resumeToText(resumeContent) : '(no resume)'

  const prompt = `Rate this resume against the job. Output ONLY this JSON (no other text):
{
"score": 85,
"matchedKeywords": ["skill1","skill2"],
"sectionMatches": [
  {"section":"Summary","keywords":["keyword"],"score":80,"tip":"improve by..."},
  {"section":"Skills","keywords":["skill"],"score":90,"tip":"add..."},
  {"section":"Experience","keywords":["match"],"score":70,"tip":"quantify..."}
],
"missingItems": [
  {"keyword":"missing skill","target":"skills","tip":"add to skills"},
  {"keyword":"term","target":"summary","tip":"mention in summary"}
],
"sectionScores":{"Summary":80,"Skills":90,"Experience":70,"Education":60},
"sectionTips":{"Summary":"tip","Skills":"tip","Experience":"tip","Education":"tip"},
"skillsGap":["technology to learn"],
"strengthSummary":"one sentence summary"
}

RESUME:
${resumeText}

JOB: ${jobTitle ?? ''} at ${jobCompany ?? ''}
${keySkills?.length ? `KEY SKILLS: ${keySkills.join(', ')}` : ''}
${jobDescription ? `DESCRIPTION:\n${jobDescription.slice(0, 2000)}` : ''}`

  // Try primary model first, then fallbacks if it fails
  async function tryChat(): Promise<string> {
    const attempts = [cfg, ...SCORE_FALLBACKS.filter(f =>
      !(f.provider === cfg.provider && f.model === cfg.model)
    )]
    let lastErr: unknown
    for (const attempt of attempts) {
      try {
        const result = await modelChat([{ role: 'user', content: prompt }], attempt, 3000)
        return result.text
      } catch (e) {
        lastErr = e
        console.warn(`[/api/ai/score] ${attempt.provider}/${attempt.model} failed, trying next:`, (e as Error).message?.slice(0, 100))
      }
    }
    throw lastErr
  }

  try {
    const rawText = await tryChat()
    let parsed: Record<string, unknown>
    try {
      parsed = parseAiJson<Record<string, unknown>>(rawText)
    } catch {
      return err('AI returned invalid response, please try again', 500)
    }

    const rawScore = Number(parsed.score)
    if (!Number.isFinite(rawScore) || rawScore < 0 || rawScore > 100) {
      return err('AI returned invalid score value, please try again', 500)
    }

    const arr = (v: unknown) => Array.isArray(v) ? v as unknown[] : []
    // Normalise section names to Title Case so UI lookups (SEC_ORDER, sectionScores[sec])
    // are reliable regardless of what casing the AI returned ("summary" vs "Summary").
    const toTitle = (s: string) => s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s

    return ok({
      score:            rawScore,
      matchedKeywords:  Array.isArray(parsed.matchedKeywords) ? parsed.matchedKeywords as string[] : [],
      sectionMatches:   arr(parsed.sectionMatches).map((m: unknown) => {
        const o = m as Record<string, unknown> ?? {}
        return { section: toTitle(String(o.section ?? '')), keywords: arr(o.keywords) as string[], score: Number(o.score) || 0, tip: String(o.tip ?? '') }
      }),
      missingItems:     arr(parsed.missingItems).map((m: unknown) => {
        const o = m as Record<string, unknown> ?? {}
        // target is lowercase — matches applyTargeted() switch and SEC_LABELS lowercase keys
        return { keyword: String(o.keyword ?? ''), target: String(o.target ?? 'skills').toLowerCase(), tip: String(o.tip ?? '') }
      }),
      // Normalise sectionScores / sectionTips keys to Title Case to match SEC_ORDER values
      sectionScores: Object.fromEntries(
        Object.entries((parsed.sectionScores ?? {}) as Record<string, unknown>)
          .map(([k, v]) => [toTitle(k), Number(v) || 0])
      ),
      sectionTips: Object.fromEntries(
        Object.entries((parsed.sectionTips ?? {}) as Record<string, unknown>)
          .map(([k, v]) => [toTitle(k), String(v)])
      ),
      skillsGap:        Array.isArray(parsed.skillsGap) ? parsed.skillsGap as string[] : [],
      strengthSummary:  String(parsed.strengthSummary ?? ''),
      _model:           `${cfg.provider}/${cfg.model}`,
    })
  } catch (e) {
    console.error('[/api/ai/score]', e)
    return err(`AI scoring failed: ${(e as Error).message}`, 500)
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
  if (r.projects?.length) { lines.push('\nPROJECTS:'); lines.push(r.projects.map(p => p.name).join(', ')) }
  if (r.education?.length) {
    lines.push('\nEDUCATION:')
    for (const e of r.education) lines.push(`${e.degree} — ${e.institution} (${e.year})`)
  }
  return lines.join('\n')
}
