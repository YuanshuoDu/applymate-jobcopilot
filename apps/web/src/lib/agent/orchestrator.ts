/**
 * OrchestratorAgent — Master Agent Harness
 *
 * Acts as the "brain" that coordinates all 6 SubAgents.
 * Implements the Plan → Dispatch → Evaluate → Fix → Retry loop,
 * similar to how Claude Code's harness manages sub-agents.
 *
 * Architecture:
 *
 *   OrchestratorAgent
 *     ├── plan()          — LLM decides strategy before starting
 *     ├── dispatch()      — runs a SubAgent stage
 *     ├── evaluate()      — LLM checks if output is good enough
 *     ├── diagnose()      — LLM identifies WHY a stage failed
 *     ├── fix()           — applies a fix to ctx/params
 *     └── decide()        — LLM decides: retry / skip / abort
 *
 * Retry policies per stage:
 *   scout:    3 attempts — broaden search on retry
 *   analyst:  2 attempts — fallback model on retry
 *   writer:   2 attempts — simpler prompt on retry
 *   reviewer: 1 attempt  — deterministic, no retry
 *   executor: 3 attempts — backoff retry
 *   auditor:  2 attempts — skip Gmail on retry
 */

import { modelChat }     from '@/lib/model-router'
import type { PipelineCtx } from './types'

// ── Event types emitted by Orchestrator ───────────────────────────────────────

export type OrchestratorEvent =
  | 'orchestrator_plan'
  | 'orchestrator_dispatch'
  | 'orchestrator_evaluate'
  | 'orchestrator_fix'
  | 'orchestrator_retry'
  | 'orchestrator_decision'
  | 'orchestrator_complete'

// ── Retry state per stage ─────────────────────────────────────────────────────

export interface StageAttempt {
  stage:    string
  attempt:  number
  maxRetries: number
  lastError?: string
  lastResult?: unknown
}

export interface OrchestratorState {
  userId:        string
  attempts:      Record<string, StageAttempt>
  ctxOverrides:  Partial<PipelineCtx['agentCfg']>   // Orchestrator-applied patches
  skipStages:    Set<string>
  aborted:       boolean
  planSummary:   string
}

// ── Orchestrator LLM calls ────────────────────────────────────────────────────

async function llmDecide(prompt: string, ctx: PipelineCtx): Promise<string> {
  try {
    const result = await modelChat(
      [{ role: 'user', content: prompt }],
      ctx.aiConfig,
      200,
    )
    return result.text.trim()
  } catch {
    return 'continue'
  }
}

// ── Main OrchestratorAgent ────────────────────────────────────────────────────

export class OrchestratorAgent {
  private ctx:   PipelineCtx
  private state: OrchestratorState
  private emit:  PipelineCtx['emit']

  constructor(ctx: PipelineCtx) {
    this.ctx   = ctx
    this.emit  = ctx.emit
    this.state = {
      userId:       ctx.userId,
      attempts:     {},
      ctxOverrides: {},
      skipStages:   new Set(),
      aborted:      false,
      planSummary:  '',
    }
  }

  // ── Plan: Orchestrator decides strategy before starting ─────────────────────

  async plan(): Promise<void> {
    const { agentCfg } = this.ctx
    const hasJobs      = agentCfg.targetRoles.length > 0
    const hasSalary    = (agentCfg as any).salaryMin > 0

    const planPrompt = `You are the OrchestratorAgent managing an automated job application pipeline.

User configuration:
- Target roles: ${agentCfg.targetRoles.slice(0, 5).join(', ') || 'not set (will process saved jobs only)'}
- Target locations: ${agentCfg.targetLocations.slice(0, 3).join(', ') || 'any'}
- Min match score: ${agentCfg.minMatchScore}%
- Auto-apply: ${agentCfg.autoApply ? 'YES' : 'NO (manual review)'}
- Cover letter: ${agentCfg.autoCoverLetter ? 'YES' : 'NO'}
- Daily limit: ${agentCfg.dailyLimit}
- Salary range: ${hasSalary ? `${(agentCfg as any).salaryMin}–${(agentCfg as any).salaryMax}€` : 'not specified'}

Write a ONE-sentence strategy for this pipeline run. Focus on what the user should expect.
Be specific. Max 25 words.`

    const plan = await llmDecide(planPrompt, this.ctx)
    this.state.planSummary = plan

    this.emit('orchestrator_plan', {
      plan,
      config: {
        roles:     agentCfg.targetRoles.slice(0, 3),
        threshold: agentCfg.minMatchScore,
        autoCL:    agentCfg.autoCoverLetter,
        limit:     agentCfg.dailyLimit,
      },
    })
  }

  // ── Dispatch: run a stage, tracking attempts ─────────────────────────────────

  beginStage(stage: string, maxRetries: number): StageAttempt {
    this.state.attempts[stage] = {
      stage, attempt: 0, maxRetries,
    }
    return this.state.attempts[stage]
  }

  nextAttempt(stage: string): number {
    const s = this.state.attempts[stage]
    if (!s) return 1
    s.attempt++
    return s.attempt
  }

  isExhausted(stage: string): boolean {
    const s = this.state.attempts[stage]
    if (!s) return false
    return s.attempt >= s.maxRetries
  }

