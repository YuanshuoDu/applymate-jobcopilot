/**
 * OrchestratorAgent — True LLM-Driven Harness
 *
 * Inspired by Claude Code's harness architecture:
 *   • Every decision is made by an LLM (not hardcoded if/else)
 *   • Questions truly pause the pipeline via DB queue + polling
 *   • Autonomous mode: all decisions made automatically, never asks user
 *   • Fix strategies are suggested by the LLM based on failure context
 *
 * Decision loop per stage:
 *   1. Stage runs and returns output
 *   2. Orchestrator LLM analyzes output in context
 *   3. LLM decides: proceed | retry(fix) | ask_user | abort
 *   4. If ask_user:
 *      - autonomous=true → auto-select best option, continue
 *      - autonomous=false → write to DB, emit SSE, POLL for answer (true pause)
 *   5. Apply decision and continue or retry
 */

import { modelChat }        from '@/lib/model-router'
import { db }               from '@/lib/db'
import type { PipelineCtx } from './types'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OrchestratorDecision {
  decision:     'proceed' | 'retry' | 'ask_user' | 'abort'
  thinking:     string
  // ask_user fields
  ask_question?: string
  ask_options?:  Array<{ label: string; value: string; action?: { field: string; value: unknown } }>
  // retry fields
  retry_fix?:    Record<string, unknown>
}

export interface QuestionOption {
  label:   string
  value:   string
  action?: { field: string; value: unknown }
}

// ── OrchestratorAgent ─────────────────────────────────────────────────────────

export class OrchestratorAgent {
  private ctx:        PipelineCtx
  private emit:       PipelineCtx['emit']
  private runId:      string
  private autonomous: boolean
  private history:    string[] = []

  constructor(ctx: PipelineCtx, autonomous = false) {
    this.ctx        = ctx
    this.emit       = ctx.emit
    this.runId      = `run_${Date.now()}`
    this.autonomous = autonomous
  }

  // ── Retry tracking (lightweight, used by pipeline retry loops) ──────────────

  private attempts: Record<string, { attempt: number; maxRetries: number; lastError?: string }> = {}

  beginStage(stage: string, maxRetries: number) {
    this.attempts[stage] = { attempt: 0, maxRetries }
  }

  nextAttempt(stage: string): number {
    const s = this.attempts[stage]
    if (!s) return 1
    s.attempt++
    return s.attempt
  }

  isExhausted(stage: string): boolean {
    const s = this.attempts[stage]
    return s ? s.attempt >= s.maxRetries : false
  }

  recordFailure(stage: string, error: string) {
    const s = this.attempts[stage]
    if (s) s.lastError = error
  }

  emitRetry(stage: string, attempt: number, maxRetries: number, reason: string) {
    this.emit('orchestrator_retry', {
      stage, attempt, maxRetries, reason,
      message: `🔄 Orchestrator 重试 ${stage}（${attempt}/${maxRetries}）：${reason}`,
    })
    this.history.push(`[Retry/${stage}] attempt ${attempt}: ${reason}`)
  }

  async decideOnExhaustion(stage: string, error: string, context: { jobsProcessed: number }): Promise<'skip' | 'abort'> {
    const critical = ['scout', 'analyst']
    if (critical.includes(stage) && context.jobsProcessed === 0) {
      this.abort(stage, error)
      return 'abort'
    }
    this.emit('orchestrator_decision', {
      stage, decision: 'skip',
      reason: `${stage} 重试耗尽，跳过继续（已处理 ${context.jobsProcessed} 个职位）`,
    })
    return 'skip'
  }

  // ── Plan: LLM generates opening strategy ──────────────────────────────────

