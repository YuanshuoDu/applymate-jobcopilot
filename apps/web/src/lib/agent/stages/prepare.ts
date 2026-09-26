/**
 * Stage 3 — Prepare
 * Role: preparer
 * For each scored job above minMatchScore:
 *   - Generates cover letter (if autoCoverLetter=true)
 *   - Packages job + score + materials into ApplicationPackage
 */
import { Prisma } from '@prisma/client'
import { buildPersona } from '@/lib/persona'
import { personaEvidenceContext, retrievePersonaEvidence } from '@/lib/persona-evidence'
import { assertSupportedClaims, type EvidenceInput } from '../artifacts/provenance'
import { buildDraftArtifactSummary } from '../artifacts/repository'
import { hashArtifactContent } from '../artifacts/hash'
import { artifactItemData } from '../artifacts/item'
import type { ArtifactConstraintSet, ArtifactSummary } from '../artifacts/types'
import type { AiConfig } from '@/lib/model-router'
import type {
  PipelineCtx, ScoredJob, ApplicationPackage, PrepareOutput,
  AgentConfigFull, StageResult, AcceptResult,
} from '../types'
import { stageOk } from '../types'
import { roleAiConfig } from '../role-config'
import { forEachConcurrent } from '../concurrency'
import { assertPrepareExecutionCurrent, claimPrepareTask, isPrepareOwnershipLost, markBelowThresholdSkipped, saveAgentCoverLetter, withPrepareOwnership } from './prepare-ownership'
import { generateCoverLetter, generateTailoredResume } from './prepare-generation'

