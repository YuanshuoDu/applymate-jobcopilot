/**
 * Agent Pipeline — Orchestrated by OrchestratorAgent
 *
 * Scout → Analyze → Prepare → Gate → Execute → Audit
 */
import { recordRoleRun, ROLE_META } from './role-config'
import { runCustomAgents } from './stages/custom'
import { OrchestratorAgent } from './orchestrator'
import type { PipelineCheckpointState, PipelineCtx, PipelineRunToolInput, PipelineRunToolOutput, PipelineStage, RunReport } from './types'
import type { PipelineStageRuntimeContext } from './pipeline-context'
import { runScoutAnalyzeStages } from './pipeline-scout-analyze'
import { runPrepareGateStages } from './pipeline-prepare-gate'
import { runExecuteAuditStages } from './pipeline-execute-audit'

export type { PipelineCtx }

/** Stable Agent-column coarse tool contract. userId is always runtime-owned. */
export const PIPELINE_RUN_TOOL = Object.freeze({
  name: 'pipeline.run',
  version: '1',
  description: 'Run or resume the job application preparation pipeline.',
  input: { type: 'object', additionalProperties: false, properties: { mode: { enum: ['resume', 'start'] } } },
})

export type { PipelineRunToolInput, PipelineRunToolOutput }

export class PipelineInterruptedError extends Error {
  readonly code = 'pipeline_interrupted'

  constructor() {
    super('Pipeline interrupted before the next stage could start')
    this.name = 'PipelineInterruptedError'
  }
}

function emitRole(ctx: PipelineCtx, role: string, event: 'start' | 'done', extra: Record<string, unknown> = {}) {
  const meta = ROLE_META[role as keyof typeof ROLE_META]
  const model = ctx.roleConfigs[role as keyof typeof ctx.roleConfigs]?.model ?? ctx.aiConfig.model
  if (event === 'start') {
    ctx.emit('role_start', { role, label: meta?.label ?? role, model, icon: meta?.icon ?? '' })
  } else {
    ctx.emit('role_done', { role, icon: meta?.icon ?? '', ...extra })
  }
}

const STAGE_ORDER: Record<PipelineStage, number> = { scout: 0, analyze: 1, prepare: 2, gate: 3, execute: 4, audit: 5, completed: 6 }

function needsStage(state: PipelineCheckpointState, stage: PipelineStage) {
  return STAGE_ORDER[state.nextStage] <= STAGE_ORDER[stage]
}

export async function runPipeline(ctx: PipelineCtx): Promise<RunReport> {
  const startedAt = Date.now()
  let state: PipelineCheckpointState = ctx.resumeState ?? { nextStage: 'scout', startedAt: new Date().toISOString() }
  let eventIndex = state.eventIndex ?? 0
  const canonicalWrites: Promise<unknown>[] = []
  const emit = (event: string, data: unknown) => {
    ctx.emit(event, data)
    const index = eventIndex++
    if (ctx.onCanonicalEvent) {
      canonicalWrites.push(Promise.resolve(ctx.onCanonicalEvent({
        event, data, index,
        idempotencyKey: `pipeline:${ctx.sessionId ?? ctx.userId}:${index}`,
      })))
    }
  }
  const flushCanonical = async () => { await Promise.all(canonicalWrites.splice(0)) }
  const assertAlive = async () => {
    if (ctx.signal?.aborted || (ctx.assertExecutionCurrent && !await ctx.assertExecutionCurrent())) {
      throw new PipelineInterruptedError()
    }
  }
  const pipelineCtx: PipelineCtx = { ...ctx, emit }
  const orch = new OrchestratorAgent(pipelineCtx, ctx.autonomous ?? false)
  const controlledCtx: PipelineCtx = {
    ...pipelineCtx,
    askUser: async (stage, question, options) => {
      const answer = await orch.ask(stage, question, options)
      await assertAlive()
      await orch.applyOptionAction(answer, options)
      await assertAlive()
      return answer
    },
  }
  let customAgentResults = state.customAgentResults ?? []
  const persist = async (nextStage: PipelineCheckpointState['nextStage'], patch: Partial<PipelineCheckpointState> = {}) => {
    await assertAlive()
    emit('pipeline_checkpoint', { nextStage, eventIndex })
    await flushCanonical()
    await assertAlive()
    state = { ...state, ...patch, customAgentResults, eventIndex, nextStage }
    await ctx.checkpoint?.(state)
    await assertAlive()
  }
  const collectCustomResults = async (jobs: Parameters<typeof runCustomAgents>[1], afterStage: string) => {
    const results = await runCustomAgents(controlledCtx, jobs, afterStage)
    if (Array.isArray(results)) customAgentResults = [...customAgentResults, ...results]
  }

  await assertAlive()
  await orch.plan()
  await assertAlive()

  const runtime: PipelineStageRuntimeContext = {
    ctx,
    pipelineCtx,
    controlledCtx,
    orchestrator: orch,
    getState: () => state,
    needsStage: stage => needsStage(state, stage),
    emit,
    emitRole,
    assertAlive,
    flushCanonical,
    persist,
    collectCustomResults,
    recordRoleRun: (role, result) => recordRoleRun(ctx.userId, role, result),
    getCustomAgentResults: () => customAgentResults,
    throwInterrupted: () => { throw new PipelineInterruptedError() },
    startedAt,
  }

  const scoutAnalyze = await runScoutAnalyzeStages(runtime)
  if (scoutAnalyze.terminalReport) return scoutAnalyze.terminalReport
  const prepareGate = await runPrepareGateStages(runtime, scoutAnalyze)
  const execution = await runExecuteAuditStages(runtime, { ...scoutAnalyze, ...prepareGate })
  return execution.report
}
