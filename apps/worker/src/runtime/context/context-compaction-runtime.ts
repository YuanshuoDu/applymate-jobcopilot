import { Buffer } from "node:buffer"

import type { TenantScope } from "@jobcopilot/agent-protocol"
import type { ExecutionOwnerFence } from "../execution-owner.js"
import { TurnEngineError } from "../turns/turn-engine-types.js"
import { stableJson } from "../turns/turn-engine-replay.js"
import type { StepContextSnapshot } from "./step-context-builder.js"
import { parseContextCompactionObservation, type ContextCompactionHook, type ContextCompactionObservation, type ContextCompactionSnapshotLoader } from "./context-snapshot-compaction-seam.js"

const MAX_INPUT_BYTES = 256 * 1024
const MAX_OBSERVATION_BYTES = 8 * 1024
const COMPACTION_PREFIX = "context-compacted:"
const SUMMARY_PREFIX = "context-summary:"

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
type ToolObservation = StepContextSnapshot["toolObservations"][number]

function assertJsonValue(value: unknown, ancestors = new WeakSet<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new TypeError("non-finite number"); return }
  if (typeof value !== "object") throw new TypeError("non-JSON value")
  if (ancestors.has(value)) throw new TypeError("cyclic value")
  ancestors.add(value)
  try {
    const keys = Reflect.ownKeys(value)
    if (keys.length > MAX_INPUT_BYTES) throw new TypeError("oversized object")
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_INPUT_BYTES) throw new TypeError("non-plain array")
      for (const key of keys) { if (key === "length") continue; if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) throw new TypeError("invalid array member"); const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError("array accessor") }
      for (let index = 0; index < value.length; index += 1) { const descriptor = Object.getOwnPropertyDescriptor(value, String(index)); if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError("sparse array"); assertJsonValue(descriptor.value, ancestors) }
      return
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError("non-plain object")
    for (const key of keys) { if (typeof key !== "string") throw new TypeError("symbol property"); const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError("object accessor"); assertJsonValue(descriptor.value, ancestors) }
  } finally {
    ancestors.delete(value)
  }
}

function safeStableJson(value: unknown, message: string): string {
  try { assertJsonValue(value); return stableJson(value) } catch { throw new TurnEngineError("invalid_output", message) }
}

function measure(snapshot: StepContextSnapshot): { readonly tokens: number; readonly bytes: number } {
  const encoded = safeStableJson(snapshot, "Context compaction snapshot is not JSON-safe")
  return { tokens: Math.ceil(Array.from(encoded).length / 4), bytes: Buffer.byteLength(encoded, "utf8") }
}

function estimate(snapshot: StepContextSnapshot): { readonly tokens: number; readonly bytes: number } {
  const measured = measure(snapshot)
  const bytes = measured.bytes
  if (bytes > MAX_INPUT_BYTES) throw new TurnEngineError("invalid_output", "Context compaction input exceeds the bounded runtime limit")
  return measured
}

function snapshotShape(value: unknown): value is StepContextSnapshot {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const row = value as Record<string, unknown>
    if (Object.keys(row).some(key => !["system", "profile", "goal", "steerHistory", "businessRefs", "toolObservations"].includes(key))) return false
    if (!["system", "profile", "steerHistory", "businessRefs", "toolObservations"].every(key => Array.isArray(row[key]))) return false
    if (row.goal !== undefined && (!row.goal || typeof row.goal !== "object" || Array.isArray(row.goal))) return false
    safeStableJson(value, "Context compaction snapshot is not JSON-safe")
    return true
  } catch { return false }
}

function loadedSnapshotShape(value: unknown): value is LoadedSnapshot {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const row = value as Record<string, unknown>
    const scope = row.scope
    if (!scope || typeof scope !== "object" || Array.isArray(scope) || typeof (scope as Record<string, unknown>).userId !== "string") return false
    if (typeof row.sessionId !== "string" || typeof row.turnId !== "string" || !snapshotShape(row.snapshot)) return false
    safeStableJson(value, "Compacted snapshot replay is not JSON-safe")
    return true
  } catch { return false }
}

