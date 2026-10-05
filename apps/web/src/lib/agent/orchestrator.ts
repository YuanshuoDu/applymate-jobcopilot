/** Thin coordinator for the legacy agent pipeline's orchestration behavior. */

import { modelChat } from '@/lib/model-router'
import type { PipelineCtx } from './types'
import { agentConfigPatchFrom, applyAgentConfigPatch } from './orchestrator-config'
import {
  evaluateOrchestratorDecision,
  extractFinalSentence,
  isValidRetryFix,
  OrchestratorDecisionError,
} from './orchestrator-decision'
import type { OrchestratorDecision } from './orchestrator-decision'
import { OrchestratorInteraction } from './orchestrator-interaction'
import type { QuestionOption } from './orchestrator-interaction'

export { OrchestratorDecisionError }
export type { OrchestratorDecision }
export { AgentPauseError } from './orchestrator-interaction'
export type { QuestionOption }

export class OrchestratorAgent {
  private ctx: PipelineCtx
  private emit: PipelineCtx['emit']
  private runId: string
  private autonomous: boolean
  private history: string[] = []
  private interaction: OrchestratorInteraction
  private attempts: Record<string, { attempt: number; maxRetries: number; lastError?: string }> = {}

  constructor(ctx: PipelineCtx, autonomous = false) {
    this.ctx = ctx
    this.emit = ctx.emit
    this.runId = ctx.sessionId ?? `run_${Date.now()}`
    this.autonomous = autonomous
    this.interaction = new OrchestratorInteraction(ctx, this.runId, this.emit, this.history, ctx.resumeQuestionId)
  }

  beginStage(stage: string, maxRetries: number) {
    this.attempts[stage] = { attempt: 0, maxRetries }
  }

  nextAttempt(stage: string): number {
    const state = this.attempts[stage]
    if (!state) return 1
    state.attempt++
    return state.attempt
  }

  isExhausted(stage: string): boolean {
    const state = this.attempts[stage]
    return state ? state.attempt >= state.maxRetries : false
  }

  recordFailure(stage: string, error: string) {
    const state = this.attempts[stage]
    if (state) state.lastError = error
  }

  emitRetry(stage: string, attempt: number, maxRetries: number, reason: string) {
    this.emit('orchestrator_retry', {
      stage, attempt, maxRetries, reason,
      message: `🔄 Orchestrator Try again ${stage}(${attempt}/${maxRetries}): ${reason}`,
    })
    this.history.push(`[Retry/${stage}] attempt ${attempt}: ${reason}`)
  }

  async decideOnExhaustion(stage: string, error: string, context: { jobsProcessed: number }): Promise<'skip' | 'abort'> {
    if (['scout', 'analyst'].includes(stage) && context.jobsProcessed === 0) {
      this.abort(stage, error)
      return 'abort'
    }
    this.emit('orchestrator_decision', {
      stage, decision: 'skip',
      reason: `${stage} Exhausted retries, Skip to continue(Processed ${context.jobsProcessed} positions)`,
    })
    return 'skip'
  }

  async plan(): Promise<string> {
    const { agentCfg } = this.ctx
    const prompt = `You are an OrchestratorAgent.

RESPOND WITH EXACTLY ONE SENTENCE. No preamble, no explanation, no thinking. Just the sentence.

Context:
- Target roles: ${agentCfg.targetRoles.slice(0, 5).join(', ') || 'saved jobs only'}
- Locations: ${agentCfg.targetLocations.slice(0, 3).join(', ') || 'any'}
- Min match score: ${agentCfg.minMatchScore}%
- Auto-apply: ${agentCfg.autoApply ? 'ON' : 'OFF'}
- Daily limit: ${agentCfg.dailyLimit}
- Mode: ${this.autonomous ? 'AUTONOMOUS' : 'INTERACTIVE'}

Write the strategy sentence now:`

    try {
      const response = await modelChat([{ role: 'user', content: prompt }], this.ctx.aiConfig, 80)
      const plan = extractFinalSentence(response.text.trim())
      this.history.push(`[Plan] ${plan}`)
      this.emit('orchestrator_thinking', { thinking: plan, autonomous: this.autonomous })
      return plan
    } catch {
      const fallback = `deal with ${agentCfg.targetRoles.length > 0 ? agentCfg.targetRoles.slice(0, 2).join('/') : 'saved'} Position, threshold ${agentCfg.minMatchScore}%`
      this.emit('orchestrator_thinking', { thinking: fallback, autonomous: this.autonomous })
      return fallback
    }
  }

