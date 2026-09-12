import { Buffer } from "node:buffer"

import type { TenantScope } from "@jobcopilot/agent-protocol"
import type { ExecutionOwnerFence } from "../execution-owner.js"
import { TurnEngineError } from "../turns/turn-engine-types.js"
import { stableJson } from "../turns/turn-engine-replay.js"
import type { StepContextSnapshot } from "./step-context-builder.js"
import { parseContextCompactionObservation, type ContextCompactionHook, type ContextCompactionObservation, type ContextCompactionSnapshotLoader } from "./context-snapshot-compaction-seam.js"

const MAX_INPUT_BYTES = 256 * 1024
const MAX_OBSERVATION_BYTES = 8 * 1024

type RuntimeInput = {
  readonly hook?: ContextCompactionHook
  readonly loadSnapshot?: ContextCompactionSnapshotLoader
  readonly identity: ExecutionOwnerFence
  readonly scope: TenantScope
  readonly sessionId: string
  readonly turnId: string
  readonly stepId: string
  readonly signal: AbortSignal
  readonly now: Date
  readonly snapshot: StepContextSnapshot
  readonly append: (payload: unknown, key: string) => Promise<unknown>
}

type RuntimeResult = { readonly snapshot: StepContextSnapshot }
type LoadedSnapshot = { readonly snapshot: StepContextSnapshot; readonly scope: TenantScope; readonly sessionId: string; readonly turnId: string }

function estimate(snapshot: StepContextSnapshot): { readonly tokens: number; readonly bytes: number } {
  const encoded = stableJson(snapshot)
  const bytes = Buffer.byteLength(encoded, "utf8")
  if (bytes > MAX_INPUT_BYTES) throw new TurnEngineError("invalid_output", "Context compaction input exceeds the bounded runtime limit")
  return { tokens: Math.ceil(Array.from(encoded).length / 4), bytes }
}

function snapshotShape(value: unknown): value is StepContextSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(key => !["system", "profile", "goal", "steerHistory", "businessRefs", "toolObservations"].includes(key))) return false
  return ["system", "profile", "steerHistory", "businessRefs", "toolObservations"].every(key => Array.isArray(row[key]))
    && (row.goal === undefined || (!!row.goal && typeof row.goal === "object" && !Array.isArray(row.goal)))
}

function loadedSnapshotShape(value: unknown): value is LoadedSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  const scope = row.scope
  return !!scope && typeof scope === "object" && !Array.isArray(scope) && typeof (scope as Record<string, unknown>).userId === "string"
    && typeof row.sessionId === "string" && typeof row.turnId === "string" && snapshotShape(row.snapshot)
}

function invariantSnapshot(value: StepContextSnapshot): string {
  return stableJson({ system: value.system, profile: value.profile, goal: value.goal, steerHistory: value.steerHistory, businessRefs: value.businessRefs })
}

function appendObservation(snapshot: StepContextSnapshot, observation: ContextCompactionObservation): StepContextSnapshot {
  const existing = snapshot.toolObservations.find(item => item.id === observation.id)
  if (existing) {
    if (stableJson(existing.content) !== stableJson(observation.content)) throw new TurnEngineError("invalid_output", "Context compaction replay has a conflicting projection")
    return snapshot
  }
  return { ...snapshot, toolObservations: [...snapshot.toolObservations, { id: observation.id, content: observation.content }] }
}

async function failClosed(input: RuntimeInput, observationId: string, idempotencyKey: string, before: { readonly tokens: number; readonly bytes: number }): Promise<never> {
  const failed = { kind: "context_compacted", observationId, status: "failed", stepId: input.stepId, idempotencyKey, beforeInputTokens: before.tokens, afterInputTokens: before.tokens, beforeBytes: before.bytes, afterBytes: before.bytes, errorCode: "context_compaction_failed" } as const
  await input.append(failed, idempotencyKey).catch(() => undefined)
  throw new TurnEngineError("invalid_output", "Context compaction failed closed")
}