export function preparationFloor(minMatchScore: number): number {
  return Math.max(0, minMatchScore - 5)
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
  const pendingLetters: Array<{ scoredJob: ScoredJob; jobId: string; coverLetter: string }> = []
  const ownershipLost = new Set<string>()

  await Promise.all(screenedOut.map(sj => markBelowThresholdSkipped(sj, ctx, scoreFloor)))

  await forEachConcurrent(aboveThreshold, 2, async sj => {
    if (!await claimPrepareTask(sj, ctx)) {
      ownershipLost.add(sj.job.id)
      return
    }
    let coverLetter: string | undefined
    let coverLetterId: string | undefined
    let tailoredResumeId: string | undefined
    let tailoredResumeName: string | undefined
    const [tailorEvidence, coverEvidence] = await Promise.all([
      personaEvidenceContext(userId, 'tailor', `${sj.job.role} ${sj.job.description ?? ''}`).catch(() => ''),
      personaEvidenceContext(userId, 'cover_letter', `${sj.job.role} ${sj.job.description ?? ''}`).catch(() => ''),
    ])
    const [evidenceRows, coverEvidenceRows] = await Promise.all([
      retrievePersonaEvidence(userId, 'tailor', `${sj.job.role} ${sj.job.description ?? ''}`, 12).catch(() => []),
      retrievePersonaEvidence(userId, 'cover_letter', `${sj.job.role} ${sj.job.description ?? ''}`, 12).catch(() => []),
    ])
    const evidenceInputs: EvidenceInput[] = [
      { sourceType: 'resume', sourceRef: `resume:${defaultResume.id}`, content: JSON.stringify(resumeContent) },
      ...evidenceRows.map(row => ({ sourceType: row.sourceType === 'persona_fact' ? 'persona_fact' as const : 'persona_evidence' as const, sourceRef: row.sourceRef, content: row.content })),
    ]
    const constraints = tailoringConstraints(sj, agentCfg)
    const baseHash = hashArtifactContent(resumeContent)
    let tailoredResumeArtifact: ArtifactSummary | undefined
    let coverLetterArtifact: ArtifactSummary | undefined

    if (allowResumeTailoring) {
      try {
        const tailored = await generateTailoredResume(sj, resumeContent, effectiveAiConfig, writerSystemPrompt, tailorPersona, tailorEvidence, () => assertPrepareExecutionCurrent(ctx))
        const provenance = assertSupportedClaims({ content: tailored, evidence: evidenceInputs, allowedContext: [sj.job.company, sj.job.role, tailorEvidence] })
        const saved = await withPrepareOwnership(sj, ctx, tx => tx.resume.create({ data: {
          userId, name: `Tailored for ${sj.job.company} - ${sj.job.role}`,
          content: tailored as Prisma.InputJsonValue, templateId: defaultResume.templateId,
          templateOptions: defaultResume.templateOptions as Prisma.InputJsonValue | undefined,
          isDefault: false, directionId: defaultResume.directionId, kind: 'adapted',
          parentResumeId: defaultResume.id, targetJobId: sj.job.id, origin: 'ai-adapted',
          basicsDetached: defaultResume.basicsDetached,
        } }))
        tailoredResumeId = saved.id
        tailoredResumeName = saved.name
        tailoredResumeArtifact = buildDraftArtifactSummary({ id: saved.id, kind: 'resume', content: tailored, baseArtifactId: defaultResume.id, baseHash, constraints, provenance })
        emit('artifact_created', { role: 'writer', artifact: artifactItemData(tailoredResumeArtifact) })
        emit('agent_observation', { role: 'writer', observation: `✓ Already generated based on default resume ${sj.job.company} Custom Resume, Preserve job links and templates; wait Reviewer Review and your final confirmation.` })
      } catch (err) {
        if (isPrepareOwnershipLost(err)) {
          ownershipLost.add(sj.job.id)
          return
        }
        emit('agent_observation', { role: 'writer', observation: `✗ ${sj.job.company} Resume optimization failed: ${err instanceof Error ? err.message : 'Unknown error'}` })
      }
    }

    if (ownershipLost.has(sj.job.id)) return

    if (agentCfg.autoCoverLetter) {
      try {
        coverLetter = await generateCoverLetter(sj, agentCfg, resumeContent, effectiveAiConfig, writerSystemPrompt, coverLetterPersona, coverEvidence, () => assertPrepareExecutionCurrent(ctx))
        const coverInputs: EvidenceInput[] = [
          { sourceType: 'resume', sourceRef: `resume:${defaultResume.id}`, content: JSON.stringify(resumeContent) },
          ...coverEvidenceRows.map(row => ({ sourceType: row.sourceType === 'persona_fact' ? 'persona_fact' as const : 'persona_evidence' as const, sourceRef: row.sourceRef, content: row.content })),
        ]
        const coverProvenance = assertSupportedClaims({ content: coverLetter, evidence: coverInputs, allowedContext: [sj.job.company, sj.job.role, coverEvidence] })
        const saved = await withPrepareOwnership(sj, ctx, tx => saveAgentCoverLetter(tx, {
          userId,
          jobId: sj.job.id,
          resumeId: tailoredResumeId ?? defaultResume.id,
          content: coverLetter!,
          tone: agentCfg.coverTone,
        }))
        coverLetterId = saved.id
        coverLetterArtifact = buildDraftArtifactSummary({
          id: saved.id, kind: 'cover_letter', content: coverLetter,
          baseArtifactId: tailoredResumeArtifact?.id ?? defaultResume.id,
          baseHash: tailoredResumeArtifact?.hash ?? baseHash,
          constraints, provenance: coverProvenance,
        })
        emit('artifact_created', { role: 'writer', artifact: artifactItemData(coverLetterArtifact) })
        pendingLetters.push({ scoredJob: sj, jobId: sj.job.id, coverLetter })
        await new Promise(r => setTimeout(r, THROTTLE_MS))
      } catch (err) {
        if (isPrepareOwnershipLost(err)) {
          ownershipLost.add(sj.job.id)
          return
        }
        console.error('[prepare] cover letter error:', err)
        emit('info', { message: `Cover letter skipped for ${sj.job.company}: ${(err as Error).message}` })
      }
    }

    if (ownershipLost.has(sj.job.id)) return

    try {
      await withPrepareOwnership(sj, ctx, async () => undefined)
    } catch (err) {
      if (isPrepareOwnershipLost(err)) {
        ownershipLost.add(sj.job.id)
        return
      }
      throw err
    }

    packages.push({
      ...sj,
      ...(coverLetter ? { coverLetter } : {}),
      ...(coverLetterId ? { coverLetterId } : {}),
      ...(tailoredResumeId ? { tailoredResumeId, tailoredResumeName } : {}),
      ...(tailoredResumeArtifact ? { tailoredResumeArtifact } : {}),
      ...(coverLetterArtifact ? { coverLetterArtifact } : {}),
      tailoredKeywords: sj.missingKeywords.length ? sj.missingKeywords : undefined,
    })
  })

  // Batch persist cover letters
  if (pendingLetters.length > 0) {
    await Promise.all(
      pendingLetters.map(async pl => {
        try {
          await withPrepareOwnership(pl.scoredJob, ctx, tx =>
            tx.job.update({ where: { id: pl.jobId }, data: { coverLetter: pl.coverLetter } }),
          )
        } catch (err) {
          if (isPrepareOwnershipLost(err)) ownershipLost.add(pl.jobId)
          // Job.coverLetter is a secondary convenience field; keep its
          // existing best-effort behavior for ordinary persistence failures.
        }
      }),
    )
  }

  const ownedPackages = packages.filter(pkg => !ownershipLost.has(pkg.job.id))
  return stageOk('prepare', { packages: ownedPackages }, ownedPackages.length, Date.now() - t0)
}

export function tailoringConstraints(sj: ScoredJob, cfg: AgentConfigFull): ArtifactConstraintSet {
  const sorted = (values: readonly string[]) => [...values].map(value => value.trim()).filter(Boolean).sort()
  return {
    jobId: sj.job.id,
    role: sj.job.role,
    company: sj.job.company,
    targetRoles: sorted(cfg.targetRoles),
    targetLocations: sorted(cfg.targetLocations),
    excludeCompanies: sorted(cfg.excludeCompanies),
    priorityCompanies: sorted(cfg.priorityCompanies),
    minMatchScore: cfg.minMatchScore,
    coverTone: cfg.coverTone,
  }
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
