/**
 * POST /api/ai/translate
 * Body: { text, targetLang (default: "zh"), sourceLang? (default: auto-detect) }
 * Returns: { translated, sourceLang }
 *
 * Supported targetLang: zh, en, de, fr, es, ja, ko, pt, ar, ru, pl, nl, it
 */
import { NextRequest } from 'next/server'
import { prepareAiRoute, ok, err } from '@/lib/api-helpers'
import { modelChat, stripFences } from '@/lib/model-router'

const LANG_NAMES: Record<string, string> = {
  zh: 'Chinese', en: 'English', de: 'German', fr: 'French',
  es: 'Spanish', ja: 'Japanese', ko: 'Korean', pt: 'Portuguese',
  ar: 'Arabic', ru: 'Russian', pl: 'Polish', nl: 'Dutch', it: 'Italian',
}

export async function POST(req: NextRequest) {
  const prep = await prepareAiRoute(req, 'scoring')
  if ('error' in prep) return prep.error

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { text, targetLang, sourceLang } = body as {
    text?:       string
    targetLang?: string
    sourceLang?: string
  }

  if (!text?.trim()) return err('text is required')

  const tgt = targetLang ?? 'zh'
  const src = sourceLang && LANG_NAMES[sourceLang] ? sourceLang : 'auto'
  const tgtName = LANG_NAMES[tgt] ?? 'Chinese'

  const MAX_CHARS = 4000
  const trimmed = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + '\n\n[...truncated...]' : text

  const prompt = src === 'auto'
    ? `Translate the following job description to ${tgtName}. Detect the source language automatically. Preserve the original formatting, line breaks, and technical terms (do not translate company names, software names, or programming languages). Only output the translated text — no preamble, no explanation.

JOB DESCRIPTION:
${trimmed}`
    : `Translate the following job description from ${LANG_NAMES[src] ?? src} to ${tgtName}. Preserve the original formatting, line breaks, and technical terms (do not translate company names, software names, or programming languages). Only output the translated text — no preamble, no explanation.

JOB DESCRIPTION:
${trimmed}`

  try {
    const cfg    = prep.cfg
    const result = await modelChat([{ role: 'user', content: prompt }], cfg, 2048)
    return ok({
      translated:  result.text,
      sourceLang:  src,
      targetLang:  tgt,
      _model:      `${cfg.provider}/${cfg.model}`,
    })
  } catch (e) {
    console.error('[/api/ai/translate]', e)
    return err(`Translation failed: ${(e as Error).message}`, 500)
  }
}