function invariantSnapshot(value: StepContextSnapshot): string {
  return safeStableJson({ system: value.system, profile: value.profile, ...(value.goal === undefined ? {} : { goal: value.goal }), steerHistory: value.steerHistory, businessRefs: value.businessRefs }, "Context compaction protected invariants are not JSON-safe")
}

function appendObservation(snapshot: StepContextSnapshot, observation: ContextCompactionObservation): StepContextSnapshot {
  const existing = snapshot.toolObservations.find(item => item.id === observation.id)
  const observationJson = safeStableJson(observation.content, "Context compaction observation is not JSON-safe")
  if (existing) {
    if (safeStableJson(existing.content, "Context compaction replay observation is not JSON-safe") !== observationJson) throw new TurnEngineError("invalid_output", "Context compaction replay has a conflicting projection")
    return snapshot
  }
  return { ...snapshot, toolObservations: [...snapshot.toolObservations, { id: observation.id, content: observation.content }] }
}

function parseMarker(item: ToolObservation): ContextCompactionObservation | null {
  if (typeof item.id !== "string" || !item.id.startsWith(COMPACTION_PREFIX)) return null
  try {
    const content = item.content && typeof item.content === "object" && !Array.isArray(item.content) ? item.content : {}; const parsed = parseContextCompactionObservation({ ...content, observationId: item.id })
    if (!parsed || parsed.id !== item.id || parsed.content.stepId !== item.id.slice(COMPACTION_PREFIX.length) || (parsed.content.snapshotRef !== undefined && parsed.content.snapshotRef.trim() !== parsed.content.snapshotRef)) throw new Error("invalid compaction marker")
    return parsed
  } catch { throw new TurnEngineError("invalid_output", "Context compaction marker is invalid") }
}

function priorCompaction(snapshot: StepContextSnapshot, currentId: string): ContextCompactionObservation | null {
  for (const item of [...snapshot.toolObservations].reverse()) if (item.id !== currentId) {
    const marker = parseMarker(item); if (marker?.content.status === "compacted") return marker
  }
  return null
}

function validateLoadedIdentity(loaded: LoadedSnapshot, marker: ContextCompactionObservation): void {
  const extra = loaded as unknown as Record<string, unknown>
  if ((extra.snapshotRef !== undefined && extra.snapshotRef !== marker.content.snapshotRef) || (extra.stepId !== undefined && extra.stepId !== marker.content.stepId)) throw new TurnEngineError("invalid_output", "Compacted snapshot replay identity mismatch")
  const summaries = loaded.snapshot.toolObservations.filter(item => typeof item.id === "string" && item.id.startsWith(SUMMARY_PREFIX))
  if (summaries.length > 0 && summaries.filter(item => item.id === `${SUMMARY_PREFIX}${marker.content.stepId}`).length !== 1) throw new TurnEngineError("invalid_output", "Compacted snapshot replay step mismatch")
}

