import { describe, expect, it } from "vitest"
import { redactSensitiveText } from "@jobcopilot/shared"
import type { TaskExecutionOwnerFence } from "../execution-owner.js"
import type { ContextSeedBlock, StepContext, StepContextSnapshot } from "../context/step-context-builder.js"
import { contextToModelMessages } from "./turn-engine-messages.js"
import {
  normalizeProjectedToolCallIds,
  projectChildToolCallIdsForModelContext,
} from "./turn-tool-call-id-projection.js"

const PHONE_ID = "provider-call:+14155550134"
const EMAIL_ID = "provider-call:person@example.invalid"
const TOKEN_ID = "Bearer abcdefghijklmnop"
const STEP_ID = "task-step:3:attempt:1"

function owner(overrides: Partial<TaskExecutionOwnerFence> = {}): TaskExecutionOwnerFence {
  return {
    kind: "task", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "child-1",
    rootTaskId: "root-1", ownerId: "worker-a", attemptCount: 1, leaseExpiresAt: new Date("2026-10-28T10:00:00.000Z"),
    ...overrides,
  }
}

function observation(toolCallId: string, id: string): ContextSeedBlock {
  return { id, content: { toolCallId, toolName: "wait_subagents", input: { mode: "any" }, status: "completed", output: { ready: true } } }
}

function snapshot(toolObservations: readonly ContextSeedBlock[]): StepContextSnapshot {
  return { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations }
}

function stepContext(value: StepContextSnapshot): StepContext {
  const blocks: StepContext["blocks"] = value.toolObservations.map(item => ({
    id: "observation:" + item.id, layer: "tool_observation", role: "data",
    trust: "external_untrusted", source: "tool_or_subagent", content: item.content as StepContext["blocks"][number]["content"],
  }))
  return {
    schemaVersion: "agent-harness.v2", sessionId: "session-1", turnId: "turn-1", stepId: STEP_ID,
    inputThroughSequence: 0n, consumedInputIds: [], blocks, canonicalJson: JSON.stringify({ blocks }),
  }
}

