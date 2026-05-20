/**
 * GET /api/agent/run
 *
 * Server-Sent Events stream — runs the 6-stage Agent Pipeline:
 *   Scout → Analyze → Prepare → Gate → Execute → Audit
 *
 * SSE event types:
 *   stage_start — { stage, label }                          new in v2
 *   stage_done  — { stage, ...metrics }                     new in v2
 *   start       — { total }
 *   job_start   — { jobId, company, role }
 *   job_done    — { jobId, company, role, score, autoApplied, … }
 *   job_skip    — { jobId, company, role, reason }
 *   job_error   — { jobId, company, role, error }
 *   info        — { message }
 *   done        — { processed, applied, pending, skipped, failed, durationMs }
 *   error       — { message }
 */
import { NextRequest }                              from 'next/server'
import { db }                                       from '@/lib/db'
import { prepareAiRoute, sseResponse }               from '@/lib/api-helpers'
import { runPipeline }                               from '@/lib/agent/pipeline'
import { resumeToText }                              from '@/lib/agent/types'
import { loadRoleConfigs, toRoleConfigMap }          from '@/lib/agent/role-config'
import type { ResumeContent }                        from '@/lib/types'
import type { PipelineCtx }                          from '@/lib/agent/pipeline'

export async function GET(req: NextRequest) {
  const prep = await prepareAiRoute(req, 'agent')
  if ('error' in prep) return prep.error

  return sseResponse(async emit => {
    const agentCfg = await db.agentConfig.findUnique({ where: { userId: prep.userId } })
    if (!agentCfg) return emit('error', { message: 'Agent not configured. Save settings first.' })

    const resume =
      await db.resume.findFirst({ where: { userId: prep.userId, isDefault: true } }) ??
      await db.resume.findFirst({ where: { userId: prep.userId }, orderBy: { createdAt: 'desc' } })

    if (!resume) return emit('error', { message: 'No resume found. Create a resume first.' })

    const roleRows    = await loadRoleConfigs(prep.userId)
    const roleConfigs = toRoleConfigMap(roleRows)

    const ctx: PipelineCtx = {
      userId:    prep.userId,
      agentCfg:  { ...(agentCfg as PipelineCtx['agentCfg']), throttleMs: (agentCfg as any).throttleMs ?? 300 },
      roleConfigs,
      resumeText: resumeToText(resume.content as unknown as ResumeContent).slice(0, 2500),
      resumeContent: resume.content as unknown as ResumeContent,
      aiConfig: prep.cfg,
      emit,
    }

    await runPipeline(ctx)
  })
}