  async plan(): Promise<string> {
    const { agentCfg } = this.ctx
    const prompt = `You are an OrchestratorAgent coordinating a job application pipeline.

User setup:
- Target roles: ${agentCfg.targetRoles.slice(0, 5).join(', ') || '(not set — will process saved jobs)'}
- Locations: ${agentCfg.targetLocations.slice(0, 3).join(', ') || 'any'}
- Min match score: ${agentCfg.minMatchScore}%
- Auto-apply: ${agentCfg.autoApply ? 'ON' : 'OFF (manual queue)'}
- Cover letter: ${agentCfg.autoCoverLetter ? 'ON' : 'OFF'}
- Daily limit: ${agentCfg.dailyLimit} jobs
- Mode: ${this.autonomous ? 'AUTONOMOUS (no user prompts)' : 'INTERACTIVE (will ask when needed)'}

Write ONE sentence describing your strategy for this run. Be specific and actionable. Max 30 words.`

    try {
      const r = await modelChat([{ role: 'user', content: prompt }], this.ctx.aiConfig, 100)
      const plan = r.text.trim()
      this.history.push(`[Plan] ${plan}`)

      this.emit('orchestrator_thinking', {
        thinking: plan,
        autonomous: this.autonomous,
      })
      return plan
    } catch {
      const fallback = `处理 ${agentCfg.targetRoles.length > 0 ? agentCfg.targetRoles.slice(0,2).join('/') : '已保存'} 职位，阈值 ${agentCfg.minMatchScore}%`
      this.emit('orchestrator_thinking', { thinking: fallback, autonomous: this.autonomous })
      return fallback
    }
  }

  // ── Evaluate: LLM decides what to do after a stage ────────────────────────

  async evaluate(
    stage:   string,
    summary: string,
    metrics: Record<string, unknown>,
  ): Promise<OrchestratorDecision> {
    const { agentCfg } = this.ctx
    const historyStr   = this.history.slice(-4).join('\n')

    const prompt = `You are an OrchestratorAgent. A pipeline stage just completed.

Stage: ${stage}
Summary: ${summary}
Metrics: ${JSON.stringify(metrics)}
User config: minScore=${agentCfg.minMatchScore}%, dailyLimit=${agentCfg.dailyLimit}, autoApply=${agentCfg.autoApply}
Recent history:
${historyStr}
Autonomous mode: ${this.autonomous}

Decide what to do next. Rules:
- Only ask_user if something truly needs human judgment (e.g., all jobs skipped, major config conflict)
- In autonomous mode: NEVER ask_user, always proceed or retry with sensible defaults
- retry only if there's a concrete fix to apply (e.g., model switch, param change)
- abort only if pipeline literally cannot continue (0 jobs + 0 from any source)
- proceed in all other cases

Respond ONLY in valid JSON (no markdown):
{
  "decision": "proceed" | "retry" | "ask_user" | "abort",
  "thinking": "<one sentence why>",
  "ask_question": "<question for user, only if ask_user>",
  "ask_options": [{"label":"...", "value":"..."}],
  "retry_fix": {"field": "value"}
}`

    try {
      const r      = await modelChat([{ role: 'user', content: prompt }], this.ctx.aiConfig, 400)
      const clean  = r.text.replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(clean) as OrchestratorDecision

      this.history.push(`[${stage}] ${summary} → ${parsed.decision}: ${parsed.thinking}`)
      this.emit('orchestrator_thinking', { stage, thinking: parsed.thinking, decision: parsed.decision })
      return parsed
    } catch {
      // Fallback: always proceed
      const fallback: OrchestratorDecision = { decision: 'proceed', thinking: '继续执行下一阶段' }
      this.history.push(`[${stage}] ${summary} → proceed (fallback)`)
      return fallback
    }
  }

  // ── Ask: true pause, waits for user answer ────────────────────────────────