describe("child model-context tool-call ID projection", () => {
  it("aliases redacted IDs in a copied snapshot and keeps both model message edges paired", () => {
    const original = snapshot([
      observation(PHONE_ID, "child-resume:source:" + PHONE_ID),
      observation(EMAIL_ID, "child-resume:source:" + EMAIL_ID),
      observation(TOKEN_ID, "child-resume:source:" + TOKEN_ID),
      observation("provider-call-safe-42", "safe-result"),
    ])
    const projected = projectChildToolCallIdsForModelContext(original, owner(), STEP_ID)
    const projectedIds = projected.snapshot.toolObservations.map(item =>
      (item.content as Record<string, unknown>).toolCallId as string,
    )
    const aliases = [projectedIds[0]!, projectedIds[1]!, projectedIds[2]!]
    expect(aliases).toHaveLength(3)
    expect(new Set(aliases).size).toBe(3)
    for (const alias of aliases) {
      expect(alias).toMatch(/^toolcall[a-p]{64}[a-z]+$/)
      expect(redactSensitiveText(alias)).toBe(alias)
    }
    expect(projected.aliasToCanonical).toEqual(new Map([
      [projectedIds[0]!, PHONE_ID], [projectedIds[1]!, EMAIL_ID], [projectedIds[2]!, TOKEN_ID],
    ]))
    expect(projectedIds[3]).toBe("provider-call-safe-42")
    expect((original.toolObservations[0]!.content as Record<string, unknown>).toolCallId).toBe(PHONE_ID)

    const context = stepContext(projected.snapshot)
    const messages = contextToModelMessages(context)
    const useIds = messages.flatMap(message => message.content.flatMap(part =>
      part.type === "tool_use" ? [part.id] : [],
    ))
    const resultIds = messages.flatMap(message => message.content.flatMap(part =>
      part.type === "tool_result" ? [part.toolUseId] : [],
    ))
    expect(useIds).toEqual(projectedIds)
    expect(resultIds).toEqual(projectedIds)
    const serializedContext = JSON.stringify({ canonicalJson: context.canonicalJson, messages })
    for (const rawId of [PHONE_ID, EMAIL_ID, TOKEN_ID]) expect(serializedContext).not.toContain(rawId)
    expect(JSON.stringify(projected.snapshot)).not.toContain(PHONE_ID)
  })

  it("derives the same aliases across lease-owner changes and isolates different child scopes", () => {
    const original = snapshot([observation(PHONE_ID, "phone-result")])
    const workerA = projectChildToolCallIdsForModelContext(original, owner(), STEP_ID)
    const workerB = projectChildToolCallIdsForModelContext(original, owner({
      ownerId: "worker-b", leaseExpiresAt: new Date("2026-10-28T10:05:00.000Z"),
    }), STEP_ID)
    expect(workerB.snapshot.toolObservations).toEqual(workerA.snapshot.toolObservations)

    const otherScope = projectChildToolCallIdsForModelContext(original, owner({
      userId: "user-2", sessionId: "session-2", turnId: "turn-2", rootTaskId: "root-2", taskId: "child-2",
    }), STEP_ID)
    const workerAAlias = [...workerA.aliasToCanonical.keys()][0]!
    const otherScopeAlias = [...otherScope.aliasToCanonical.keys()][0]!
    expect(otherScopeAlias).not.toBe(workerAAlias)
    expect(() => normalizeProjectedToolCallIds([{ id: workerAAlias }], otherScope.aliasToCanonical))
      .toThrow("child_tool_call_projection_unknown_alias")
  })

  it("resolves a candidate colliding with any current raw ID and rejects duplicate unsafe observations", () => {
    const original = snapshot([observation(PHONE_ID, "phone-result")])
    const firstCandidate = [...projectChildToolCallIdsForModelContext(original, owner(), STEP_ID).aliasToCanonical.keys()][0]!
    const colliding = snapshot([
      observation(PHONE_ID, "phone-result"),
      observation(firstCandidate, "alias-shaped-raw-result"),
    ])
    const projected = projectChildToolCallIdsForModelContext(colliding, owner(), STEP_ID)
    const phoneAlias = [...projected.aliasToCanonical.entries()].find(([, raw]) => raw === PHONE_ID)?.[0]
    expect(phoneAlias).toBeDefined()
    expect(phoneAlias).not.toBe(firstCandidate)
    expect(projected.aliasToCanonical.get(firstCandidate)).toBeUndefined()
    expect(projected.snapshot.toolObservations.map(item =>
      (item.content as Record<string, unknown>).toolCallId as string,
    )).toEqual([...projected.aliasToCanonical.keys()])

    expect(() => projectChildToolCallIdsForModelContext(snapshot([
      observation(PHONE_ID, "first"), observation(PHONE_ID, "duplicate"),
    ]), owner(), STEP_ID)).toThrow("child_tool_call_projection_duplicate_id")
  })

  it("preserves more than 257 long-lived observations with mixed unsafe and safe IDs", () => {
    const source = Array.from({ length: 258 }, (_, index) => {
      const unsafe = index % 2 === 0
      const id = unsafe
        ? `provider-call:+1${4155550100 + index}`
        : `provider-call-safe-${index}`
      if (unsafe) expect(redactSensitiveText(id)).not.toBe(id)
      return observation(id, `observation-${index}`)
    })
    const original = snapshot(source)
    const projected = projectChildToolCallIdsForModelContext(original, owner(), STEP_ID)
    const projectedIds = projected.snapshot.toolObservations.map(item =>
      (item.content as Record<string, unknown>).toolCallId as string,
    )

    expect(projected.snapshot.toolObservations).toHaveLength(258)
    expect(projected.aliasToCanonical).toHaveProperty("size", 129)
    expect(projectedIds).toHaveLength(258)
    for (let index = 0; index < 258; index += 1) {
      const rawId = (source[index]!.content as Record<string, unknown>).toolCallId as string
      if (index % 2 === 0) {
        expect(projected.aliasToCanonical.get(projectedIds[index]!)).toBe(rawId)
      } else {
        expect(projectedIds[index]).toBe(rawId)
      }
    }
    expect(original.toolObservations).toEqual(source)
  })

  it("maps returned aliases back once, while rejecting duplicate, unknown, malformed, and root-scoped IDs", () => {
    const projection = projectChildToolCallIdsForModelContext(snapshot([observation(PHONE_ID, "phone-result")]), owner(), STEP_ID)
    const alias = [...projection.aliasToCanonical.keys()][0]!
    expect(normalizeProjectedToolCallIds([{ id: alias, name: "wait_subagents" }], projection.aliasToCanonical))
      .toEqual([{ id: PHONE_ID, name: "wait_subagents" }])
    expect(() => normalizeProjectedToolCallIds([{ id: alias }, { id: PHONE_ID }], projection.aliasToCanonical))
      .toThrow("child_tool_call_projection_duplicate_model_id")
    expect(() => normalizeProjectedToolCallIds([{ id: "toolcall" + "a".repeat(64) + "a" }], new Map()))
      .toThrow("child_tool_call_projection_unknown_alias")
    expect(() => projectChildToolCallIdsForModelContext(snapshot([observation("", "bad")]), owner(), STEP_ID))
      .toThrow("child_tool_call_projection_invalid_id")
    expect(() => projectChildToolCallIdsForModelContext(snapshot([observation("x".repeat(257), "too-long")]), owner(), STEP_ID))
      .toThrow("child_tool_call_projection_invalid_id")
    expect(() => projectChildToolCallIdsForModelContext(snapshot([observation(PHONE_ID, "phone-result")]), owner({
      taskId: "root-1",
    }), STEP_ID)).toThrow("child_tool_call_projection_scope_invalid")
  })
})
