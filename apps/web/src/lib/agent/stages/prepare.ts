/**
 * Stage 3 — Prepare
 * Role: 准备员
 * For each scored job above minMatchScore:
 *   - Generates cover letter (if autoCoverLetter=true)
 *   - Packages job + score + materials into ApplicationPackage
 */
import { modelChat, stripFences } from '@/lib/model-router'
import type { AiConfig } from '@/lib/model-router'
import type {
  PipelineCtx, ScoredJob, ApplicationPackage, PrepareOutput,
  AgentConfigFull, StageResult, AcceptResult,
} from '../types'
import { stageOk } from '../types'

const THROTTLE_MS = 200

export async function runPrepare(
  scoredJobs: ScoredJob[],
  ctx: PipelineCtx,
): Promise<StageResult<PrepareOutput>> {
  const t0 = Date.now()
  const { agentCfg, resumeContent, aiConfig, roleConfigs, emit } = ctx
  // Use writer role's configured model
  const writerCfg = roleConfigs.writer
  const effectiveAiConfig: AiConfig = writerCfg
    ? { provider: writerCfg.provider as AiConfig['provider'], model: writerCfg.model, apiKey: writerCfg.apiKey }
    : aiConfig
  const writerSystemPrompt = writerCfg?.systemPrompt ?? undefined

  const aboveThreshold = scoredJobs.filter(sj => sj.score >= agentCfg.minMatchScore)
  const packages: ApplicationPackage[] = []
  const pendingLetters: Array<{ jobId: string; coverLetter: string }> = []

  for (const sj of aboveThreshold) {
    let coverLetter: string | undefined

    if (agentCfg.autoCoverLetter) {
      try {
        coverLetter = await generateCoverLetter(sj, agentCfg, resumeContent, effectiveAiConfig, writerSystemPrompt)
        pendingLetters.push({ jobId: sj.job.id, coverLetter })
        await new Promise(r => setTimeout(r, THROTTLE_MS))
      } catch (err) {
        console.error('[prepare] cover letter error:', err)
        emit('info', { message: `Cover letter skipped for ${sj.job.company}: ${(err as Error).message}` })
      }
    }

    packages.push({
      ...sj,
      ...(coverLetter ? { coverLetter } : {}),
      tailoredKeywords: sj.missingKeywords.length ? sj.missingKeywords : undefined,
    })
  }

  // Batch persist cover letters
  if (pendingLetters.length > 0) {
    const { db } = await import('@/lib/db')
    await Promise.all(
      pendingLetters.map(pl =>
        db.job.update({ where: { id: pl.jobId }, data: { coverLetter: pl.coverLetter } as any }).catch(() => {})
      )
    )
  }

  return stageOk('prepare', { packages }, packages.length, Date.now() - t0)
}

export function acceptPrepare(
  result: StageResult<PrepareOutput>,
  cfg: AgentConfigFull,
): AcceptResult {
  if (!result.ok || !result.data) return { ok: true } // non-fatal stage

  if (cfg.autoCoverLetter) {
    const missing = result.data.packages.filter(
      p => p.score >= cfg.minMatchScore && !p.coverLetter
    )
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `${missing.length} job(s) above threshold missing cover letter (API may have failed)`,
      }
    }
  }
  return { ok: true }
}

// ── Cover letter generation ───────────────────────────────────────────────────

async function generateCoverLetter(
  sj: ScoredJob,
  cfg: AgentConfigFull,
  resume: { contact?: { name?: string }; summary?: string; experience?: { role: string; company: string; period: string }[] },
  aiConfig: ReturnType<typeof import('@/lib/model-router')['resolveConfig']> extends never ? never : Parameters<typeof modelChat>[1],
  systemPrompt?: string,
): Promise<string> {
  const name       = resume.contact?.name ?? 'the applicant'
  const latestRole = resume.experience?.[0]
  const greeting   = 'Dear Hiring Manager,'
  const toneMap: Record<string, string> = {
    professional: 'formal, confident, and polished',
    confident:    'assertive, results-focused, and direct',
    concise:      'direct and punchy — no filler',
  }
  const toneGuide = toneMap[cfg.coverTone] ?? toneMap.professional

  const prompt = `Write a cover letter for a job applicant.

APPLICANT: ${name}${latestRole ? `, ${latestRole.role} at ${latestRole.company}` : ''}
MATCHED SKILLS: ${sj.matchedKeywords.join(', ')}
MISSING/ADD THESE: ${sj.missingKeywords.join(', ')}

TARGET: ${sj.job.role} at ${sj.job.company}${sj.job.location ? ` (${sj.job.location})` : ''}
${sj.job.description ? `JD EXCERPT:\n${sj.job.description.slice(0, 1000)}` : ''}

Tone: ${toneGuide}
Structure: ${greeting} | hook | why this role | 2-3 achievements | CTA | Sincerely, ${name}
Rules: 220-280 words, no filler like "I am writing to express", quantify where possible.
Return ONLY the cover letter text.`

  const messages = systemPrompt
    ? [{ role: 'system' as const, content: systemPrompt }, { role: 'user' as const, content: prompt }]
    : [{ role: 'user' as const, content: prompt }]

  const result = await modelChat(messages, aiConfig, 800)
  return stripFences(result.text).trim()
}
