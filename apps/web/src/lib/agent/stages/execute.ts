/**
 * Stage 5 — Execute
 * Role: 执行员
 *
 * DESIGN: The executor does NOT auto-apply anywhere.
 * Instead it prepares a "ready to apply" queue and presents each job
 * to the user via SSE events. The user clicks "Apply" in the dashboard,
 * which opens the job URL and confirms application via /api/jobs/[id]/apply.
 *
 * This ensures:
 * - User has full control over every submission
 * - Cover letter can be reviewed before applying
 * - No accidental double-applications
 */
import { db } from '@/lib/db'
import type {
  PipelineCtx, ApplicationPackage, ExecuteOutput, StageResult, AcceptResult,
} from '../types'
import { stageOk } from '../types'

export async function runExecute(
  approved: ApplicationPackage[],
  ctx: PipelineCtx,
): Promise<StageResult<ExecuteOutput>> {
  const t0 = Date.now()
  const { userId, emit } = ctx

  const queued:  string[] = []
  const failed:  string[] = []

  if (approved.length === 0) {
    emit('agent_observation', {
      role:        'executor',
      observation: '无已批准职位需要处理。所有职位已进入待审核队列，等待用户在 Jobs 页面确认。',
    })
    return stageOk('execute', { applied: [], failed: [] }, 0, Date.now() - t0)
  }

  for (const pkg of approved) {
    emit('agent_action', {
      role:   'executor',
      action: `准备申请包：${pkg.job.company} · ${pkg.job.role} (${pkg.score}%)`,
    })

    try {
      // Preparation is internal workflow state, not evidence that an employer
      // reviewed or received an application.
      await db.job.update({
        where: { id: pkg.job.id },
        data:  {
          status:       'saved',
          workflowState: 'ready_to_apply',
          analysisNote: `[申请就绪] 匹配分 ${pkg.score}%。${pkg.recommendation ?? ''}`,
        },
      })

      // Write activity log showing it's ready
      await db.activity.create({
        data: {
          userId,
          jobId: pkg.job.id,
          type:  'agent_action',
          text:  `Agent 已准备好申请 ${pkg.job.company} · ${pkg.job.role}（${pkg.score}%），等待你手动确认投递`,
          color: '#185FA5',
        },
      })

      queued.push(pkg.job.id)

      emit('agent_observation', {
        role:        'executor',
        observation: `✓ ${pkg.job.company} · ${pkg.job.role} — 申请材料已就绪，等待你点击「立即申请」`,
      })

      // Emit apply_ready event for frontend to show action card
      emit('apply_ready', {
        jobId:       pkg.job.id,
        company:     pkg.job.company,
        role:        pkg.job.role,
        score:       pkg.score,
        url:         pkg.job.url,
        location:    pkg.job.location,
        coverLetter: pkg.coverLetter,
        matchedKeywords: pkg.matchedKeywords,
      })

    } catch (err) {
      console.error('[execute] queue error:', err)
      failed.push(pkg.job.id)
      emit('agent_observation', {
        role:        'executor',
        observation: `✗ ${pkg.job.company} · ${pkg.job.role}：处理失败`,
      })
    }
  }

  return stageOk('execute', { applied: queued, failed }, queued.length, Date.now() - t0)
}

export function acceptExecute(result: StageResult<ExecuteOutput>): AcceptResult {
  if (!result.ok || !result.data) {
    return { ok: false, reason: result.error ?? 'Execute returned no data' }
  }
  return { ok: true }
}
