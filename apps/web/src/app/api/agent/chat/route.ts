/**
 * POST /api/agent/chat
 *
 * Streaming chat with the Pipeline Orchestrator.
 * Returns SSE:
 *   event: text   data: { delta: "..." }   — streaming text token
 *   event: action data: { type, ...params } — action to execute on client
 *   event: done   data: {}
 *
 * Actions the orchestrator can trigger:
 *   start_run                     — launch the pipeline
 *   update_config  field  value   — change a pipeline setting
 *   navigate       path           — navigate to a page
 *   open_job       jobId          — open a specific job
 */
import { NextRequest }                                from 'next/server'
import { db }                                          from '@/lib/db'
import { prepareAiRoute, sseResponse, isErrorResponse } from '@/lib/api-helpers'
import { modelChatStream }                              from '@/lib/model-router'

const SYSTEM_PROMPT = (ctx: {
  jobCount: number; savedCount: number; pendingCount: number
  config: Record<string, unknown> | null; resumeName: string | null
  recentJobs: Array<{ company: string; role: string; score: number | null; status: string }>
  lastRunAt: string | null
}): string => `You are the ApplyMate AI Pipeline Orchestrator — a smart career assistant coordinating a team of 6 specialized AI agents.

## Current Status
- Total jobs: ${ctx.jobCount} | Saved: ${ctx.savedCount} | Pending review: ${ctx.pendingCount}
- Active resume: ${ctx.resumeName ?? 'None'}
- Pipeline last run: ${ctx.lastRunAt ?? 'Never'}
- Min match score: ${ctx.config?.minMatchScore ?? 75}% | Auto-apply: ${ctx.config?.autoApply ? 'ON' : 'OFF'}
- Daily limit: ${ctx.config?.dailyLimit ?? 10} applications/day

## Recent Jobs
${ctx.recentJobs.length === 0 ? 'No jobs yet.' : ctx.recentJobs.map(j => `- ${j.company} · ${j.role} | Score: ${j.score != null ? j.score + '%' : '-'} | ${j.status}`).join('\n')}

Action commands (at END of response, on its own line): ACTION:start_run | ACTION:update_config:key:value | ACTION:navigate:path | ACTION:open_job:<jobId>
Rules: max 1 action per response, only when asked or obviously needed, be helpful in Chinese or English, use real data from context.`

export async function POST(req: NextRequest) {
  const prep = await prepareAiRoute(req, 'agent')
  if ('error' in prep) return prep.error

  const body = await req.json().catch(() => null)
  if (!body?.messages) return new Response('Missing messages', { status: 400 })

  const [agentCfg, jobs, resume, lastActivity] = await Promise.all([
    db.agentConfig.findUnique({ where: { userId: prep.userId } }),
    db.job.findMany({ where: { userId: prep.userId }, orderBy: { updatedAt: 'desc' }, take: 15, select: { id: true, company: true, role: true, score: true, status: true } }),
    db.resume.findFirst({ where: { userId: prep.userId, isDefault: true }, select: { name: true } })
      ?? db.resume.findFirst({ where: { userId: prep.userId }, orderBy: { createdAt: 'desc' }, select: { name: true } }),
    db.activity.findFirst({ where: { userId: prep.userId, type: 'agent_action' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  ])

  const ctxData = {
    jobCount: jobs.length, savedCount: jobs.filter(j => j.status === 'saved').length,
    pendingCount: jobs.filter(j => j.status === 'review').length,
    config: agentCfg as Record<string, unknown> | null, resumeName: resume?.name ?? null,
    recentJobs: jobs.slice(0, 8).map(j => ({ company: j.company, role: j.role, score: j.score, status: j.status })),
    lastRunAt: lastActivity?.createdAt.toLocaleDateString('zh') ?? null,
  }

  const messages = [{ role: 'system' as const, content: SYSTEM_PROMPT(ctxData) }, ...body.messages]

  return sseResponse(async send => {
    let fullText = ''
    for await (const delta of modelChatStream(messages, prep.cfg, 4096)) {
      fullText += delta
      send('text', { delta })
    }

    const actionMatch = fullText.match(/^ACTION:(.+)$/m)
    if (actionMatch) {
      const parts = actionMatch[1].split(':')
      const type = parts[0]
      if (type === 'start_run') send('action', { type: 'start_run' })
      else if (type === 'update_config' && parts.length >= 3) {
        let value: unknown = parts[2]
        if (value === 'true') value = true; else if (value === 'false') value = false; else if (!isNaN(Number(value))) value = Number(value)
        send('action', { type: 'update_config', field: parts[1], value })
      }
      else if (type === 'navigate' && parts[1]) send('action', { type: 'navigate', path: parts[1] })
      else if (type === 'open_job' && parts[1]) send('action', { type: 'open_job', jobId: parts[1] })
    }
    send('done', {})
  })
}
