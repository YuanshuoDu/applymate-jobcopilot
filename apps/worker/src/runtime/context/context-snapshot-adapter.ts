import { createHash } from "node:crypto"
import { Buffer } from "node:buffer"

import type { TenantScope } from "@jobcopilot/agent-protocol"
import { estimateCompactionTokens } from "./context-compaction-collector.js"
import { canonicalJson } from "./context-snapshot-json.js"
import type { StepContextSnapshot } from "./step-context-builder.js"
import type { ContextCompactionHook, ContextCompactionHookInput, ContextCompactionHookResult, ContextCompactionSnapshotLoader } from "./context-snapshot-compaction-seam.js"

const DEFAULT_MAX_SNAPSHOT_BYTES = 256 * 1024
const DEFAULT_MAX_SUMMARY_BYTES = 8 * 1024

export type ContextSnapshotAdapterStore = {
  save(input: { readonly snapshotRef: string; readonly scope: TenantScope; readonly sessionId: string; readonly turnId: string; readonly idempotencyKey: string; readonly snapshot: StepContextSnapshot }): Promise<{ readonly snapshotRef: string; readonly scope: TenantScope; readonly sessionId: string; readonly turnId: string }>
  load(input: { readonly snapshotRef: string; readonly scope: TenantScope; readonly sessionId: string; readonly turnId: string }): Promise<{ readonly snapshot: StepContextSnapshot; readonly scope: TenantScope; readonly sessionId: string; readonly turnId: string } | null>
}

export type ContextSnapshotAdapterOptions = {
  readonly store: ContextSnapshotAdapterStore
  readonly inputTokenThreshold?: number
  readonly observationCountThreshold?: number
  readonly keepRecentObservations: number
  readonly maxSummaryBytes?: number
  readonly maxSnapshotBytes?: number
  readonly summarizer?: (input: { readonly scope: TenantScope; readonly sessionId: string; readonly turnId: string; readonly stepId: string; readonly removed: readonly { readonly id: string; readonly content: unknown }[] }) => Promise<unknown> | unknown
}

export type ContextSnapshotAdapter = { readonly hook: ContextCompactionHook; readonly loadSnapshot: ContextCompactionSnapshotLoader }

type AdapterInput = ContextCompactionHookInput
type CachedResult = Promise<ContextCompactionHookResult>

function positive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Context compaction threshold is invalid")
  return value
}

function bounded(value: number | undefined, fallback: number, max: number): number {
  const result = positive(value, fallback)
  if (result > max) throw new TypeError("Context compaction bound is invalid")
  return result
}

function identity(input: { readonly scope: TenantScope; readonly sessionId: string; readonly turnId: string }): void {
  if (!input.scope || typeof input.scope.userId !== "string" || input.scope.userId.trim().length === 0 || !input.sessionId.trim() || !input.turnId.trim()) throw new TypeError("Context snapshot identity is invalid")
}

function measure(snapshot: StepContextSnapshot, maxBytes: number): { readonly tokens: number; readonly bytes: number } {
  const encoded = canonicalJson(snapshot)
  const bytes = Buffer.byteLength(encoded, "utf8")
  if (bytes > maxBytes) throw new TypeError("Context snapshot exceeds its bound")
  return { tokens: estimateCompactionTokens(encoded), bytes }
}

function safeSummary(value: unknown, maxBytes: number): unknown {
  const encoded = canonicalJson(value)
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) throw new TypeError("Context summary exceeds its bound")
  return JSON.parse(encoded) as unknown
}

export function createContextSnapshotAdapter(options: ContextSnapshotAdapterOptions): ContextSnapshotAdapter {
  const inputThreshold = positive(options.inputTokenThreshold, Number.MAX_SAFE_INTEGER)
  const observationThreshold = positive(options.observationCountThreshold, Number.MAX_SAFE_INTEGER)
  const keepRecent = bounded(options.keepRecentObservations, 1, 64)
  const maxSummaryBytes = bounded(options.maxSummaryBytes, DEFAULT_MAX_SUMMARY_BYTES, DEFAULT_MAX_SUMMARY_BYTES)
  const maxSnapshotBytes = bounded(options.maxSnapshotBytes, DEFAULT_MAX_SNAPSHOT_BYTES, 1024 * 1024)
  if (inputThreshold === Number.MAX_SAFE_INTEGER && observationThreshold === Number.MAX_SAFE_INTEGER) throw new TypeError("Context compaction requires a threshold")
  const cached = new Map<string, CachedResult>()

  const hook: ContextCompactionHook = (input) => {
    const existing = cached.get(input.idempotencyKey)
    if (existing) return existing
    const result = compact(options, input, inputThreshold, observationThreshold, keepRecent, maxSummaryBytes, maxSnapshotBytes)
    cached.set(input.idempotencyKey, result)
    return result
  }
  const loadSnapshot: ContextCompactionSnapshotLoader = async input => {
    identity(input)
    const loaded = await options.store.load(input)
    if (!loaded) return null
    if (!loaded.scope || typeof loaded.scope !== "object" || typeof loaded.scope.userId !== "string" || loaded.sessionId !== input.sessionId || loaded.turnId !== input.turnId || loaded.scope.userId !== input.scope.userId) return null
    return loaded
  }
  return { hook, loadSnapshot }
}

async function compact(options: ContextSnapshotAdapterOptions, input: AdapterInput, inputThreshold: number, observationThreshold: number, keepRecent: number, maxSummaryBytes: number, maxSnapshotBytes: number): Promise<ContextCompactionHookResult> {
  identity(input)
  const before = measure(input.snapshot, maxSnapshotBytes)
  if ((before.tokens < inputThreshold && input.snapshot.toolObservations.length < observationThreshold) || input.snapshot.toolObservations.length <= keepRecent) return { status: "unchanged", snapshot: input.snapshot }
  const removed = input.snapshot.toolObservations.slice(0, -keepRecent)
  if (removed.length === 0) return { status: "unchanged", snapshot: input.snapshot }
  const summaryValue = options.summarizer
    ? await options.summarizer({ scope: input.scope, sessionId: input.sessionId, turnId: input.turnId, stepId: input.stepId, removed: structuredClone(removed) })
    : { removedCount: removed.length, removedObservationIds: removed.map(item => item.id) }
  const summary = safeSummary({ kind: "context_summary", value: summaryValue }, maxSummaryBytes)
  const compacted: StepContextSnapshot = { ...input.snapshot, toolObservations: [{ id: `context-summary:${input.stepId}`, content: summary }, ...input.snapshot.toolObservations.slice(-keepRecent)] }
  const after = measure(compacted, maxSnapshotBytes)
  if (after.tokens >= before.tokens || after.bytes > before.bytes) throw new TypeError("Context compaction did not reduce the snapshot")
  const snapshotRef = createHash("sha256").update(canonicalJson({ userId: input.scope.userId, sessionId: input.sessionId, turnId: input.turnId, stepId: input.stepId, idempotencyKey: input.idempotencyKey, snapshot: compacted }), "utf8").digest("hex")
  const saved = await options.store.save({ snapshotRef, scope: input.scope, sessionId: input.sessionId, turnId: input.turnId, idempotencyKey: input.idempotencyKey, snapshot: compacted })
  if (!saved || saved.snapshotRef !== snapshotRef || !saved.scope || typeof saved.scope !== "object" || typeof saved.scope.userId !== "string" || saved.scope.userId !== input.scope.userId || saved.sessionId !== input.sessionId || saved.turnId !== input.turnId) throw new TypeError("Context snapshot store returned an invalid scoped reference")
  return { status: "compacted", snapshot: compacted, snapshotRef }
}
