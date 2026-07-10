/**
 * POST /api/ai/score
 * Analyses resume against target job across all sections.
 */
import { NextRequest } from 'next/server'
import { prepareAiRoute, ok, err } from '@/lib/api-helpers'
import { APPLYMATE_BACKING, modelChat, stripFences, type AiConfig, type ChatResult } from '@/lib/model-router'
import type { ResumeContent } from '@/lib/types'

const SCORE_FALLBACKS: AiConfig[] = [
  APPLYMATE_BACKING,
  { provider: 'deepseek', model: 'deepseek-chat' },
  { provider: 'deepseek', model: 'deepseek-v4-flash' },
  { provider: 'minimax', model: 'MiniMax-Text-01' },
]

export async function POST(req: NextRequest) {
  const prep = await prepareAiRoute(req, 'jobScoring')
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
"keywords": "React, TypeScript, Node.js, AWS, 5 years experience",
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

The "keywords" field must contain specific technical skills, tools, frameworks, certifications, and role-specific terms extracted from the job description — NOT generic words like "communication" or "teamwork". Output as a comma-separated string.

RESUME:
${resumeText}

JOB: ${jobTitle ?? ''} at ${jobCompany ?? ''}
${keySkills?.length ? `KEY SKILLS: ${keySkills.join(', ')}` : ''}
${jobDescription ? `DESCRIPTION:\n${jobDescription.slice(0, 2000)}` : ''}`

  try {
    const { result, usedFallback } = await scoreWithFallback(prompt, cfg)
    const text = stripFences(result.text)
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(text) } catch {
      return ok({
        score: 0, keywords: '', matchedKeywords: [], sectionMatches: [], missingItems: [],
        sectionScores: {}, sectionTips: {}, skillsGap: [], strengthSummary: 'Analysis unavailable. Try again.',
      })
    }

    const arr = (v: unknown) => Array.isArray(v) ? v as unknown[] : []
    // Normalise section names to Title Case so UI lookups (SEC_ORDER, sectionScores[sec])
    // are reliable regardless of what casing the AI returned ("summary" vs "Summary").
    const toTitle = (s: string) => s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s

    return ok({
      score:            Number(parsed.score) || 0,
      keywords:         String(parsed.keywords ?? ''),
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
      _actualModel:      `${result.provider}/${result.model}`,
      _fallback:         usedFallback,
    })
  } catch (e) {
    console.error('[/api/ai/score]', e)
    return err(`AI scoring failed: ${(e as Error).message}`, 500)
  }
}

async function scoreWithFallback(prompt: string, primary: AiConfig): Promise<{ result: ChatResult; usedFallback: boolean }> {
  const attempts = dedupeConfigs([primary, ...SCORE_FALLBACKS])
  const errors: string[] = []

  for (let i = 0; i < attempts.length; i++) {
    const cfg = attempts[i]
    try {
      const result = await modelChat([{ role: 'user', content: prompt }], cfg, 3000)
      if (!result?.text) throw new Error('empty AI response')
      return { result, usedFallback: i > 0 }
    } catch (e) {
      errors.push(`${cfg.provider}/${cfg.model}: ${(e as Error).message}`)
    }
  }

  throw new Error(`当前 AI 配置不可用，备用模型也不可用。${errors.join(' | ')}`)
}

function dedupeConfigs(configs: AiConfig[]): AiConfig[] {
  const seen = new Set<string>()
  return configs.filter(cfg => {
    const key = `${cfg.provider}::${cfg.model}::${cfg.apiBase ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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
