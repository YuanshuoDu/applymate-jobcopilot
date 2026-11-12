import { createHash } from "node:crypto"
import { redactSensitiveText } from "@jobcopilot/shared"
import type { TaskExecutionOwnerFence } from "../execution-owner.js"
import type { StepContextSnapshot } from "../context/step-context-builder.js"
import type { PersistedToolExecutionReceipt } from "./turn-execution-events.js"
import type { ChildToolReplayReceipt, ChildWaitReplayReceipt } from "./turn-execution-options.js"
import { childReplayReceiptMatchesInput, childReplayReceiptMatchesObservation } from "./turn-child-replay-receipt-proof.js"
import { TurnEngineError } from "./turn-engine-types.js"

const ALIAS_PREFIX = "toolcall"
const HEX_NIBBLE_ALPHABET = "abcdefghijklmnop"
const COUNTER_ALPHABET = "abcdefghijklmnopqrstuvwxyz"

type ToolCallIdObservation = {
  readonly index: number
  readonly id: string
  readonly content: Record<string, unknown>
  readonly historical: boolean
  readonly receipt?: ChildToolReplayReceipt | ChildWaitReplayReceipt
}

export type ChildToolCallIdProjection = {
  readonly snapshot: StepContextSnapshot
  /** Request-local map used only to normalize provider output before execution. */
  readonly aliasToCanonical: ReadonlyMap<string, string>
  readonly aliasToReceipt: ReadonlyMap<string, ChildToolReplayReceipt | ChildWaitReplayReceipt>
  readonly aliasWithoutReceipt: ReadonlySet<string>
}

export function projectChildToolCallIdsForModelContext(
  snapshot: StepContextSnapshot,
  owner: TaskExecutionOwnerFence,
  stepId: string,
  receipts: readonly ChildToolReplayReceipt[] = [],
  waitReceipts: readonly ChildWaitReplayReceipt[] = [],
): ChildToolCallIdProjection {
  validateScope(owner, stepId)

  const observations: ToolCallIdObservation[] = []
  const originalIds = new Set<string>()
  const seenUnsafeIds = new Set<string>()
  for (let index = 0; index < snapshot.toolObservations.length; index += 1) {
    const content = object(snapshot.toolObservations[index]?.content)
    if (!content || !Object.hasOwn(content, "toolCallId")) continue
    const id = content.toolCallId
    if (typeof id !== "string" || id.length < 1 || id.length > 256 || !id.trim()) {
      throw new Error("child_tool_call_projection_invalid_id")
    }
    originalIds.add(id)
    const observationId = snapshot.toolObservations[index]?.id ?? ""
    const historical = observationId.startsWith("child-resume:")
    if (!isUnsafeModelId(id)) continue
    if (snapshot.toolObservations.slice(index + 1).some(item => object(item.content)?.toolCallId === id)) projectionError("child_tool_call_projection_duplicate_id")
    if (seenUnsafeIds.has(id)) projectionError("child_tool_call_projection_duplicate_id")
    seenUnsafeIds.add(id)
    const matches = [
      ...receipts.filter(receipt => childReplayReceiptMatchesObservation(receipt, owner, id, content, observationId, false)),
      ...waitReceipts.filter(receipt => childReplayReceiptMatchesObservation(receipt, owner, id, content, observationId, true)),
    ]
    if (isReservedPrefix(id) && matches.length !== 1) projectionError("child_tool_call_projection_receipt_invalid")
    if (matches.length > 1) projectionError("child_tool_call_projection_receipt_invalid")
    observations.push({ index, id, content, historical, ...(matches[0] ? { receipt: matches[0] } : {}) })
  }

  if (observations.length === 0) return { snapshot, aliasToCanonical: new Map(), aliasToReceipt: new Map(), aliasWithoutReceipt: new Set() }

  const aliases = new Map<string, string>()
  const aliasToReceipt = new Map<string, ChildToolReplayReceipt | ChildWaitReplayReceipt>()
  const aliasWithoutReceipt = new Set<string>()
  const canonicalToAlias = new Map<string, string>()
  const usedAliases = new Set<string>()
  const maxCandidates = originalIds.size * 2 + 1

  for (const observation of observations) {
    let alias: string | undefined
    const base = aliasBase(owner, stepId, observation.index)
    for (let collision = 0; collision < maxCandidates; collision += 1) {
      const candidate = base + alphaCounter(collision)
      if (originalIds.has(candidate) || usedAliases.has(candidate) || redactSensitiveText(candidate) !== candidate) continue
      alias = candidate
      break
    }
    if (!alias) projectionError("child_tool_call_projection_collision_limit")
    aliases.set(alias, observation.id)
    if (observation.receipt) aliasToReceipt.set(alias, observation.receipt)
    else if (observation.historical) aliasWithoutReceipt.add(alias)
    canonicalToAlias.set(observation.id, alias)
    usedAliases.add(alias)
  }

  const toolObservations = snapshot.toolObservations.map(observation => {
    const content = object(observation.content)
    if (!content || typeof content.toolCallId !== "string") return observation
    const alias = canonicalToAlias.get(content.toolCallId)
    return alias ? {
      ...observation,
      id: "tool-call-observation:" + alias,
      content: { ...content, toolCallId: alias },
    } : observation
  })
  return { snapshot: { ...snapshot, toolObservations }, aliasToCanonical: aliases, aliasToReceipt, aliasWithoutReceipt }
}

