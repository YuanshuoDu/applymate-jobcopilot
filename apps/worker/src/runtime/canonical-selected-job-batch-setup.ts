import type pg from "pg"
import {
  parseVerifiedShortlistSelectionBinding,
  SELECTED_JOB_BATCH_PREPARATION_INTENT,
  TurnIntentSchema,
  validate,
  type VerifiedShortlistSelectionBinding,
} from "@jobcopilot/agent-protocol"

import type { CanonicalTurnState } from "./canonical-turn-state.js"
import { loadVerifiedShortlistBatchResources } from "./verified-shortlist-batch-resources.js"
import { createSelectedJobBatchTemplateRegistry, type SelectedJobBatchSlot } from "./subagents/selected-job-batch-plan.js"
import { taskGraphTemplatesForSelectedJob } from "./subagents/task-graph-templates.js"
import type { TaskGraphCommandPort, TaskGraphTaskTemplate } from "./subagents/task-graph-command-port.js"
import type { TurnLease } from "./turns/lease.js"
import type { RootTaskStore } from "./subagents/root-task-store.js"
import type { CanonicalExecutionProjection } from "./canonical-execution-projection.js"
import type { CanonicalSessionProjection } from "./canonical-session-projection.js"
import type { TurnExecutionResult } from "./turns/turn-queue.js"
import type { createCanonicalSelectedJobBatchRuntime } from "./canonical-selected-job-batch-runtime.js"

type BatchTemplates = Readonly<Record<string, TaskGraphTaskTemplate>>
export type CanonicalSelectedJobBatchReady = Readonly<{ status: "ready"; binding: VerifiedShortlistSelectionBinding; slots: readonly SelectedJobBatchSlot[]; templates: BatchTemplates }>
export type CanonicalSelectedJobBatchSetup =
  | Readonly<{ status: "not_batch" }>
  | Readonly<{ status: "unavailable" }>
  | CanonicalSelectedJobBatchReady

export function canonicalSelectedJobBatchRuntimeAvailable(input: Readonly<{
  enabled: boolean; coordination: boolean; childExecution: boolean; consumeWaitOutcomes: boolean; commandPort?: TaskGraphCommandPort; rootCompletion: boolean
}>): boolean {
  return input.enabled && input.coordination && input.childExecution && input.consumeWaitOutcomes && input.rootCompletion
    && typeof input.commandPort?.appendAndScheduleWithReconciliation === "function"
    && typeof input.commandPort.readCurrentWithClient === "function"
}

/** A batch source is runnable only when its terminal verifier is wired by trusted runtime composition. */
export async function prepareCanonicalSelectedJobBatchForTurn(input: Readonly<{
  pool: Pick<pg.Pool, "connect">; lease: TurnLease; state: Pick<CanonicalTurnState, "scope" | "source" | "intent" | "turnInput" | "rootTaskId">
  currentRootTaskId: string | null; signal: AbortSignal; completionGate?: typeof createCanonicalSelectedJobBatchRuntime; runtimeAvailable: boolean
}>): Promise<CanonicalSelectedJobBatchSetup> {
  const setup = await prepareCanonicalSelectedJobBatchSetup(input)
  if (setup.status === "not_batch") return setup
  if (input.signal.aborted) input.signal.throwIfAborted()
  return setup.status === "ready" && typeof input.completionGate === "function" && input.runtimeAvailable
    ? setup : { status: "unavailable" }
}

