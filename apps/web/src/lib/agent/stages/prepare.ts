/**
 * Stage 3 — Prepare
 * Role: 准备员
 * For each scored job above minMatchScore:
 *   - Generates cover letter (if autoCoverLetter=true)
 *   - Packages job + score + materials into ApplicationPackage
 */
import { modelChat, stripFences } from '@/lib/model-router'
import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { buildPersona } from '@/lib/persona'
import { personaEvidenceContext } from '@/lib/persona-evidence'
import type { AiConfig } from '@/lib/model-router'
import type {
  PipelineCtx, ScoredJob, ApplicationPackage, PrepareOutput,
  AgentConfigFull, StageResult, AcceptResult,
} from '../types'
import { stageOk } from '../types'
import { roleAiConfig } from '../role-config'
import { forEachConcurrent } from '../concurrency'

const COVER_LETTER_LANGUAGE_NAMES = {
  en: 'English',
  de: 'German',
  fr: 'French',
  nl: 'Dutch',
  es: 'Spanish',
} as const

const COVER_LETTER_FORMALITY_GUIDES: Record<keyof typeof COVER_LETTER_LANGUAGE_NAMES, string> = {
  en: 'Use polished business English and a professional European application style.',
  de: 'Use formal German business conventions, including Sie/Ihnen where appropriate.',
  fr: 'Use formal French business conventions, including vous/votre where appropriate.',
  nl: 'Use formal Dutch business conventions, including u/uw where appropriate.',
  es: 'Use formal Spanish business conventions, including usted/su where appropriate.',
}

type CoverLetterLanguage = keyof typeof COVER_LETTER_LANGUAGE_NAMES

export function preparationFloor(minMatchScore: number): number {
  return Math.max(0, minMatchScore - 5)
}

function inferCoverLetterLanguage(sj: ScoredJob): CoverLetterLanguage {
  const haystack = [
    sj.job.location,
    sj.job.url,
    sj.job.description,
  ].filter(Boolean).join(' ').toLowerCase()

  if (/\b(deutschland|germany|berlin|munich|muenchen|hamburg|frankfurt|cologne|köln|\.de\b)/i.test(haystack)) return 'de'
  if (/\b(france|paris|lyon|marseille|toulouse|lille|\.fr\b)/i.test(haystack)) return 'fr'
  if (/\b(netherlands|nederland|amsterdam|rotterdam|utrecht|eindhoven|\.nl\b)/i.test(haystack)) return 'nl'
  if (/\b(spain|españa|espana|madrid|barcelona|valencia|sevilla|\.es\b)/i.test(haystack)) return 'es'
  return 'en'
}

