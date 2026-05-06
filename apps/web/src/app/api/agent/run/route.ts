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
import { NextRequest }          from 'next/server'
import { db }                   from '@/lib/db'
import { requireAuth, isErrorResponse } from '@/lib/api-helpers'
import { resolveConfig }        from '@/lib/model-router'
import { runPipeline }          from '@/lib/agent/pipeline'
import { resumeToText }         from '@/lib/agent/types'
import { loadRoleConfigs, toRoleConfigMap } from '@/lib/agent/role-config'
import type { ResumeContent }   from '@/lib/types'
import type { PipelineCtx }     from '@/lib/agent/pipeline'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      function emit(event: string, data: unknown) {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          )
        } catch { /* stream closed */ }
      }

      try {
        // ── Load AgentConfig ────────────────────────────────────────────────
        const agentCfg = await db.agentConfig.findUnique({ where: { userId: auth.userId } })
        if (!agentCfg) {
          emit('error', { message: 'Agent not configured. Save settings first.' })
          controller.close()
          return
        }

        // ── Load resume ─────────────────────────────────────────────────────
        const resume =
          await db.resume.findFirst({ where: { userId: auth.userId, isDefault: true } }) ??
          await db.resume.findFirst({ where: { userId: auth.userId }, orderBy: { createdAt: 'desc' } })

        if (!resume) {
          emit('error', { message: 'No resume found. Create a resume in the Resume tab first.' })
          controller.close()
          return
        }

        // ── Resolve AI config & role configs ───────────────────────────────
        const user      = await db.user.findUnique({ where: { id: auth.userId }, select: { preferences: true } })
        const prefs     = (user?.preferences ?? {}) as Record<string, unknown>
        const aiConfig  = resolveConfig((prefs.aiConfig ?? null) as Parameters<typeof resolveConfig>[0])

        const roleRows    = await loadRoleConfigs(auth.userId)
        const roleConfigs = toRoleConfigMap(roleRows)

        const resumeContent = resume.content as unknown as ResumeContent

        // ── Build pipeline context ──────────────────────────────────────────
        const ctx: PipelineCtx = {
          userId:        auth.userId,
          agentCfg:      agentCfg as PipelineCtx['agentCfg'],
          roleConfigs,
          resumeText:    resumeToText(resumeContent).slice(0, 2500),
          resumeContent,
          aiConfig,
          emit,
        }

        // ── Run the pipeline ────────────────────────────────────────────────
        await runPipeline(ctx)

      } catch (e) {
        console.error('[agent/run] fatal error:', e)
        emit('error', { message: 'Agent run failed unexpectedly' })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache, no-transform',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