export async function runContextCompaction(input: RuntimeInput): Promise<RuntimeResult> {
  const observationId = `context-compacted:${input.stepId}`
  const idempotencyKey = `context-compaction:${input.stepId}`
  const existing = input.snapshot.toolObservations.find(item => item.id === observationId)
  if (existing) {
    const replay = parseContextCompactionObservation({ ...((existing.content && typeof existing.content === "object" && !Array.isArray(existing.content)) ? existing.content : {}), observationId })
    if (!replay) throw new TurnEngineError("invalid_output", "Context compaction replay projection is invalid")
    if (replay.content.idempotencyKey !== idempotencyKey || replay.content.stepId !== input.stepId) throw new TurnEngineError("invalid_output", "Context compaction replay identity mismatch")
    if (replay.content.status === "failed") throw new TurnEngineError("invalid_output", "Context compaction replay failed closed")
    if (replay.content.status === "unchanged") return { snapshot: input.snapshot }
    if (!input.loadSnapshot || !replay.content.snapshotRef) throw new TurnEngineError("invalid_output", "Compacted snapshot replay is missing a server-owned snapshot loader")
    const loaded = await input.loadSnapshot({ snapshotRef: replay.content.snapshotRef, scope: input.scope, sessionId: input.sessionId, turnId: input.turnId })
    if (!loadedSnapshotShape(loaded) || loaded.sessionId !== input.sessionId || loaded.turnId !== input.turnId || loaded.scope.userId !== input.scope.userId) throw new TurnEngineError("invalid_output", "Compacted snapshot replay could not load a scoped snapshot")
    if (invariantSnapshot(loaded.snapshot) !== invariantSnapshot(input.snapshot)) throw new TurnEngineError("invalid_output", "Compacted snapshot replay changed protected invariants")
    return { snapshot: appendObservation(loaded.snapshot, replay) }
  }
  if (!input.hook) return { snapshot: input.snapshot }
  const protectedBefore = invariantSnapshot(input.snapshot)
  const before = estimate(input.snapshot)
  let result: Awaited<ReturnType<ContextCompactionHook>>
  try {
    result = await input.hook({
      identity: input.identity, scope: input.scope, sessionId: input.sessionId, turnId: input.turnId,
      stepId: input.stepId, signal: input.signal, now: input.now, snapshot: structuredClone(input.snapshot),
      estimatedInputTokens: before.tokens, estimatedBytes: before.bytes, idempotencyKey,
    })
  } catch {
    const failed = { kind: "context_compacted", observationId, status: "failed", stepId: input.stepId, idempotencyKey, beforeInputTokens: before.tokens, afterInputTokens: before.tokens, beforeBytes: before.bytes, afterBytes: before.bytes, errorCode: "context_compaction_failed" } as const
    await input.append(failed, idempotencyKey).catch(() => undefined)
    throw new TurnEngineError("invalid_output", "Context compaction failed closed")
  }
  if (!result || typeof result !== "object" || !["unchanged", "compacted"].includes(result.status) || !snapshotShape(result.snapshot)) {
    return failClosed(input, observationId, idempotencyKey, before)
  }
  try {
    if (invariantSnapshot(result.snapshot) !== protectedBefore) return failClosed(input, observationId, idempotencyKey, before)
  } catch { return failClosed(input, observationId, idempotencyKey, before) }
  if (result.status === "compacted" && (typeof result.snapshotRef !== "string" || result.snapshotRef.trim().length === 0 || result.snapshotRef.length > 256)) return failClosed(input, observationId, idempotencyKey, before)
  let after: { readonly tokens: number; readonly bytes: number }
  try { after = estimate(result.snapshot) } catch { return failClosed(input, observationId, idempotencyKey, before) }
  if (result.status === "compacted" && (after.tokens >= before.tokens || after.bytes > before.bytes)) return failClosed(input, observationId, idempotencyKey, before)
  const observation = { kind: "context_compacted", observationId, status: result.status, stepId: input.stepId, idempotencyKey, beforeInputTokens: before.tokens, afterInputTokens: after.tokens, beforeBytes: before.bytes, afterBytes: after.bytes, ...(result.status === "compacted" ? { snapshotRef: result.snapshotRef } : {}) } as const
  if (Buffer.byteLength(JSON.stringify(observation), "utf8") > MAX_OBSERVATION_BYTES) return failClosed(input, observationId, idempotencyKey, before)
  try { await input.append(observation, idempotencyKey) } catch { throw new TurnEngineError("invalid_output", "Context compaction projection could not be persisted") }
  return { snapshot: appendObservation(result.snapshot, { id: observationId, content: observation }) }
}
