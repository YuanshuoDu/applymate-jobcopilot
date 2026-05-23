/**
 * POST /api/ai/cover-letter
 * Body: { resumeContent, jobTitle, jobCompany, jobDescription?, tone?, recipientName? }
 * Returns: { coverLetter: string }
 */
import { NextRequest } from 'next/server'
import { prepareAiRoute, ok, err } from '@/lib/api-helpers'
import { modelChat, stripFences, type AiConfig } from '@/lib/model-router'
import { db } from '@/lib/db'

const COVER_FALLBACKS: AiConfig[] = [
  { provider: 'deepseek', model: 'deepseek-chat' },
  { provider: 'minimax',  model: 'MiniMax-M2.7'  },
]
import type { ResumeContent } from '@/lib/types'

export async function POST(req: NextRequest) {
  const prep = await prepareAiRoute(req, 'coverLetter')
  if ('error' in prep) return prep.error

  const body = await req.json().catch(() => null)
  if (!body) return err('Invalid JSON body')

  const { resumeContent, jobTitle, jobCompany, jobDescription, tone = 'professional', recipientName } = body as {
    resumeContent: ResumeContent; jobTitle: string; jobCompany: string; jobDescription?: string; tone?: string; recipientName?: string
  }

  if (!resumeContent) return err('resumeContent is required')
  if (!jobTitle)      return err('jobTitle is required')
  if (!jobCompany)    return err('jobCompany is required')

  // Load Writer Agent role config (model + system prompt) for consistency with pipeline
  const writerRole = await db.agentRole.findFirst({
    where:  { userId: prep.userId, role: 'writer' },
    select: { provider: true, model: true, apiKey: true, systemPrompt: true },
  }).catch(() => null)

  const cfg: import('@/lib/model-router').AiConfig = writerRole
    ? { provider: writerRole.provider as any, model: writerRole.model, apiKey: writerRole.apiKey ?? undefined }
    : prep.cfg

  const writerSystemPrompt = writerRole?.systemPrompt
    ?? 'You are a professional cover letter writer. Output ONLY the cover letter text — no preamble, no meta-commentary, no explanation. Start directly with the greeting.'

  const name       = resumeContent.contact?.name ?? 'the applicant'
  const skills     = (resumeContent.skills ?? []).slice(0, 8).join(', ')
  const latestRole = resumeContent.experience?.[0]
  const greeting   = recipientName ? `Dear ${recipientName},` : 'Dear Hiring Manager,'
  const toneGuide  = {
    professional: 'formal, confident, and polished',
    enthusiastic: 'warm, energetic, and genuine',
    concise:      'direct and punchy — no filler',
  }[tone] ?? 'professional'

  const prompt = `Write a cover letter for a job applicant.

APPLICANT: ${name}${latestRole ? `, ${latestRole.role} at ${latestRole.company}` : ''}
KEY SKILLS: ${skills}
${resumeContent.summary ? `SUMMARY: ${resumeContent.summary}` : ''}

TARGET: ${jobTitle} at ${jobCompany}
${jobDescription ? `JD EXCERPT:\n${jobDescription.slice(0, 1500)}` : ''}

Tone: ${toneGuide}
Structure: ${greeting} | hook | why this role | 2-3 achievements | CTA | Sincerely, / ${name}
Rules: 220–280 words, no filler like "I am writing to express my interest", quantify achievements.
Return ONLY the cover letter text.`

  // Use Writer Agent's system prompt if configured, otherwise default
  const messages = [
    { role: 'system' as const, content: writerSystemPrompt },
    { role: 'user' as const, content: prompt },
  ]

  async function tryCoverLetter(): Promise<{ text: string; model: string }> {
    const attempts = [cfg, ...COVER_FALLBACKS.filter(f =>
      !(f.provider === cfg.provider && f.model === cfg.model)
    )]
    let lastErr: unknown
    for (const attempt of attempts) {
      try {
        const result = await modelChat(messages, attempt, 4096)
        return { text: result.text, model: `${attempt.provider}/${attempt.model}` }
      } catch (e) {
        lastErr = e
        console.warn(`[/api/ai/cover-letter] ${attempt.provider}/${attempt.model} failed:`, (e as Error).message?.slice(0, 100))
      }
    }
    throw lastErr
  }

  try {
    const { text: raw, model } = await tryCoverLetter()
    // Strip code fences and <think> blocks, then extract the letter body
    let letter = stripFences(raw)
    // If model prepended reasoning/preamble, extract from first greeting
    const greetingIdx = letter.search(/Dear\s/i)
    if (greetingIdx > 20) letter = letter.slice(greetingIdx)
    // Optionally persist to CoverLetter table
    const { jobId, resumeId } = body as { jobId?: string; resumeId?: string } & typeof body
    let coverLetterId: string | undefined
    if (jobId) {
      try {
        const cl = await db.coverLetter.create({
          data: {
            userId:   prep.userId,
            jobId,
            resumeId: resumeId ?? null,
            content:  letter.trim(),
            tone:     tone ?? 'professional',
            origin:   'ai-generated',
            isFinal:  false,
          },
        })
        coverLetterId = cl.id
      } catch { /* non-fatal — legacy callers still get the text */ }
    }
    return ok({ coverLetter: letter.trim(), coverLetterId, _model: model })
  } catch (e) {
    console.error('[/api/ai/cover-letter]', e)
    return err(`Cover letter failed (${cfg.provider}/${cfg.model}): ${(e as Error).message}`, 500)
  }
}