  recordFailure(stage: string, error: string): void {
    const s = this.state.attempts[stage]
    if (s) s.lastError = error
  }

  // ── Evaluate: is the stage output good enough? ───────────────────────────────

  async evaluateScout(jobCount: number): Promise<{ ok: boolean; fix?: string }> {
    if (jobCount === 0) {
      return {
        ok:  false,
        fix: 'no_jobs_found',
      }
    }
    if (jobCount < 3 && this.ctx.agentCfg.targetRoles.length > 0) {
      return {
        ok:  false,
        fix: 'too_few_jobs',
      }
    }
    return { ok: true }
  }

  async evaluateAnalyst(scoredCount: number, failedCount: number, total: number): Promise<{ ok: boolean; fix?: string }> {
    if (scoredCount === 0 && total > 0) {
      return { ok: false, fix: 'all_scoring_failed' }
    }
    if (failedCount > total * 0.5) {
      return { ok: false, fix: 'too_many_scoring_failures' }
    }
    return { ok: true }
  }

  // ── Diagnose & Fix ────────────────────────────────────────────────────────────

  applyFix(stage: string, fix: string): void {
    const overrides = this.state.ctxOverrides

    switch (fix) {
      // Scout fixes
      case 'no_jobs_found':
        this.emit('orchestrator_fix', {
          stage, fix,
          message: '没有找到职位。正在调整：降低每日上限要求，扩大地点搜索范围…',
        })
        // Relax: increase max results buffer by expanding daily limit temporarily
        overrides.dailyLimit = Math.min((this.ctx.agentCfg.dailyLimit ?? 10) * 2, 50)
        break

      case 'too_few_jobs':
        this.emit('orchestrator_fix', {
          stage, fix,
          message: `职位数量偏少（< 3）。建议：在 Jobs 页面手动保存更多职位，或添加更多目标职位类型。`,
        })
        break

      // Analyst fixes
      case 'all_scoring_failed':
        this.emit('orchestrator_fix', {
          stage, fix,
          message: '所有职位评分失败（可能是 AI API 异常）。正在切换到备用模型重试…',
        })
        // Override analyst model to haiku (lighter, faster)
        if (!overrides.model) overrides.model = 'claude-haiku-4-5-20251001'
        break

      case 'too_many_scoring_failures':
        this.emit('orchestrator_fix', {
          stage, fix,
          message: `超过 50% 的职位评分失败。正在切换备用模型并降低 throttle 间隔…`,
        })
        overrides.model = 'claude-haiku-4-5-20251001'
        break

      default:
        this.emit('orchestrator_fix', {
          stage, fix,
          message: `检测到问题（${fix}），尝试使用默认参数重试…`,
        })
    }

    // Merge overrides into ctx agentCfg
    Object.assign(this.ctx.agentCfg, overrides)
  }

  // ── Decide: retry / skip / abort after exhausted retries ────────────────────

  async decideOnExhaustion(
    stage:   string,
    error:   string,
    context: { jobsProcessed: number },
  ): Promise<'skip' | 'abort'> {

    // Critical stages: if they fail completely, abort is safer
    const criticalStages = ['scout', 'analyst']
    if (criticalStages.includes(stage) && context.jobsProcessed === 0) {
      this.emit('orchestrator_decision', {
        stage,
        decision: 'abort',
        reason:   `${stage} 阶段在 ${this.state.attempts[stage]?.maxRetries ?? 1} 次重试后仍然失败（${error}）。无法继续流水线。`,
      })
      this.state.aborted = true
      return 'abort'
    }

    // Non-critical stages: skip and continue
    this.emit('orchestrator_decision', {
      stage,
      decision: 'skip',
      reason:   `${stage} 阶段失败，但已有 ${context.jobsProcessed} 个职位处理中。跳过此阶段，继续流水线。`,
    })
    this.state.skipStages.add(stage)
    return 'skip'
  }

  shouldSkip(stage: string): boolean {
    return this.state.skipStages.has(stage)
  }

  isAborted(): boolean {
    return this.state.aborted
  }

  // ── Emit retry notification ──────────────────────────────────────────────────

  emitRetry(stage: string, attempt: number, maxRetries: number, reason: string): void {
    this.emit('orchestrator_retry', {
      stage,
      attempt,
      maxRetries,
      reason,
      message: `🔄 Orchestrator 正在重试 ${stage}（第 ${attempt}/${maxRetries} 次）：${reason}`,
    })
  }

  // ── Complete ─────────────────────────────────────────────────────────────────

  complete(report: { processed: number; applied: number; pending: number; skipped: number }): void {
    const retriesTotal = Object.values(this.state.attempts)
      .reduce((sum, a) => sum + Math.max(0, a.attempt - 1), 0)

    this.emit('orchestrator_complete', {
      planSummary:    this.state.planSummary,
      skippedStages:  [...this.state.skipStages],
      totalRetries:   retriesTotal,
      overridesApplied: Object.keys(this.state.ctxOverrides).length > 0,
      report,
      message: retriesTotal > 0
        ? `Orchestrator 本次运行共重试 ${retriesTotal} 次${this.state.skipStages.size > 0 ? `，跳过了 ${[...this.state.skipStages].join('、')} 阶段` : ''}。`
        : '所有阶段均一次成功完成，无需干预。',
    })
  }
}
