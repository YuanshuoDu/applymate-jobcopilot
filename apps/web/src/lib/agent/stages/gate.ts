/** Stage 4 — shared manual and scheduled Gate policy. */
import type { PipelineCtx, ApplicationPackage, GateOutput, StageResult } from '../types'
import { AgentExecutionCancelledError } from '../execution-control'
import { runGatePolicy } from './gate-policy'
import type { ScheduledTaskGraphGateCompletion, ScheduledTaskGraphGateQuestion } from '../scheduled-taskgraph-gate-service'
import { hasEffectiveEntitlement, isFeatureAllowed, resolveAiAccess } from '@/lib/entitlements'
import { isActiveAccount } from '../run-service-helpers'

export type ScheduledGateRunResult = ScheduledTaskGraphGateQuestion | ScheduledTaskGraphGateCompletion

export async function scheduledGateAdmissionFailure(userId: string, autoApply: boolean): Promise<string | null> {
  if (!await isActiveAccount(userId)) return 'scheduled_pipeline_account_unavailable'
  if (!await isFeatureAllowed(userId, 'auto_apply')) return 'scheduled_pipeline_entitlement_required'
  if (await resolveAiAccess(userId) === 'disabled') return 'scheduled_pipeline_ai_unavailable'
  if (autoApply && !await hasEffectiveEntitlement(userId, 'auto_apply')) return 'scheduled_pipeline_entitlement_required'
  return null
}

export async function runGate(packages: ApplicationPackage[], ctx: PipelineCtx): Promise<StageResult<GateOutput>> {
  const result = await runGatePolicy(packages, ctx, false)
  if (result.status !== 'stage_completed') throw new AgentExecutionCancelledError()
  return result.result
}

/** Runs the shared Gate policy without legacy Orchestrator questions. */
export async function runScheduledGate(packages: readonly ApplicationPackage[], ctx: PipelineCtx,
  validatedChoice?: unknown, priorChoices?: readonly unknown[]): Promise<ScheduledGateRunResult> {
  const result = await runGatePolicy(packages, ctx, true, validatedChoice, priorChoices)
  if (result.status !== 'stage_completed') return result
  const output = result.result.data
  if (!output) throw new AgentExecutionCancelledError()
  return { status: 'completed', nextStage: 'execute', approvedJobIds: output.approved.map(pkg => pkg.job.id),
    pendingJobIds: output.pending.map(pkg => pkg.job.id), skippedJobIds: output.skipped.map(pkg => pkg.job.id),
    counts: { approved: output.approved.length, pending: output.pending.length, skipped: output.skipped.length } }
}