function rehydrateSnapshot(current: StepContextSnapshot, loaded: LoadedSnapshot, marker: ContextCompactionObservation): StepContextSnapshot {
  const markerIndex = current.toolObservations.findIndex(item => item.id === marker.id); if (markerIndex < 0) throw new TurnEngineError("invalid_output", "Compacted snapshot replay marker is missing")
  const summary = loaded.snapshot.toolObservations.filter(item => item.id === `${SUMMARY_PREFIX}${marker.content.stepId}`); if (summary.length !== 1) throw new TurnEngineError("invalid_output", "Compacted snapshot replay is missing its step summary")
  const content = summary[0]!.content && typeof summary[0]!.content === "object" && !Array.isArray(summary[0]!.content) ? summary[0]!.content as Record<string, unknown> : null
  const value = content?.kind === "context_summary" && content.value && typeof content.value === "object" && !Array.isArray(content.value) ? content.value as Record<string, unknown> : null; const rawIds = value?.removedObservationIds
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > MAX_INPUT_BYTES) throw new TurnEngineError("invalid_output", "Compacted snapshot replay has incomplete removed observation IDs")
  const removed = new Set<string>()
  for (const id of rawIds) { if (typeof id !== "string" || id.length === 0 || id.length > 256 || removed.has(id)) throw new TurnEngineError("invalid_output", "Compacted snapshot replay has invalid removed observation IDs"); removed.add(id) }
  const loadedById = new Map<string, ToolObservation>()
  for (const item of loaded.snapshot.toolObservations) { if (typeof item.id !== "string" || item.id.length === 0 || item.id.length > 256 || loadedById.has(item.id)) throw new TurnEngineError("invalid_output", "Compacted snapshot replay has duplicate observation IDs"); loadedById.set(item.id, item) }
  const currentIds = new Set<string>()
  for (const item of current.toolObservations) { if (typeof item.id !== "string" || item.id.length === 0 || item.id.length > 256 || currentIds.has(item.id)) throw new TurnEngineError("invalid_output", "Context compaction input has duplicate observation IDs"); currentIds.add(item.id) }
  const before = current.toolObservations.slice(0, markerIndex); const after = current.toolObservations.slice(markerIndex + 1); const beforeIds = new Set(before.map(item => item.id))
  for (const id of removed) if (!beforeIds.has(id) || loadedById.has(id)) throw new TurnEngineError("invalid_output", "Compacted snapshot replay removed observation IDs are incomplete")
  for (const item of before) if (!loadedById.has(item.id) && !removed.has(item.id)) throw new TurnEngineError("invalid_output", "Compacted snapshot replay omitted a removed observation ID")
  const merged = [...loaded.snapshot.toolObservations]; const mergedIds = new Set(merged.map(item => item.id))
  for (const item of after) {
    const loadedItem = loadedById.get(item.id)
    if (removed.has(item.id)) throw new TurnEngineError("invalid_output", "Compacted snapshot replay marked a new observation as removed")
    if (loadedItem || mergedIds.has(item.id)) {
      if (loadedItem && safeStableJson(loadedItem.content, "Compacted snapshot replay observation is not JSON-safe") !== safeStableJson(item.content, "Context compaction observation is not JSON-safe")) throw new TurnEngineError("invalid_output", "Compacted snapshot replay has a conflicting observation")
      continue
    }
    merged.push(item); mergedIds.add(item.id)
  }
  const markerItem = current.toolObservations[markerIndex]!
  const loadedMarker = loadedById.get(markerItem.id)
  if (loadedMarker && safeStableJson(loadedMarker.content, "Compacted snapshot replay observation is not JSON-safe") !== safeStableJson(markerItem.content, "Context compaction observation is not JSON-safe")) throw new TurnEngineError("invalid_output", "Compacted snapshot replay has a conflicting marker")
  if (!loadedMarker) merged.push(markerItem)
  return { ...loaded.snapshot, toolObservations: merged }
}

async function failClosed(input: RuntimeInput, observationId: string, idempotencyKey: string, before: { readonly tokens: number; readonly bytes: number }): Promise<never> {
  const failed = { kind: "context_compacted", observationId, status: "failed", stepId: input.stepId, idempotencyKey, beforeInputTokens: before.tokens, afterInputTokens: before.tokens, beforeBytes: before.bytes, afterBytes: before.bytes, errorCode: "context_compaction_failed" } as const
  await input.append(failed, idempotencyKey).catch(() => undefined)
  throw new TurnEngineError("invalid_output", "Context compaction failed closed")
}

