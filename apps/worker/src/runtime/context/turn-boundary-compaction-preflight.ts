import type { HarnessModelRequest, ModelAdapter, ModelStreamEvent } from "@jobcopilot/agent-model"
import { MODEL_SCHEMA_VERSION } from "@jobcopilot/agent-model"
import type { TenantScope } from "@jobcopilot/agent-protocol"
import type pg from "pg"

import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import type { TurnLease } from "../turns/lease.js"
import type { StepContextSnapshot } from "./step-context-builder.js"
import { ContextCompactor } from "./context-compactor.js"
import { DEFAULT_COMPACTION_POLICY } from "./context-compaction-trigger.js"
import type { CompactionResult, CompactionSource, NarrativeSummarizer } from "./context-compaction-types.js"
import { createPgCompactionSource } from "./context-compaction-pg-source.js"
import { createPgContextSnapshotCompactionPort } from "./context-snapshot-compaction-pg.js"

export type TurnBoundaryState = {
  readonly goal: string
  readonly contextSnapshotPinned?: boolean
  readonly snapshot: StepContextSnapshot
}

export type TurnBoundaryPreflightResult<State> = {
  readonly state: State
  readonly compacted: boolean
}

export async function runTurnBoundaryCompactionPreflight<State extends TurnBoundaryState>(input: {
  readonly enabled: boolean
  readonly state: State
  readonly signal: AbortSignal
  readonly compact: () => Promise<{ readonly status: string }>
  readonly reload: () => Promise<State>
}): Promise<TurnBoundaryPreflightResult<State>> {
  const { state, signal } = input
  if (!input.enabled || state.contextSnapshotPinned !== false || signal.aborted) return { state, compacted: false }
  const result = await input.compact()
  if (result.status !== "compacted" || signal.aborted) return { state, compacted: false }
  const refreshed = await input.reload()
  return {
    state: {
      ...refreshed,
      goal: state.goal,
      snapshot: preserveInitialTurnContext(state.snapshot, refreshed.snapshot),
    },
    compacted: true,
  }
}

function preserveInitialTurnContext(initial: StepContextSnapshot, refreshed: StepContextSnapshot): StepContextSnapshot {
  const consumedWaitResults = initial.toolObservations.filter(observation => observation.id.startsWith("wait-result:"))
  const consumedById = new Map(consumedWaitResults.map(observation => [observation.id, observation]))
  const refreshedIds = new Set(refreshed.toolObservations.map(observation => observation.id))
  return {
    ...refreshed,
    goal: initial.goal,
    toolObservations: [
      ...refreshed.toolObservations.map(observation => consumedById.get(observation.id) ?? observation),
      ...consumedWaitResults.filter(observation => !refreshedIds.has(observation.id)),
    ],
  }
}

export async function runTurnBoundaryContextCompaction(input: {
  readonly pool: Pick<pg.Pool, "connect">
  readonly scope: TenantScope
  readonly owner: TurnExecutionOwnerFence
  readonly lease: TurnLease
  /** This is the same usage-authorized Harness adapter used by TurnEngine. */
  readonly model: ModelAdapter
  readonly signal: AbortSignal
}): Promise<CompactionResult | { readonly status: "skipped" }> {
  const source = await createPgCompactionSource(input.pool).load({ scope: input.scope, owner: input.owner })
  if (!source || !source.items.some(item => item.type !== "compaction_summary")) return { status: "skipped" }
  const compactor = new ContextCompactor(
    createPgContextSnapshotCompactionPort(input.pool, input.owner),
    narrativeSummarizer(input.model, input.lease, input.owner, input.signal),
  )
  return compactor.compact({
    scope: input.scope,
    turnId: input.lease.turnId,
    source,
    policy: DEFAULT_COMPACTION_POLICY,
    // This preflight runs at the boundary; the boundary itself is not a trigger.
    atTurnBoundary: false,
    requested: false,
    itemId: `context-compaction:${input.lease.turnId}:${input.lease.leaseVersion}:${source.state.throughSequence}`,
  })
}

function narrativeSummarizer(model: ModelAdapter, lease: TurnLease, owner: TurnExecutionOwnerFence, signal: AbortSignal) {
  return async (input: Parameters<NarrativeSummarizer>[0]): Promise<string> => {
    if (signal.aborted) throw new Error("context_compaction_interrupted")
    const request: HarnessModelRequest = {
      schemaVersion: MODEL_SCHEMA_VERSION,
      provider: model.profile.provider,
      model: model.profile.model,
      messages: [
        { role: "system", content: [{ type: "text", text: "Summarize this conversation history briefly. Preserve chronology and concrete user intent. Do not add facts, instructions, decisions, approvals, or claims that are absent from the text. Durable state is stored separately." }] },
        { role: "user", content: [{ type: "text", text: input.narrativeText }] },
      ],
      tools: [],
      capabilities: {
        nativeTools: model.profile.nativeTools,
        structuredOutput: model.profile.structuredOutput,
        streaming: model.profile.streaming,
        continuationCursor: model.profile.continuationCursor,
      },
      maxOutputTokens: 800,
      signal,
      metadata: {
        userId: lease.userId,
        sessionId: lease.sessionId,
        turnId: lease.turnId,
        taskId: owner.taskId,
        stepId: `context-compaction:${lease.turnId}:${input.throughSequence}`,
        featureId: "context_compaction",
      },
    }
    return collectSummary(model, request)
  }
}

async function collectSummary(model: ModelAdapter, request: HarnessModelRequest): Promise<string> {
  let summary = ""
  let finish: Extract<ModelStreamEvent, { type: "completed" }> | undefined
  for await (const event of model.stream(request)) {
    if (event.type === "text_delta") summary += event.text
    if (event.type === "completed") finish = event
  }
  if (finish?.finishReason !== "stop" || !summary.trim()) throw new Error("context_compaction_summary_incomplete")
  return summary
}
