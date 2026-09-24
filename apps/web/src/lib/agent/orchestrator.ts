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
 *   4. If ask_user: write to DB, emit SSE, then wait for the candidate. A
 *      timeout is never treated as consent for a mutating choice.
 *   5. Apply decision and continue or retry
 */

import { modelChat }        from '@/lib/model-router'
import { db }               from '@/lib/db'
import type { AgentQuestionOption, PipelineCtx } from './types'
import { agentConfigPatchFrom, applyAgentConfigPatch, prismaAgentConfigPatch } from './orchestrator-config'

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

export type QuestionOption = AgentQuestionOption

/** Signals a durable pause to the program control plane; never an LLM decision. */
export class AgentPauseError extends Error {
  constructor(readonly questionId: string, readonly stage: string) {
    super(`Agent is waiting for a user answer at ${stage}`)
    this.name = "AgentPauseError"
  }
}

/** Safe, stable failure surfaced when the model cannot supply a valid decision. */
export class OrchestratorDecisionError extends Error {
  readonly code = 'orchestrator_decision_invalid'

  constructor() {
    super('The agent stopped because the orchestrator could not produce a valid decision. Please retry the run.')
    this.name = 'OrchestratorDecisionError'
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Strip LLM chain-of-thought preamble, extract only the actionable output.
 * Models like MiniMax often output "Let me think... <answer>" style.
 */
function extractFinalSentence(raw: string): string {
  // Remove common thinking preambles line by line
  const lines = raw.split('\n').filter(l => l.trim())
  const thinkPrefixes = [
    'let me', 'i need to', 'the user wants', 'i should', 'first,', 'okay,',
    'sure,', 'to answer', 'thinking:', 'i\'ll', 'i will', 'as an',
  ]
  // Find first line that is NOT a thinking line
  for (const line of lines) {
    const lower = line.trim().toLowerCase()
    const isThinking = thinkPrefixes.some(p => lower.startsWith(p))
    if (!isThinking && line.trim().length > 10) {
      // Return this line, cleaned of markdown
      return line.trim().replace(/^[*_`#>\-•·]+\s*/, '').replace(/[*_`]+$/, '').slice(0, 120)
    }
  }
  // Fallback: last sentence
  const sentences = raw.replace(/\n/g, ' ').split(/[.!?]+/).filter(s => s.trim().length > 10)
  return (sentences.at(-1) ?? raw).trim().slice(0, 120)
}

/**
 * Parse JSON from LLM response robustly.
 * Handles: ```json ... ```, thinking preamble before JSON, trailing text.
 */
const MAX_DECISION_RESPONSE_CHARS = 16_000
const MAX_THINKING_CHARS = 1_000
const MAX_QUESTION_CHARS = 500
const MAX_OPTION_LABEL_CHARS = 120
const MAX_OPTION_VALUE_CHARS = 120
const MAX_ACTION_FIELD_CHARS = 100
const MAX_RETRY_FIX_FIELDS = 20
const MAX_NESTED_VALUE_CHARS = 2_000

function parseDecision(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw.length > MAX_DECISION_RESPONSE_CHARS) return null
  // Remove markdown fences
  let text = raw.replace(/```json|```/g, '').trim()
  // Find first { ... }
  const start = text.indexOf('{')
  const end   = text.lastIndexOf('}')
  if (start === -1 || end === -1) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}

function isBoundedJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 8) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') return value.length <= MAX_NESTED_VALUE_CHARS
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 20 && value.every(item => isBoundedJsonValue(item, depth + 1))
  if (!isRecord(value)) return false

  const entries = Object.entries(value)
  return entries.length <= 20 && entries.every(([key, item]) =>
    key.length > 0 && key.length <= MAX_ACTION_FIELD_CHARS && isBoundedJsonValue(item, depth + 1),
  )
}