  async ask(
    stage:    string,
    question: string,
    options:  QuestionOption[],
  ): Promise<string> {
    if (this.autonomous) {
      // Never block in autonomous mode — pick first option
      const chosen = options[0]?.value ?? 'continue'
      this.emit('orchestrator_thinking', {
        stage,
        thinking: `[自主模式] 自动选择：「${options[0]?.label ?? chosen}」`,
      })
      this.history.push(`[Ask/${stage}] AUTO: ${chosen}`)
      return chosen
    }

    // Write to DB for frontend to pick up
    const q = await db.agentRunQuestion.create({
      data: {
        userId:    this.ctx.userId,
        runId:     this.runId,
        stage,
        question,
        options:   options as object[],
        autonomous: false,
      },
    })

    // Emit the question — frontend will show it prominently and enable the input
    this.emit('orchestrator_question', {
      id:       q.id,
      stage,
      question,
      options,
    })

    // True pause: poll DB until answered or 5 min timeout
    const deadline = Date.now() + 5 * 60_000
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000)) // poll every 2s
      const updated = await db.agentRunQuestion.findUnique({
        where:  { id: q.id },
        select: { answer: true },
      })
      if (updated?.answer) {
        this.emit('orchestrator_answer_received', {
          id:       q.id,
          stage,
          answer:   updated.answer,
          label:    options.find(o => o.value === updated.answer)?.label ?? updated.answer,
        })
        this.history.push(`[Ask/${stage}] USER: ${updated.answer}`)
        return updated.answer
      }
    }

    // Timeout — pick first option as default
    const fallback = options[0]?.value ?? 'continue'
    this.emit('orchestrator_thinking', {
      stage, thinking: `等待超时，自动选择默认选项：「${options[0]?.label ?? fallback}」`,
    })
    return fallback
  }

  // ── Apply fix from retry decision ──────────────────────────────────────────

  applyFix(fix: string | Record<string, unknown>, stage: string): void {
    if (typeof fix === 'string') {
      const named: Record<string, Record<string, unknown>> = {
        'no_jobs_found':              { dailyLimit: Math.min((this.ctx.agentCfg.dailyLimit ?? 10) * 2, 50) },
        'all_scoring_failed':         { model: 'claude-haiku-4-5-20251001' },
        'too_many_scoring_failures':  { model: 'claude-haiku-4-5-20251001' },
      }
      const resolved = named[fix]
      if (resolved) { this.applyFix(resolved, stage) }
      else {
        this.emit('orchestrator_fix', { stage, fix, message: `🔧 Orchestrator 检测到问题 [${stage}]：${fix}，尝试重试…` })
        this.history.push(`[Fix/${stage}] ${fix}`)
      }
      return
    }
    const changes: string[] = []
    for (const [key, value] of Object.entries(fix)) {
      if (value !== undefined) {
        (this.ctx.agentCfg as any)[key] = value
        changes.push(`${key}=${JSON.stringify(value)}`)
      }
    }
    if (changes.length > 0) {
      this.emit('orchestrator_fix', {
        stage, fix: changes.join(', '),
        message: `🔧 Orchestrator 修复 [${stage}]：${changes.join('，')}`,
      })
      this.history.push(`[Fix/${stage}] ${changes.join(', ')}`)
    }
  }

  // ── Handle option action (config update) ──────────────────────────────────

  async applyOptionAction(answer: string, options: QuestionOption[]): Promise<void> {
    const opt = options.find(o => o.value === answer)
    if (!opt?.action) return
    const { field, value } = opt.action
    if (field === '_navigate') return // handled by frontend
    try {
      await db.agentConfig.updateMany({
        where: { userId: this.ctx.userId },
        data:  { [field]: value } as any,
      });
      (this.ctx.agentCfg as any)[field] = value
    } catch { /* non-fatal */ }
  }

  // ── Abort ─────────────────────────────────────────────────────────────────

  abort(stage: string, reason: string): void {
    this.emit('orchestrator_decision', {
      stage, decision: 'abort',
      reason: `🛑 Orchestrator 中止 [${stage}]：${reason}`,
    })
    this.history.push(`[ABORT/${stage}] ${reason}`)
  }

  // ── Complete ──────────────────────────────────────────────────────────────

  complete(report: { processed: number; applied: number; pending: number; skipped: number }): void {
    const retries = this.history.filter(h => h.includes('[Fix/')).length
    this.emit('orchestrator_complete', {
      thinking:   this.history.slice(-3).join(' → '),
      totalRetries: retries,
      autonomous:   this.autonomous,
      report,
      message: retries > 0
        ? `✅ Orchestrator 完成（共修复 ${retries} 次）`
        : `✅ Orchestrator 完成，所有阶段顺利通过`,
    })
  }

  get runIdentifier() { return this.runId }
}
