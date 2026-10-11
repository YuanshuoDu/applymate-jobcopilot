import type pg from "pg"

import type { TurnLease } from "./turns/lease.js"
import type { SubagentTaskRecord } from "./subagents/types.js"
import type { CanonicalTurnState } from "./canonical-turn-state.js"
import type { CanonicalExecutionProjection } from "./canonical-execution-projection.js"
import type { CanonicalSessionProjection } from "./canonical-session-projection.js"
import type { TurnExecutionResult } from "./turns/turn-queue.js"
import type { TurnEngineCompletionGateResult } from "./turns/turn-execution-types.js"
import type { TurnEngineToolExecutor, TurnEngineToolResult } from "./turns/turn-engine-types.js"
import type { RootTaskStore } from "./subagents/root-task-store.js"
import { toRepositoryJson, type TurnEngineStore } from "./turns/turn-engine-types.js"
import { loadInteractiveDiscoveryShortlist } from "./interactive-discovery-persistence.js"
import { failedInteractiveDiscoveryShortlist, interactiveDiscoveryRootToolAllowed, validInteractiveDiscoveryShortlist, type InteractiveDiscoveryShortlistProjection } from "./interactive-discovery-contract.js"
import { selectedJobToolAllowed } from "./canonical-turn-task-graph-context.js"
import type { DiscoveryShortlistResult } from "./subagents/discovery-shortlist.js"
import { TASK_GRAPH_FINAL_SUMMARY_BINDING } from "./subagents/task-graph-final-summary-binding.js"

type Row = Record<string, unknown>

export function createCanonicalRootToolGuards(input: {
  readonly interactiveDiscoveryMode: boolean
  readonly selectedJobMode: boolean
  readonly routeTool: TurnEngineToolExecutor
  readonly validateArguments: (name: string, value: unknown) => boolean | string
}): {
  readonly executeTool: TurnEngineToolExecutor
  readonly validateToolArguments: (name: string, value: unknown) => boolean | string
} {
  const denied = (name: string): string | undefined => input.interactiveDiscoveryMode && !interactiveDiscoveryRootToolAllowed(name)
    ? "interactive_discovery_root_tool_disabled"
    : input.selectedJobMode && !selectedJobToolAllowed(name) ? "selected_job_root_tool_disabled" : undefined
  return {
    executeTool: request => {
      const errorCode = denied(request.call.toolName)
      return errorCode
        ? Promise.resolve<TurnEngineToolResult>({ id: request.call.id, toolName: request.call.toolName, toolVersion: request.call.toolVersion, status: "failed", errorCode })
        : input.routeTool(request)
    },
    validateToolArguments: (name, value) => denied(name) ?? input.validateArguments(name, value),
  }
}

export async function failInteractiveDiscoveryUnavailable(input: {
  readonly lease: TurnLease
  readonly state: CanonicalTurnState
  readonly rootTasks: RootTaskStore
  readonly executionProjection: CanonicalExecutionProjection
  readonly sessionProjection: CanonicalSessionProjection
  readonly now: () => Date
}): Promise<TurnExecutionResult> {
  const { lease, state, rootTasks, executionProjection, sessionProjection, now } = input
  const result = { status: "failed" as const, errorCode: "interactive_discovery_unavailable", stepCount: 0, toolCallCount: 0 }
  const root = await rootTasks.ensure({ lease, goal: state.goal, modelProfileSnapshot: state.modelProfileSnapshot, toolPolicySnapshot: state.toolPolicySnapshot, budgetSnapshot: state.budgetSnapshot, allowedActions: [], now: now() })
  await rootTasks.finish({ lease, rootTaskId: root.id, result, metadata: { interactiveDiscoveryShortlist: failedInteractiveDiscoveryShortlist("discovery_runtime_unavailable") }, now: now() })
  await executionProjection.finish({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, result })
  await sessionProjection.finish({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, result })
  return { status: "failed", summary: result.errorCode }
}

export async function interactiveDiscoveryCompletionGate(input: {
  readonly pool: Pick<pg.Pool, "connect">
  readonly lease: TurnLease
  readonly root: Pick<SubagentTaskRecord, "id" | "attemptCount">
  readonly load?: typeof loadInteractiveDiscoveryShortlist
  readonly accept: (shortlist: InteractiveDiscoveryShortlistProjection | undefined) => void
  readonly markUnavailable: () => void
}): Promise<TurnEngineCompletionGateResult> {
  let shortlist: InteractiveDiscoveryShortlistProjection | undefined
  try { shortlist = await (input.load ?? loadInteractiveDiscoveryShortlist)({ pool: input.pool, lease: input.lease, root: input.root }) }
  catch { input.markUnavailable() }
  if (!shortlist) input.markUnavailable()
  input.accept(shortlist)
  return validInteractiveDiscoveryShortlist(shortlist)
    ? { ok: true }
    : { ok: false, blocker: "interactive_discovery_shortlist_required", feedback: "Complete both registered child analyses and provide at least one evidence-bound ranked job before finishing." }
}

export function withInteractiveDiscoveryFinalResponse(store: TurnEngineStore, getShortlist: () => DiscoveryShortlistResult | undefined): TurnEngineStore {
  return {
    ...store,
    async recordFinalResponse(input) {
      const shortlist = getShortlist()
      if (!shortlist || !validInteractiveDiscoveryShortlist(shortlist) || !input.terminal) throw new Error("interactive_discovery_shortlist_missing")
      const finalResponse = object(parseJson(input.response))
      if (finalResponse.schemaVersion !== "agent-harness.v2.final" || typeof finalResponse.response !== "string") throw new Error("interactive_discovery_final_response_invalid")
      const hasSummaryBinding = input.terminal[TASK_GRAPH_FINAL_SUMMARY_BINDING] !== undefined
      const response = JSON.stringify(shortlist), final = { ...finalResponse, response }
      return store.recordFinalResponse({
        ...input,
        ...(!hasSummaryBinding ? { response: JSON.stringify(final) } : {}),
        terminal: {
          ...input.terminal,
          ...(!hasSummaryBinding ? { finalContent: toRepositoryJson({ text: response, final }) } : {}),
          interactiveDiscoveryShortlist: toRepositoryJson(shortlist),
        },
      })
    },
  }
}

function object(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {} }
function parseJson(value: string): unknown { try { return JSON.parse(value) as unknown } catch { return undefined } }