export async function runContextCompaction(input: RuntimeInput): Promise<RuntimeResult> {
  const observationId = `context-compacted:${input.stepId}`
  const idempotencyKey = `context-compaction:${input.stepId}`
  if (!snapshotShape(input.snapshot)) throw new TurnEngineError("invalid_output", "Context compaction input snapshot is not JSON-safe")
  const existing = input.snapshot.toolObservations.find(item => item.id === observationId)
  if (existing) {
    const replay = parseMarker(existing)
    if (!replay) throw new TurnEngineError("invalid_output", "Context compaction replay projection is invalid")
    if (replay.content.idempotencyKey !== idempotencyKey || replay.content.stepId !== input.stepId) throw new TurnEngineError("invalid_output", "Context compaction replay identity mismatch")
    if (replay.content.status === "failed") throw new TurnEngineError("invalid_output", "Context compaction replay failed closed")
    if (replay.content.status === "unchanged") return { snapshot: input.snapshot }
    if (!input.loadSnapshot || !replay.content.snapshotRef) throw new TurnEngineError("invalid_output", "Compacted snapshot replay is missing a server-owned snapshot loader")
    let loaded: Awaited<ReturnType<ContextCompactionSnapshotLoader>>
    try {
      loaded = await input.loadSnapshot({ snapshotRef: replay.content.snapshotRef, scope: input.scope, sessionId: input.sessionId, turnId: input.turnId })
    } catch {
      throw new TurnEngineError("invalid_output", "Compacted snapshot replay failed closed")
    }
    if (!loadedSnapshotShape(loaded) || loaded.sessionId !== input.sessionId || loaded.turnId !== input.turnId || loaded.scope.userId !== input.scope.userId) throw new TurnEngineError("invalid_output", "Compacted snapshot replay could not load a scoped snapshot")
    validateLoadedIdentity(loaded, replay)
    estimate(loaded.snapshot)
    if (invariantSnapshot(loaded.snapshot) !== invariantSnapshot(input.snapshot)) throw new TurnEngineError("invalid_output", "Compacted snapshot replay changed protected invariants")
    return { snapshot: appendObservation(loaded.snapshot, replay) }
  }
  if (!input.hook) return { snapshot: input.snapshot }
  const prior = priorCompaction(input.snapshot, observationId)
  const rawBefore = measure(input.snapshot)
  let workingSnapshot = input.snapshot
  if (prior && rawBefore.bytes > MAX_INPUT_BYTES) {
    if (!input.loadSnapshot) return failClosed(input, observationId, idempotencyKey, rawBefore)
    try {
      const loaded = await input.loadSnapshot({ snapshotRef: prior.content.snapshotRef!, scope: input.scope, sessionId: input.sessionId, turnId: input.turnId })
      if (!loadedSnapshotShape(loaded) || loaded.sessionId !== input.sessionId || loaded.turnId !== input.turnId || loaded.scope.userId !== input.scope.userId) throw new Error("scoped snapshot")
      validateLoadedIdentity(loaded, prior)
      estimate(loaded.snapshot)
      if (invariantSnapshot(loaded.snapshot) !== invariantSnapshot(input.snapshot)) throw new Error("protected snapshot")
      workingSnapshot = rehydrateSnapshot(input.snapshot, loaded, prior)
      estimate(workingSnapshot)
    } catch { return failClosed(input, observationId, idempotencyKey, rawBefore) }
  }
  const protectedBefore = invariantSnapshot(workingSnapshot)
  const before = estimate(workingSnapshot)
  let result: Awaited<ReturnType<ContextCompactionHook>>
  try {
    result = await input.hook({
      identity: input.identity, scope: input.scope, sessionId: input.sessionId, turnId: input.turnId,
      stepId: input.stepId, signal: input.signal, now: input.now, snapshot: structuredClone(workingSnapshot),
      estimatedInputTokens: before.tokens, estimatedBytes: before.bytes, idempotencyKey,
    })
  } catch {
    const failed = { kind: "context_compacted", observationId, status: "failed", stepId: input.stepId, idempotencyKey, beforeInputTokens: before.tokens, afterInputTokens: before.tokens, beforeBytes: before.bytes, afterBytes: before.bytes, errorCode: "context_compaction_failed" } as const
    await input.append(failed, idempotencyKey).catch(() => undefined)
    throw new TurnEngineError("invalid_output", "Context compaction failed closed")
  }
  let validResult = false
  try {
    validResult = !!result && typeof result === "object" && !Array.isArray(result) && ["unchanged", "compacted"].includes(result.status)
      && snapshotShape(result.snapshot)
  } catch { validResult = false }
  if (!validResult) {
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
  if (Buffer.byteLength(safeStableJson(observation, "Context compaction observation is not JSON-safe"), "utf8") > MAX_OBSERVATION_BYTES) return failClosed(input, observationId, idempotencyKey, before)
  try { await input.append(observation, idempotencyKey) } catch { throw new TurnEngineError("invalid_output", "Context compaction projection could not be persisted") }
  return { snapshot: appendObservation(result.snapshot, { id: observationId, content: observation }) }
}
