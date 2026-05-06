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
import { NextRequest }                    from 'next/server'
import Anthropic                          from '@anthropic-ai/sdk'
import { db }                             from '@/lib/db'
import { requireAuth, isErrorResponse }   from '@/lib/api-helpers'
import type { ResumeContent }             from '@/lib/types'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── System prompt (orchestrator persona) ──────────────────────────────────────

function buildSystemPrompt(ctx: {
  jobCount:     number
  savedCount:   number
  pendingCount: number
  config:       Record<string, unknown> | null
  resumeName:   string | null
  recentJobs:   Array<{ company: string; role: string; score: number | null; status: string }>
  lastRunAt:    string | null
}): string {
  return `You are the ApplyMate AI Pipeline Orchestrator — a smart career assistant coordinating a team of 6 specialized AI agents to help users land their ideal job.

## Your Agent Team
- 🔍 **Scout** (侦察员): Filters and prioritizes saved jobs
- 🤖 **Analyst** (分析员): Scores resume-job fit with detailed reasoning
- ✍️ **Writer** (撰写员): Writes tailored cover letters
- 🔎 **Reviewer** (审核员): Makes apply/review/skip routing decisions
- 🚀 **Executor** (执行员): Handles application submissions
- ✅ **Auditor** (验收员): Verifies outcomes and generates insights

## Current Status
- Total jobs tracked: ${ctx.jobCount}
- Jobs ready to process (saved): ${ctx.savedCount}
- Jobs pending review: ${ctx.pendingCount}
- Active resume: ${ctx.resumeName ?? 'None (user needs to create one)'}
- Pipeline last run: ${ctx.lastRunAt ?? 'Never'}
- Min match score: ${ctx.config?.minMatchScore ?? 75}%
- Auto-apply: ${ctx.config?.autoApply ? 'ON' : 'OFF'}, Require review: ${ctx.config?.requireApproval ? 'ON' : 'OFF'}
- Daily limit: ${ctx.config?.dailyLimit ?? 10} applications/day

## Recent Jobs
${ctx.recentJobs.length === 0 ? 'No jobs tracked yet.' : ctx.recentJobs.map(j =>
  `- ${j.company} · ${j.role} | Score: ${j.score != null ? j.score + '%' : 'not scored'} | Status: ${j.status}`
).join('\n')}

## Your Responsibilities
1. **Answer questions** about the job search pipeline and status
2. **Give strategic advice** about improving match rates, application quality
3. **Explain agent decisions** when asked why a job was scored or routed a certain way
4. **Suggest next actions** proactively based on the current state
5. **Execute pipeline actions** by including action commands in your response

## Action Commands
When you want to execute an action, include it at the END of your response in this EXACT format on its own line:
ACTION:start_run
ACTION:update_config:minMatchScore:80
ACTION:update_config:autoApply:true
ACTION:navigate:jobs
ACTION:open_job:<jobId>

Rules:
- Include at most ONE action per response
- Only include an action if the user explicitly asked for it OR if it's obviously the right next step
- Always explain what you're doing before the ACTION line
- Use conversational, helpful Chinese OR English based on the user's language
- Be proactive: if there are saved jobs and the pipeline hasn't run today, suggest running it
- Be specific: use real job names from context, not generic examples`
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req)
  if (isErrorResponse(auth)) return auth

  const body = await req.json().catch(() => null)
  if (!body?.messages) return new Response('Missing messages', { status: 400 })

  // Load context
  const [agentCfg, jobs, resume, lastActivity] = await Promise.all([
    db.agentConfig.findUnique({ where: { userId: auth.userId } }),
    db.job.findMany({
      where: { userId: auth.userId },
      orderBy: { updatedAt: 'desc' },
      take: 15,
      select: { id: true, company: true, role: true, score: true, status: true, updatedAt: true },
    }),
    db.resume.findFirst({
      where: { userId: auth.userId, isDefault: true },
      select: { name: true },
    }) ?? db.resume.findFirst({
      where: { userId: auth.userId },
      orderBy: { createdAt: 'desc' },
      select: { name: true },
    }),
    db.activity.findFirst({
      where: { userId: auth.userId, type: 'agent_action' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
  ])

  const ctxData = {
    jobCount:     jobs.length,
    savedCount:   jobs.filter(j => j.status === 'saved').length,
    pendingCount: jobs.filter(j => j.status === 'review').length,
    config:       agentCfg as Record<string, unknown> | null,
    resumeName:   resume?.name ?? null,
    recentJobs:   jobs.slice(0, 8).map(j => ({
      company: j.company, role: j.role, score: j.score, status: j.status
    })),
    lastRunAt: lastActivity?.createdAt.toLocaleDateString('zh') ?? null,
  }

  const systemPrompt = buildSystemPrompt(ctxData)

  // Stream SSE response
  const encoder = new TextEncoder()
  const stream  = new ReadableStream({
    async start(controller) {
      function send(event: string, data: unknown) {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch { /* closed */ }
      }

      try {
        let fullText = ''

        // Call Anthropic with streaming
        const anthropicStream = await anthropic.messages.create({
          model:      'claude-sonnet-4-6',
          max_tokens: 1024,
          system:     systemPrompt,
          messages:   body.messages,
          stream:     true,
        })

        for await (const chunk of anthropicStream) {
          if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
            const delta = chunk.delta.text
            fullText += delta
            send('text', { delta })
          }
        }

        // Parse action from the response
        const actionMatch = fullText.match(/^ACTION:(.+)$/m)
        if (actionMatch) {
          const parts = actionMatch[1].split(':')
          const actionType = parts[0]

          if (actionType === 'start_run') {
            send('action', { type: 'start_run' })
          } else if (actionType === 'update_config' && parts.length >= 3) {
            const field = parts[1]
            let value: unknown = parts[2]
            // Parse value type
            if (value === 'true') value = true
            else if (value === 'false') value = false
            else if (!isNaN(Number(value))) value = Number(value)
            send('action', { type: 'update_config', field, value })
          } else if (actionType === 'navigate' && parts[1]) {
            send('action', { type: 'navigate', path: parts[1] })
          } else if (actionType === 'open_job' && parts[1]) {
            send('action', { type: 'open_job', jobId: parts[1] })
          }
        }

        send('done', {})
      } catch (err) {
        send('error', { message: (err as Error).message })
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