/** Builds only the proved per-Job Writer/Reviewer setup, on the caller's tenant-configured transaction. */
export async function prepareCanonicalSelectedJobBatchSetup(input: Readonly<{
  pool: Pick<pg.Pool, "connect">
  lease: TurnLease
  state: Pick<CanonicalTurnState, "scope" | "source" | "intent" | "turnInput">
  currentRootTaskId: string | null
  signal?: AbortSignal
}>): Promise<CanonicalSelectedJobBatchSetup> {
  const parsed = batchBindingFromState(input.state, input.lease)
  if (parsed.kind === "not_batch") return { status: "not_batch" }
  if (input.signal?.aborted) input.signal.throwIfAborted()
  if (parsed.kind === "unavailable") return { status: "unavailable" }

  let client: pg.PoolClient | undefined
  let transactionStarted = false
  let committed = false
  try {
    client = await input.pool.connect()
    await client.query("BEGIN")
    transactionStarted = true
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", input.lease.userId])
    const slots = await loadVerifiedShortlistBatchResources({
      client, lease: input.lease, expectedRootTaskId: input.currentRootTaskId, binding: parsed.binding,
    })
    const firstJobId = slots?.[0]?.jobId
    if (!slots || !firstJobId) return { status: "unavailable" }

    const presets = taskGraphTemplatesForSelectedJob({ jobId: firstJobId })
    const writer = presets.cover_letter_writer, reviewer = presets.cover_letter_reviewer
    if (!writer || !reviewer) return { status: "unavailable" }
    const registry = createSelectedJobBatchTemplateRegistry(slots, { writer, reviewer })
    await client.query("COMMIT")
    committed = true
    return Object.freeze({ status: "ready", binding: parsed.binding, slots, templates: registry.templates })
  } catch {
    return { status: "unavailable" }
  } finally {
    if (client) {
      if (transactionStarted && !committed) await client.query("ROLLBACK").catch(() => undefined)
      client.release()
    }
  }
}

/** Terminalize an unusable batch request with no Root actions or generic-model fallback. */
export async function failCanonicalSelectedJobBatchUnavailable(input: {
  readonly lease: TurnLease; readonly state: CanonicalTurnState; readonly rootTasks: RootTaskStore
  readonly executionProjection: CanonicalExecutionProjection; readonly sessionProjection: CanonicalSessionProjection; readonly now: () => Date
}): Promise<TurnExecutionResult> {
  const { lease, state, rootTasks, executionProjection, sessionProjection, now } = input
  const result = { status: "failed" as const, errorCode: "selected_job_batch_unavailable", stepCount: 0, toolCallCount: 0 }
  const root = await rootTasks.ensure({ lease, goal: state.goal, modelProfileSnapshot: state.modelProfileSnapshot, toolPolicySnapshot: state.toolPolicySnapshot, budgetSnapshot: state.budgetSnapshot, allowedActions: [], now: now() })
  await rootTasks.finish({ lease, rootTaskId: root.id, result, now: now() })
  await executionProjection.finish({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, result })
  await sessionProjection.finish({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, result })
  return { status: "failed", summary: result.errorCode }
}

type BindingCheck = { kind: "not_batch" } | { kind: "unavailable" } | { kind: "ready"; binding: VerifiedShortlistSelectionBinding }

function batchBindingFromState(
  state: Pick<CanonicalTurnState, "scope" | "source" | "intent" | "turnInput">,
  lease: TurnLease,
): BindingCheck {
  const turnInput = ownRecord(state.turnInput)
  const inputIntent = ownRecord(turnInput?.intent)
  const stateClaimsBatch = isBatchIntent(state.intent)
  const inputClaimsBatch = inputIntent?.kind === SELECTED_JOB_BATCH_PREPARATION_INTENT.kind
  const bindingPresent = Boolean(turnInput && Object.hasOwn(turnInput, "verifiedShortlistSelection"))
  if (!stateClaimsBatch && !inputClaimsBatch && !bindingPresent) return { kind: "not_batch" }

  if (state.source !== "user" || state.scope.userId !== lease.userId || !stateClaimsBatch
    || !isBatchIntent(inputIntent) || !bindingPresent) return { kind: "unavailable" }
  const binding = parseVerifiedShortlistSelectionBinding(turnInput?.verifiedShortlistSelection)
  return binding ? { kind: "ready", binding } : { kind: "unavailable" }
}

function isBatchIntent(value: unknown): boolean {
  const intent = ownRecord(value)
  return Boolean(intent && validate(TurnIntentSchema, intent)
    && intent.kind === SELECTED_JOB_BATCH_PREPARATION_INTENT.kind && intent.version === SELECTED_JOB_BATCH_PREPARATION_INTENT.version)
}

function ownRecord(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === "string" ? parseJson(value) : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try {
    const prototype = Object.getPrototypeOf(parsed), keys = Reflect.ownKeys(parsed)
    if ((prototype !== Object.prototype && prototype !== null) || keys.some(key => typeof key !== "string")) return null
    const descriptors = Object.getOwnPropertyDescriptors(parsed), result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of keys as string[]) {
      const descriptor = descriptors[key]
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null
      result[key] = descriptor.value
    }
    return result
  } catch { return null }
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown } catch { return null }
}
