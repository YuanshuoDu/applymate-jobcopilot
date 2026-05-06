/**
 * Stage 5 — Execute
 * Role: 执行员
 * Applies to all approved packages:
 *   - Updates job.status = 'applied', sets appliedAt
 *   - Creates Activity record (type='applied')
 *   - If useTailoredCV=true, logs Activity (type='resume_tailored')
 */
import { db } from '@/lib/db'
import type {
  PipelineCtx, ApplicationPackage, ExecuteOutput, StageResult, AcceptResult,
} from '../types'
import { stageOk, stageFail } from '../types'

export async function runExecute(
  approved: ApplicationPackage[],
  ctx: PipelineCtx,
): Promise<StageResult<ExecuteOutput>> {
  const t0 = Date.now()
  const { userId, agentCfg, emit } = ctx

  const applied: string[] = []
  const failed:  string[] = []

  for (const pkg of approved) {
    try {
      await db.job.update({
        where: { id: pkg.job.id },
        data:  { status: 'applied', appliedAt: new Date() },
      })

      await db.activity.create({
        data: {
          userId,
          jobId: pkg.job.id,
          type:  'applied',
          text:  `Agent auto-applied to ${pkg.job.company} · ${pkg.job.role} (score: ${pkg.score}%)`,
          color: '#185FA5',
        },
      })

      if (agentCfg.useTailoredCV && pkg.tailoredKeywords?.length) {
        await db.activity.create({
          data: {
            userId,
            jobId: pkg.job.id,
            type:  'resume_tailored',
            text:  `Resume tailored for ${pkg.job.company} · ${pkg.job.role} — added: ${pkg.tailoredKeywords.slice(0, 3).join(', ')}`,
            color: '#0E7490',
          },
        })
      }

      applied.push(pkg.job.id)

      // Re-emit job_done with autoApplied=true for UI update
      emit('job_done', {
        jobId:       pkg.job.id,
        company:     pkg.job.company,
        role:        pkg.job.role,
        score:       pkg.score,
        autoApplied: true,
        recommendation:  pkg.recommendation,
        matchedKeywords: pkg.matchedKeywords,
        missingKeywords: pkg.missingKeywords,
        coverLetter:     pkg.coverLetter,
      })
    } catch (err) {
      console.error('[execute] apply error:', err)
      failed.push(pkg.job.id)
    }
  }

  if (approved.length > 0 && applied.length === 0) {
    return stageFail('execute', 'All execute operations failed')
  }

  return stageOk('execute', { applied, failed }, applied.length, Date.now() - t0)
}

export function acceptExecute(result: StageResult<ExecuteOutput>): AcceptResult {
  if (!result.ok || !result.data) {
    return { ok: false, reason: result.error ?? 'Execute returned no data' }
  }
  if (result.data.failed.length > 0) {
    return {
      ok: false,
      reason: `${result.data.failed.length} job(s) failed to apply: ${result.data.failed.join(', ')}`,
    }
  }
  return { ok: true }
}
