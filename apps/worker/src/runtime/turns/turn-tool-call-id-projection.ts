import { createHash } from "node:crypto"
import { redactSensitiveText } from "@jobcopilot/shared"
import type { TaskExecutionOwnerFence } from "../execution-owner.js"
import type { StepContextSnapshot } from "../context/step-context-builder.js"

// The full prefix is reserved; only exact entries in a request-local alias map are accepted.
const ALIAS_PREFIX = "toolcall"
const HEX_NIBBLE_ALPHABET = "abcdefghijklmnop"
const COUNTER_ALPHABET = "abcdefghijklmnopqrstuvwxyz"

type ToolCallIdObservation = {
  readonly index: number
  readonly id: string
}

export type ChildToolCallIdProjection = {
  readonly snapshot: StepContextSnapshot
  /** Request-local map used only to normalize provider output before execution. */
  readonly aliasToCanonical: ReadonlyMap<string, string>
}

export function projectChildToolCallIdsForModelContext(
  snapshot: StepContextSnapshot,
  owner: TaskExecutionOwnerFence,
  stepId: string,
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
    if (!isUnsafeModelId(id)) continue
    if (seenUnsafeIds.has(id)) throw new Error("child_tool_call_projection_duplicate_id")
    seenUnsafeIds.add(id)
    observations.push({ index, id })
  }

  if (observations.length === 0) return { snapshot, aliasToCanonical: new Map() }

  const aliases = new Map<string, string>()
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
    if (!alias) throw new Error("child_tool_call_projection_collision_limit")
    aliases.set(alias, observation.id)
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
  return { snapshot: { ...snapshot, toolObservations }, aliasToCanonical: aliases }
}

/** Arbitrary provider IDs in the reserved namespace fail unless exactly mapped for this request. */
export function normalizeProjectedToolCallIds<TCall extends { readonly id: string }>(
  calls: readonly TCall[],
  aliasToCanonical: ReadonlyMap<string, string>,
): readonly TCall[] {
  const normalizedIds = new Set<string>()
  return calls.map(call => {
    if (typeof call.id !== "string" || call.id.length < 1 || call.id.length > 256 || !call.id.trim()) {
      throw new Error("child_tool_call_projection_invalid_model_id")
    }
    const canonicalId = aliasToCanonical.get(call.id)
    if (canonicalId === undefined && isReservedAliasNamespace(call.id)) {
      // Provider IDs are arbitrary; output IDs alone cannot prove provenance for an unmapped collision.
      throw new Error("child_tool_call_projection_unknown_alias")
    }
    const id = canonicalId ?? call.id
    if (normalizedIds.has(id)) throw new Error("child_tool_call_projection_duplicate_model_id")
    normalizedIds.add(id)
    return id === call.id ? call : { ...call, id }
  })
}

function validateScope(owner: TaskExecutionOwnerFence, stepId: string): void {
  if (owner.kind !== "task" || owner.taskId === owner.rootTaskId
    || !validText(owner.userId) || !validText(owner.sessionId) || !validText(owner.turnId)
    || !validText(owner.taskId) || !validText(owner.rootTaskId) || !validText(owner.ownerId)
    || !Number.isSafeInteger(owner.attemptCount) || owner.attemptCount < 1
    || !(owner.leaseExpiresAt instanceof Date) || !Number.isFinite(owner.leaseExpiresAt.getTime())
    || !validText(stepId)) {
    throw new Error("child_tool_call_projection_scope_invalid")
  }
}

function validText(value: string): boolean {
  return value.length > 0 && value.length <= 256 && value.trim().length > 0
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
  return redactSensitiveText(value) !== value || isReservedAliasNamespace(value)
}

function isReservedAliasNamespace(value: string): boolean {
  return value.startsWith(ALIAS_PREFIX)
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
