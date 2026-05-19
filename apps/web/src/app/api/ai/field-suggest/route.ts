/**
 * POST /api/ai/field-suggest
 * Body: { fieldType, currentValue, context?, feedback? }
 * Returns: { suggestions: string[] }
 * - Without feedback: returns 3 suggestions
 * - With feedback: returns 1 revised suggestion incorporating user feedback
 */
import { NextRequest } from 'next/server'
import { prepareAiRoute, ok, err } from '@/lib/api-helpers'
import { modelChat, parseAiJson, stripFences } from '@/lib/model-router'

type FieldType = 'summary' | 'bullet' | 'description' | 'custom'

const PROMPTS: Record<FieldType, (v: string, ctx: string, feedback?: string) => string> = {
  summary: (v, ctx, fb) => fb
    ? `You are a career coach. Rewrite this professional summary incorporating the following feedback.
CURRENT: ${v}
CONTEXT: ${ctx}
FEEDBACK: ${fb}
Return ONLY a single improved summary paragraph, no markdown, no quotes.`
    : `You are a career coach. Generate 3 distinct professional summary alternatives.
CURRENT: ${v || 'empty'}
CONTEXT: ${ctx}
Rules: each 2-4 sentences, professional tone, varies in style (concise/detailed/achievement-focused).
Output ONLY a JSON array of 3 strings: ["...", "...", "..."]`,

  bullet: (v, ctx, fb) => fb
    ? `You are a career coach. Rewrite this resume bullet incorporating the following feedback.
CURRENT: ${v}
CONTEXT: ${ctx}
FEEDBACK: ${fb}
Return ONLY a single improved bullet point (no leading bullet symbol), no markdown, no quotes.`
    : `You are a career coach. Generate 3 stronger versions of this resume bullet.
CURRENT: ${v || 'empty'}
CONTEXT: ${ctx}
Rules: start with an action verb, be specific and quantifiable where possible, vary in approach.
Output ONLY a JSON array of 3 strings: ["...", "...", "..."]`,

  description: (v, ctx, fb) => fb
    ? `Rewrite this project/item description incorporating: ${fb}
CURRENT: ${v}
CONTEXT: ${ctx}
Return ONLY a single improved description, no markdown, no quotes.`
    : `Generate 3 distinct descriptions for this resume item.
CURRENT: ${v || 'empty'}
CONTEXT: ${ctx}
Output ONLY a JSON array of 3 strings: ["...", "...", "..."]`,

  custom: (v, ctx, fb) => fb
    ? `Improve this resume text incorporating: ${fb}
CURRENT: ${v}
CONTEXT: ${ctx}
Return ONLY a single improved version, no markdown, no quotes.`
    : `Generate 3 improved versions of this resume text.
CURRENT: ${v || 'empty'}
CONTEXT: ${ctx}
Output ONLY a JSON array of 3 strings: ["...", "...", "..."]`,
}

export async function POST(req: NextRequest) {
  const prep = await prepareAiRoute(req, 'fieldSuggest')
  if ('error' in prep) return prep.error

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { fieldType = 'custom', currentValue = '', context = {}, feedback } = body as {
    fieldType?: FieldType; currentValue?: string; context?: Record<string, string>; feedback?: string
  }
  const cfg = prep.cfg

  const ctxStr = Object.entries(context)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')

  const promptFn = PROMPTS[fieldType] ?? PROMPTS.custom
  const prompt   = promptFn(currentValue, ctxStr, feedback)

  try {
    const result = await modelChat([{ role: 'user', content: prompt }], cfg, 3000)
    const text   = stripFences(result.text).trim()

    if (feedback) {
      return ok({ suggestions: [text] })
    }

    let suggestions: string[]
    try {
      const parsed = parseAiJson<unknown>(result.text)
      suggestions = (Array.isArray(parsed) ? parsed : [parsed]).slice(0, 3).map(String)
    } catch {
      suggestions = [text]
    }

    return ok({ suggestions })
  } catch (e) {
    console.error('[/api/ai/field-suggest]', e)
    return err(`AI field suggest failed: ${(e as Error).message}`, 500)
  }
}