function validateDecision(value: unknown, autonomous: boolean): OrchestratorDecision | null {
  if (!isRecord(value)) return null
  if (!['proceed', 'retry', 'ask_user', 'abort'].includes(value.decision as string)) return null
  if (!boundedString(value.thinking, MAX_THINKING_CHARS)) return null
  const thinking = extractFinalSentence(value.thinking.trim())
  if (!thinking) return null

  switch (value.decision) {
    case 'proceed':
    case 'abort':
      return { decision: value.decision, thinking }
    case 'retry': {
      if (!isRecord(value.retry_fix)) return null
      const entries = Object.entries(value.retry_fix)
      if (entries.length === 0 || entries.length > MAX_RETRY_FIX_FIELDS) return null
      if (!entries.every(([key, item]) =>
        key.length > 0 && key.length <= MAX_ACTION_FIELD_CHARS && isBoundedJsonValue(item),
      )) return null
      let serialized: string
      try { serialized = JSON.stringify(value.retry_fix) }
      catch { return null }
      if (typeof serialized !== 'string' || serialized.length > MAX_NESTED_VALUE_CHARS) return null
      return { decision: 'retry', thinking, retry_fix: value.retry_fix }
    }
    case 'ask_user': {
      if (autonomous) return null
      if (!boundedString(value.ask_question, MAX_QUESTION_CHARS)) return null
      let askOptions: OrchestratorDecision['ask_options']
      if (hasOwn(value, 'ask_options')) {
        if (!Array.isArray(value.ask_options) || value.ask_options.length === 0 || value.ask_options.length > 10) return null
        const parsedOptions: NonNullable<OrchestratorDecision['ask_options']> = []
        const seenValues = new Set<string>()
        for (const option of value.ask_options) {
          if (!isRecord(option) || !boundedString(option.label, MAX_OPTION_LABEL_CHARS) || !boundedString(option.value, MAX_OPTION_VALUE_CHARS)) return null
          const optionValue = option.value.trim()
          if (seenValues.has(optionValue)) return null
          seenValues.add(optionValue)

          let action: NonNullable<OrchestratorDecision['ask_options']>[number]['action']
          if (hasOwn(option, 'action')) {
            if (!isRecord(option.action) || !boundedString(option.action.field, MAX_ACTION_FIELD_CHARS) || !hasOwn(option.action, 'value')) return null
            if (!isBoundedJsonValue(option.action.value)) return null
            let serialized: string
            try { serialized = JSON.stringify(option.action.value) }
            catch { return null }
            if (typeof serialized !== 'string' || serialized.length > MAX_NESTED_VALUE_CHARS) return null
            action = { field: option.action.field.trim(), value: option.action.value }
          }
          parsedOptions.push({ label: option.label.trim(), value: optionValue, ...(action ? { action } : {}) })
        }
        askOptions = parsedOptions
      }
      return { decision: 'ask_user', thinking, ask_question: value.ask_question.trim(), ...(askOptions ? { ask_options: askOptions } : {}) }
    }
    default:
      return null
  }
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
    // A session is the durable run identity. It lets a restarted worker find
    // the same unanswered question instead of creating another one.
    this.runId      = ctx.sessionId ?? `run_${Date.now()}`
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
      message: `🔄 Orchestrator Try again ${stage}(${attempt}/${maxRetries}): ${reason}`,
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
      reason: `${stage} Exhausted retries, Skip to continue(Processed ${context.jobsProcessed} positions)`,
    })
    return 'skip'
  }

  // ── Plan: LLM generates opening strategy ──────────────────────────────────

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
      const r = await modelChat([{ role: 'user', content: prompt }], this.ctx.aiConfig, 80)
      // Strip any preamble/thinking — take only the last substantive sentence
      const raw   = r.text.trim()
      const plan  = extractFinalSentence(raw)
      this.history.push(`[Plan] ${plan}`)

      this.emit('orchestrator_thinking', {
        thinking: plan,
        autonomous: this.autonomous,
      })
      return plan
    } catch {
      const fallback = `deal with ${agentCfg.targetRoles.length > 0 ? agentCfg.targetRoles.slice(0,2).join('/') : 'saved'} Position, threshold ${agentCfg.minMatchScore}%`
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

    let decision: OrchestratorDecision | null = null
    try {
      const r = await modelChat([{ role: 'user', content: prompt }], this.ctx.aiConfig, 400)
      decision = validateDecision(parseDecision(r.text), this.autonomous)
    } catch {
      throw new OrchestratorDecisionError()
    }
    if (!decision) throw new OrchestratorDecisionError()

    this.history.push(`[${stage}] ${summary} → ${decision.decision}: ${decision.thinking}`)
    this.emit('orchestrator_thinking', { stage, thinking: decision.thinking, decision: decision.decision })
    return decision
  }

  // ── Ask: durable pause — worker exits and the answer endpoint requeues it ──

  async ask(
    stage:    string,
    question: string,
    options:  QuestionOption[],
  ): Promise<string> {
    const existing = await db.agentRunQuestion.findFirst({
      // One stage can legitimately ask several questions (for example a
      // threshold exception followed by a weak-material review). Reuse only
      // the exact durable prompt on restart; never apply a prior answer to a
      // different decision in the same stage.
      where: { userId: this.ctx.userId, runId: this.runId, stage, question },
      orderBy: { createdAt: "desc" },
    })
    if (existing?.answer) {
      this.emit('orchestrator_answer_received', {
        id: existing.id, stage, answer: existing.answer,
        label: options.find(option => option.value === existing.answer)?.label ?? existing.answer,
      })
      this.history.push(`[Ask/${stage}] USER: ${existing.answer}`)
      return existing.answer
    }

    const q = existing ?? await db.agentRunQuestion.create({
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

    throw new AgentPauseError(q.id, stage)
  }

  // ── Apply fix from retry decision ──────────────────────────────────────────

  applyFix(fix: string | Record<string, unknown>, stage: string): void {
    if (typeof fix === 'string') {
      const named: Record<string, Record<string, unknown>> = {
        'no_jobs_found':              { dailyLimit: Math.min((this.ctx.agentCfg.dailyLimit ?? 10) * 2, 50) },
        'all_scoring_failed':         { model: 'claude-sonnet-5' },
        'too_many_scoring_failures':  { model: 'claude-sonnet-5' },
      }
      const resolved = named[fix]
      if (resolved) { this.applyFix(resolved, stage) }
      else {
        this.emit('orchestrator_fix', { stage, fix, message: `🔧 Orchestrator Problem detected [${stage}]: ${fix}, Try again…` })
        this.history.push(`[Fix/${stage}] ${fix}`)
      }
      return
    }
    const changes = applyAgentConfigPatch(this.ctx.agentCfg, agentConfigPatchFrom(fix))
    if (changes.length > 0) {
      this.emit('orchestrator_fix', {
        stage, fix: changes.join(', '),
        message: `🔧 Orchestrator repair [${stage}]: ${changes.join(', ')}`,
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
    const patch = agentConfigPatchFrom({ [field]: value })
    const data = prismaAgentConfigPatch(patch)
    if (Object.keys(data).length === 0 && Object.keys(patch).length === 0) return
    try {
      await db.agentConfig.updateMany({
        where: { userId: this.ctx.userId },
        data,
      });
      applyAgentConfigPatch(this.ctx.agentCfg, patch)
    } catch { /* non-fatal */ }
  }

  // ── Abort ─────────────────────────────────────────────────────────────────

  abort(stage: string, reason: string): void {
    this.emit('orchestrator_decision', {
      stage, decision: 'abort',
      reason: `🛑 Orchestrator abort [${stage}]: ${reason}`,
    })
    this.history.push(`[ABORT/${stage}] ${reason}`)
  }

  // ── Complete ──────────────────────────────────────────────────────────────

  complete(report: { processed: number; applied: number; queued: number; pending: number; skipped: number }): void {
    const retries = this.history.filter(h => h.includes('[Fix/')).length
    this.emit('orchestrator_complete', {
      thinking:   this.history.slice(-3).join(' → '),
      totalRetries: retries,
      autonomous:   this.autonomous,
      report,
      message: retries > 0
        ? `✅ Orchestrator Finish(Total repairs ${retries} Second-rate)`
        : `✅ Orchestrator Finish, Passed all stages successfully`,
    })
  }

  get runIdentifier() { return this.runId }
}
