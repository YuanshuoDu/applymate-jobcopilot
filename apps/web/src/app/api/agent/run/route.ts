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
import { Prisma }                                   from '@prisma/client'
import { db }                                       from '@/lib/db'
import { prepareAiRoute, sseResponse }               from '@/lib/api-helpers'
import { runPipeline }                               from '@/lib/agent/pipeline'
import { resumeToText }                              from '@/lib/agent/types'
import { loadRoleConfigs, toRoleConfigMap }          from '@/lib/agent/role-config'
import type { ResumeContent }                        from '@/lib/types'
import type { PipelineCtx }                          from '@/lib/agent/pipeline'
import type { RunReport }                            from '@/lib/agent/types'

type AgentHistoryEvent = {
  event: string
  at: string
  data: unknown
}

function pickNumber(data: unknown, keys: string[]): number | null {
  if (!data || typeof data !== 'object') return null
  const row = data as Record<string, unknown>
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function historyStatus(report: RunReport | null, failed = false) {
  if (failed || !report) return 'failed'
  if (report.failed > 0) return 'partial'
  return 'completed'
}

function summarizeHistory(events: AgentHistoryEvent[], report: RunReport | null, startedAt: number) {
  const stageEvents = events.filter(e => e.event === 'stage_done')
  const scoutRole = [...events].reverse().find(e => {
    const data = e.data as Record<string, unknown> | null
    return e.event === 'role_done' && data?.role === 'scout'
  })
  const scoutStage = [...stageEvents].reverse().find(e => {
    const data = e.data as Record<string, unknown> | null
    return data?.stage === 'scout'
  })

  return {
    durationMs: report?.durationMs ?? Math.max(0, Date.now() - startedAt),
    stagesCompleted: stageEvents.length,
    jobsFound: pickNumber(scoutRole?.data, ['discovered', 'count', 'jobsFound'])
      ?? pickNumber(scoutStage?.data, ['count', 'discovered', 'jobsFound'])
      ?? 0,
  }
}

async function saveAgentHistoryRun(
  userId: string,
  events: AgentHistoryEvent[],
  startedAt: number,
  report: RunReport | null,
  failed = false,
) {
  const summary = summarizeHistory(events, report, startedAt)
  try {
    await db.agentRun.create({
      data: {
        userId,
        status: historyStatus(report, failed),
        durationMs: summary.durationMs,
        stagesCompleted: summary.stagesCompleted,
        jobsFound: summary.jobsFound,
        ...(report ? { report: report as unknown as Prisma.InputJsonValue } : {}),
        log: events as unknown as Prisma.InputJsonValue,
      },
    })
  } catch (error) {
    console.warn('Failed to save agent run history', error)
  }
}

export async function GET(req: NextRequest) {
  const prep = await prepareAiRoute(req, 'agent')
  if ('error' in prep) return prep.error

  // autonomous=true → never pause, make all decisions automatically
  const autonomous = req.nextUrl.searchParams.get('autonomous') === 'true'

  return sseResponse(async emit => {
    const startedAt = Date.now()
    const events: AgentHistoryEvent[] = []
    const emitHistory = (event: string, data: unknown) => {
      events.push({ event, data, at: new Date().toISOString() })
      emit(event, data)
    }

    const agentCfg = await db.agentConfig.findUnique({ where: { userId: prep.userId } })
    if (!agentCfg) {
      emitHistory('error', { message: 'Agent not configured. Save settings first.' })
      await saveAgentHistoryRun(prep.userId, events, startedAt, null, true)
      return
    }

    const resume =
      await db.resume.findFirst({ where: { userId: prep.userId, isDefault: true } }) ??
      await db.resume.findFirst({ where: { userId: prep.userId }, orderBy: { createdAt: 'desc' } })

    if (!resume) {
      emitHistory('error', { message: 'No resume found. Create a resume first.' })
      await saveAgentHistoryRun(prep.userId, events, startedAt, null, true)
      return
    }

    const roleRows    = await loadRoleConfigs(prep.userId)
    const roleConfigs = toRoleConfigMap(roleRows)

    const ctx: PipelineCtx = {
      userId:    prep.userId,
      agentCfg:  { ...(agentCfg as PipelineCtx['agentCfg']), throttleMs: (agentCfg as any).throttleMs ?? 300 },
      roleConfigs,
      resumeText: resumeToText(resume.content as unknown as ResumeContent).slice(0, 2500),
      resumeContent: resume.content as unknown as ResumeContent,
      aiConfig:  prep.cfg,
      autonomous,
      emit: emitHistory,
    }

    try {
      const report = await runPipeline(ctx)
      await saveAgentHistoryRun(prep.userId, events, startedAt, report)
    } catch (error) {
      emitHistory('error', {
        message: error instanceof Error ? error.message : 'Agent run failed',
      })
      await saveAgentHistoryRun(prep.userId, events, startedAt, null, true)
    }
  })
}