export async function runPrepare(
  scoredJobs: ScoredJob[],
  ctx: PipelineCtx,
  options: { allowResumeTailoring?: boolean } = {},
): Promise<StageResult<PrepareOutput>> {
  const t0 = Date.now()
  const { agentCfg, resumeContent, aiConfig, roleConfigs, emit, userId, defaultResume } = ctx
  const THROTTLE_MS = agentCfg.throttleMs ?? 200
  // Use writer role's configured model
  const writerCfg = roleConfigs.writer
  const effectiveAiConfig: AiConfig = roleAiConfig('writer', writerCfg, aiConfig)
  const writerSystemPrompt = writerCfg?.systemPrompt ?? undefined
  const [tailorPersona, coverLetterPersona] = await Promise.all([
    buildPersona(userId, 'tailor').catch(() => ''),
    buildPersona(userId, 'cover_letter').catch(() => ''),
  ])

  // Prepare only jobs that meet the candidate's threshold, plus a narrow
  // borderline band that the Reviewer will explicitly ask about. This keeps
  // expensive generation from turning into indiscriminate mass application.
  const scoreFloor = preparationFloor(agentCfg.minMatchScore)
  const aboveThreshold = scoredJobs.filter(sj => sj.score >= scoreFloor)
  const screenedOut = scoredJobs.filter(sj => sj.score < scoreFloor)
  const allowResumeTailoring = options.allowResumeTailoring ?? true
  const packages: ApplicationPackage[] = []
  const pendingLetters: Array<{ jobId: string; coverLetter: string }> = []

  await Promise.all(screenedOut.map(sj =>
    db.applicationTask.updateMany({
      where: { userId, jobId: sj.job.id, status: 'analyzing' },
      data: {
        status: 'skipped',
        checkpoint: 'below_match_threshold',
        error: `Match score ${sj.score}% is below the preparation threshold of ${scoreFloor}%.`,
        completedAt: new Date(),
      },
    }),
  ))

  await forEachConcurrent(aboveThreshold, 2, async sj => {
    await db.applicationTask?.updateMany({
      where: { userId, jobId: sj.job.id, status: { in: ["analyzing", "discovered"] } },
      data: { status: "generating_materials", checkpoint: "tailoring_and_cover_letter" },
    })
    let coverLetter: string | undefined
    let coverLetterId: string | undefined
    let tailoredResumeId: string | undefined
    let tailoredResumeName: string | undefined
    const [tailorEvidence, coverEvidence] = await Promise.all([
      personaEvidenceContext(userId, 'tailor', `${sj.job.role} ${sj.job.description ?? ''}`).catch(() => ''),
      personaEvidenceContext(userId, 'cover_letter', `${sj.job.role} ${sj.job.description ?? ''}`).catch(() => ''),
    ])

    if (allowResumeTailoring) {
      try {
        const tailored = await generateTailoredResume(sj, resumeContent, effectiveAiConfig, writerSystemPrompt, tailorPersona, tailorEvidence)
        const saved = await db.resume.create({ data: {
          userId, name: `Tailored for ${sj.job.company} - ${sj.job.role}`,
          content: tailored as Prisma.InputJsonValue, templateId: defaultResume.templateId,
          templateOptions: defaultResume.templateOptions as Prisma.InputJsonValue | undefined,
          isDefault: false, directionId: defaultResume.directionId, kind: 'adapted',
          parentResumeId: defaultResume.id, targetJobId: sj.job.id, origin: 'ai-adapted',
          basicsDetached: defaultResume.basicsDetached,
        } })
        tailoredResumeId = saved.id
        tailoredResumeName = saved.name
        emit('agent_observation', { role: 'writer', observation: `✓ 已基于默认简历生成 ${sj.job.company} 的定制简历，保留职位连接和模板；等待 Reviewer 审核及你的最终确认。` })
      } catch (err) {
        emit('agent_observation', { role: 'writer', observation: `✗ ${sj.job.company} 简历优化失败：${err instanceof Error ? err.message : 'Unknown error'}` })
      }
    }

    if (agentCfg.autoCoverLetter) {
      try {
        coverLetter = await generateCoverLetter(sj, agentCfg, resumeContent, effectiveAiConfig, writerSystemPrompt, coverLetterPersona, coverEvidence)
        const saved = await saveAgentCoverLetter({
          userId,
          jobId: sj.job.id,
          resumeId: tailoredResumeId ?? defaultResume.id,
          content: coverLetter,
          tone: agentCfg.coverTone,
        })
        coverLetterId = saved.id
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
      ...(coverLetterId ? { coverLetterId } : {}),
      ...(tailoredResumeId ? { tailoredResumeId, tailoredResumeName } : {}),
      tailoredKeywords: sj.missingKeywords.length ? sj.missingKeywords : undefined,
    })
  })

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

async function saveAgentCoverLetter(input: {
  userId: string
  jobId: string
  resumeId: string
  content: string
  tone: string
}) {
  const existing = await db.coverLetter.findFirst({
    where: { userId: input.userId, jobId: input.jobId, resumeId: input.resumeId, origin: 'agent' },
    select: { id: true },
  })
  if (existing) {
    return db.coverLetter.update({
      where: { id: existing.id },
      data: { content: input.content, tone: input.tone, isFinal: false },
      select: { id: true },
    })
  }
  return db.coverLetter.create({
    data: {
      userId: input.userId,
      jobId: input.jobId,
      resumeId: input.resumeId,
      content: input.content,
      tone: input.tone,
      origin: 'agent',
      isFinal: false,
    },
    select: { id: true },
  })
}

async function generateTailoredResume(sj: ScoredJob, resume: unknown, aiConfig: AiConfig, systemPrompt?: string, persona = '', evidence = '') {
  const prompt = `Tailor this resume for the target job. Preserve truthful facts; only improve positioning and add JD keywords supported by the source resume or confirmed Persona. Persona is a hard fact boundary: do not add unsupported employers, education, dates, metrics, tools, achievements, or biography. Return ONLY the complete resume JSON object, with the same structure.\n\nRESUME JSON:\n${JSON.stringify(resume)}\n\nCONFIRMED PERSONA:\n${persona.slice(0, 9000)}\n\n${evidence}\n\nTARGET: ${sj.job.role} at ${sj.job.company}\nJOB DESCRIPTION:\n${sj.job.description?.slice(0, 1800) ?? ''}\nMATCHED: ${sj.matchedKeywords.join(', ')}\nMISSING: ${sj.missingKeywords.join(', ')}`
  const messages = systemPrompt
    ? [{ role: 'system' as const, content: systemPrompt }, { role: 'user' as const, content: prompt }]
    : [{ role: 'user' as const, content: prompt }]
  const result = await modelChat(messages, aiConfig, 2200)
  const raw = stripFences(result.text)
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}')
  if (start < 0 || end < 0) throw new Error('AI returned no resume JSON')
  return JSON.parse(raw.slice(start, end + 1))
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
  persona = '',
  evidence = '',
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
  const languageCode = inferCoverLetterLanguage(sj)
  const languageName = COVER_LETTER_LANGUAGE_NAMES[languageCode]
  const languageGuide = COVER_LETTER_FORMALITY_GUIDES[languageCode]

  const prompt = `Write a cover letter for a job applicant.

APPLICANT: ${name}${latestRole ? `, ${latestRole.role} at ${latestRole.company}` : ''}
MATCHED SKILLS: ${sj.matchedKeywords.join(', ')}
MISSING/ADD THESE: ${sj.missingKeywords.join(', ')}

TARGET: ${sj.job.role} at ${sj.job.company}${sj.job.location ? ` (${sj.job.location})` : ''}
${sj.job.description ? `JD EXCERPT:\n${sj.job.description.slice(0, 1000)}` : ''}

Tone: ${toneGuide}
Language: Write this cover letter in ${languageName}. ${languageGuide}
Structure: ${greeting} | hook | why this role | 2-3 achievements | CTA | Sincerely, ${name}
Rules: 220-280 words, no filler like "I am writing to express", quantify only claims supported by the confirmed Persona below. Never invent experience or qualifications.
CONFIRMED PERSONA:\n${persona.slice(0, 7000)}
${evidence}
Return ONLY the cover letter text.`

  const messages = systemPrompt
    ? [{ role: 'system' as const, content: `${systemPrompt}\nWrite in ${languageName}. ${languageGuide}` }, { role: 'user' as const, content: prompt }]
    : [{ role: 'user' as const, content: prompt }]

  const result = await modelChat(messages, aiConfig, 800)
  return stripFences(result.text).trim()
}