  async evaluate(stage: string, summary: string, metrics: Record<string, unknown>): Promise<OrchestratorDecision> {
    const decision = await evaluateOrchestratorDecision(
      stage, summary, metrics, this.ctx, this.autonomous, this.history,
    )
    this.history.push(`[${stage}] ${summary} → ${decision.decision}: ${decision.thinking}`)
    this.emit('orchestrator_thinking', { stage, thinking: decision.thinking, decision: decision.decision })
    return decision
  }

  ask(stage: string, question: string, options: QuestionOption[]): Promise<string> {
    return this.interaction.ask(stage, question, options)
  }

  applyFix(fix: string | Record<string, unknown>, stage: string): void {
    if (typeof fix === 'string') {
      const named: Record<string, Record<string, unknown>> = {
        no_jobs_found: { dailyLimit: Math.min((this.ctx.agentCfg.dailyLimit ?? 10) * 2, 50) },
        all_scoring_failed: { model: 'claude-sonnet-5' },
        too_many_scoring_failures: { model: 'claude-sonnet-5' },
      }
      const resolved = named[fix]
      if (resolved) {
        const changes = applyAgentConfigPatch(this.ctx.agentCfg, agentConfigPatchFrom(resolved))
        if (changes.length > 0) {
          this.emit('orchestrator_fix', {
            stage, fix: changes.join(', '),
            message: `🔧 Orchestrator repair [${stage}]: ${changes.join(', ')}`,
          })
          this.history.push(`[Fix/${stage}] ${changes.join(', ')}`)
        }
      } else {
        this.emit('orchestrator_fix', { stage, fix, message: `🔧 Orchestrator Problem detected [${stage}]: ${fix}, Try again…` })
        this.history.push(`[Fix/${stage}] ${fix}`)
      }
      return
    }

    if (!isValidRetryFix(fix, stage, this.ctx.agentCfg.throttleMs)) {
      throw new OrchestratorDecisionError()
    }
    const changes = applyAgentConfigPatch(
      this.ctx.agentCfg,
      agentConfigPatchFrom({ throttleMs: fix.throttleMs }),
    )
    if (changes.length > 0) {
      this.emit('orchestrator_fix', {
        stage, fix: changes.join(', '),
        message: `🔧 Orchestrator repair [${stage}]: ${changes.join(', ')}`,
      })
      this.history.push(`[Fix/${stage}] ${changes.join(', ')}`)
    }
  }

  applyOptionAction(answer: string, options: QuestionOption[]): Promise<void> {
    return this.interaction.applyOptionAction(answer, options)
  }

  abort(stage: string, reason: string): void {
    this.emit('orchestrator_decision', {
      stage, decision: 'abort',
      reason: `🛑 Orchestrator abort [${stage}]: ${reason}`,
    })
    this.history.push(`[ABORT/${stage}] ${reason}`)
  }

  complete(report: { processed: number; applied: number; queued: number; pending: number; skipped: number }): void {
    const retries = this.history.filter(item => item.includes('[Fix/')).length
    this.emit('orchestrator_complete', {
      thinking: this.history.slice(-3).join(' → '),
      totalRetries: retries,
      autonomous: this.autonomous,
      report,
      message: retries > 0
        ? `✅ Orchestrator Finish(Total repairs ${retries} Second-rate)`
        : `✅ Orchestrator Finish, Passed all stages successfully`,
    })
  }

  get runIdentifier() { return this.runId }
}
