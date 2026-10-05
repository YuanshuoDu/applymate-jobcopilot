import { db } from '@/lib/db'
import { agentConfigPatchFrom, applyAgentConfigPatch, prismaAgentConfigPatch } from './orchestrator-config'
import { findOrCreateOrchestratorQuestion } from './orchestrator-question'
import type { AgentConfigFull, AgentQuestionOption } from './types'

export type QuestionOption = AgentQuestionOption
export type OrchestratorEventEmitter = (event: string, data: unknown) => void

export interface OrchestratorInteractionContext {
  userId: string
  sessionId?: string
  turnId?: string
  questionProjectionMode?: 'legacy' | 'canonical'
  executionAttempt?: { id: string; attemptCount: number }
  signal?: AbortSignal
  agentCfg: AgentConfigFull
}

/** Signals a durable pause to the program control plane; never an LLM decision. */
export class AgentPauseError extends Error {
  constructor(readonly questionId: string, readonly stage: string) {
    super(`Agent is waiting for a user answer at ${stage}`)
    this.name = 'AgentPauseError'
  }
}

/** Owns durable question IO and user-selected config updates for one run. */
export class OrchestratorInteraction {
  private resumeQuestionId?: string

  constructor(
    private readonly ctx: OrchestratorInteractionContext,
    private readonly runId: string,
    private readonly emit: OrchestratorEventEmitter,
    private readonly history: string[],
    resumeQuestionId?: string,
  ) {
    this.resumeQuestionId = resumeQuestionId
  }

  async ask(stage: string, question: string, options: QuestionOption[]): Promise<string> {
    const expectedQuestionId = this.resumeQuestionId
    this.resumeQuestionId = undefined
    const existing = await findOrCreateOrchestratorQuestion(db, {
      userId: this.ctx.userId,
      runId: this.runId,
      sessionId: this.ctx.sessionId,
      turnId: this.ctx.turnId,
      executionAttempt: this.ctx.executionAttempt,
      signal: this.ctx.signal,
      questionProjectionMode: this.ctx.questionProjectionMode ?? 'canonical',
      ...(expectedQuestionId ? { expectedQuestionId } : {}),
      stage,
      question,
      options,
    })
    if (existing?.answer) {
      this.emit('orchestrator_answer_received', {
        id: existing.id, stage, answer: existing.answer,
        label: options.find(option => option.value === existing.answer)?.label ?? existing.answer,
      })
      this.history.push(`[Ask/${stage}] USER: ${existing.answer}`)
      return existing.answer
    }

    this.emit('orchestrator_question', { id: existing.id, stage, question, options })
    throw new AgentPauseError(existing.id, stage)
  }

  async applyOptionAction(answer: string, options: QuestionOption[]): Promise<void> {
    const option = options.find(candidate => candidate.value === answer)
    if (!option?.action) return
    const { field, value } = option.action
    if (field === '_navigate') return
    const patch = agentConfigPatchFrom({ [field]: value })
    const data = prismaAgentConfigPatch(patch)
    if (Object.keys(data).length === 0 && Object.keys(patch).length === 0) return
    try {
      await db.agentConfig.updateMany({ where: { userId: this.ctx.userId }, data })
      applyAgentConfigPatch(this.ctx.agentCfg, patch)
    } catch { /* non-fatal */ }
  }
}