export function normalizeProjectedToolCallIds<TCall extends { readonly id: string }>(
  calls: readonly TCall[],
  projection: ChildToolCallIdProjection,
): readonly TCall[] {
  const normalizedIds = new Set<string>()
  return calls.map(call => {
    if (typeof call.id !== "string" || call.id.length < 1 || call.id.length > 256 || !call.id.trim()) {
      projectionError("child_tool_call_projection_invalid_model_id")
    }
    const canonicalId = projection.aliasToCanonical.get(call.id)
    if (canonicalId === undefined && isReservedPrefix(call.id)) {
      projectionError("child_tool_call_projection_unknown_alias")
    }
    if (projection.aliasWithoutReceipt.has(call.id)) projectionError("child_tool_call_projection_receipt_invalid")
    if (canonicalId !== undefined && projection.aliasToReceipt.has(call.id)) {
      const receipt = projection.aliasToReceipt.get(call.id)!
      const candidate = call as TCall & { readonly name?: unknown; readonly arguments?: unknown }
      if (candidate.name !== receipt.toolName || !childReplayReceiptMatchesInput(receipt, candidate.arguments)) projectionError("child_tool_call_projection_receipt_invalid")
    }
    const id = canonicalId ?? call.id
    if (normalizedIds.has(id)) projectionError("child_tool_call_projection_duplicate_model_id")
    normalizedIds.add(id)
    return id === call.id ? call : { ...call, id }
  })
}

export function scopeChildExecutionReceipts(
  tools: readonly ChildToolReplayReceipt[], waits: readonly ChildWaitReplayReceipt[], saved: readonly PersistedToolExecutionReceipt[],
  owner: TaskExecutionOwnerFence, stepId: string,
): readonly [readonly ChildToolReplayReceipt[], readonly ChildWaitReplayReceipt[]] {
  const current = saved.flatMap(receipt => receipt.toolName === "wait_subagents" || receipt.result.status === "cancelled"
    || !validText(receipt.callItem.id) || !validRevision(receipt.callItem.revision) || !validText(receipt.resultItem.id)
    || !validRevision(receipt.resultItem.revision) || receipt.callItem.id === receipt.resultItem.id
    || receipt.result.status === "completed" && receipt.result.errorCode !== null
    || receipt.result.status === "failed" && !validErrorCode(receipt.result.errorCode) ? [] : [{
      userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
      taskId: owner.taskId, attempt: owner.attemptCount, stepId, toolCallId: receipt.toolCallId, toolName: receipt.toolName,
      input: receipt.input, callItem: receipt.callItem, resultItem: receipt.resultItem,
      result: { status: receipt.result.status, output: receipt.result.output, errorCode: receipt.result.errorCode },
    }])
  return [[...tools, ...current], waits]
}

function validateScope(owner: TaskExecutionOwnerFence, stepId: string): void {
  if (owner.kind !== "task" || owner.taskId === owner.rootTaskId
    || !validText(owner.userId) || !validText(owner.sessionId) || !validText(owner.turnId)
    || !validText(owner.taskId) || !validText(owner.rootTaskId) || !validText(owner.ownerId)
    || !Number.isSafeInteger(owner.attemptCount) || owner.attemptCount < 1
    || !(owner.leaseExpiresAt instanceof Date) || !Number.isFinite(owner.leaseExpiresAt.getTime())
    || !validText(stepId)) {
    projectionError("child_tool_call_projection_scope_invalid")
  }
}

function projectionError(code: string): never { throw new TurnEngineError("invalid_output", code) }

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim().length > 0
}

function aliasBase(owner: TaskExecutionOwnerFence, stepId: string, observationIndex: number): string {
  const scope = JSON.stringify([
    "agent-harness.v2.child-tool-call-id-alias",
    owner.userId,
    owner.sessionId,
    owner.turnId,
    owner.rootTaskId,
    owner.taskId,
    owner.attemptCount,
    stepId,
    observationIndex,
  ])
  const digest = createHash("sha256").update(scope, "utf8").digest()
  let letters = ""
  for (const byte of digest) {
    letters += HEX_NIBBLE_ALPHABET[byte >> 4] + HEX_NIBBLE_ALPHABET[byte & 0x0f]
  }
  return ALIAS_PREFIX + letters
}

function alphaCounter(value: number): string {
  let remaining = value
  let result = ""
  do {
    result = COUNTER_ALPHABET[remaining % COUNTER_ALPHABET.length] + result
    remaining = Math.floor(remaining / COUNTER_ALPHABET.length) - 1
  } while (remaining >= 0)
  return result
}

function isUnsafeModelId(value: string): boolean {
  return redactSensitiveText(value) !== value || isReservedPrefix(value)
}

function isReservedPrefix(value: string): boolean {
  return value.startsWith(ALIAS_PREFIX)
}

function validRevision(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 }
function validErrorCode(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) }
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
