import { describe, expect, it } from "vitest"

import type { TaskGraphNativeCommandInput } from "./task-graph-command-port.js"
import { normalizeNativeCommand } from "./task-graph-native-request.js"

const scope: TaskGraphNativeCommandInput["scope"] = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "step-1", turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "root-owner", parentAttemptCount: 1,
}

describe("native TaskGraph request normalization", () => {
  it("normalizes defaults and fingerprints all caller fields plus the trusted output contract", () => {
    const input: TaskGraphNativeCommandInput = {
      scope,
      request: {
        kind: "spawn", idempotencyKey: "native-1", role: "scout", taskType: "job-search", goal: "Find jobs",
        constraints: ["Europe only"], successCriteria: ["Return evidence"], allowedActions: ["read_jobs"], context: { b: 2, a: 1 },
      },
      outputSchemaMarker: { schemaVersion: "agent-harness.v2.subagent.result", role: "scout" },
    }
    const normalized = normalizeNativeCommand(input)
    const reordered = normalizeNativeCommand({
      ...input, request: { ...input.request, context: { a: 1, b: 2 } },
    })

    expect(normalized.requestFingerprint).toBe(reordered.requestFingerprint)
    expect(normalized.request).toMatchObject({
      constraints: ["Europe only"], successCriteria: ["Return evidence"], allowedActions: ["read_jobs"], context: { a: 1, b: 2 },
    })
    expect(normalized.outputSchemaMarker).toEqual({ schemaVersion: "agent-harness.v2.subagent.result", role: "scout" })
    expect(normalized.eventIdempotencyKey).toMatch(/^task-graph-[a-f0-9]{64}:native:[a-f0-9]{64}$/)
    const otherKind = normalizeNativeCommand({
      scope, request: { kind: "followup", idempotencyKey: "native-1", sourceTaskId: "source", goal: "Refine" },
    })
    expect(otherKind.eventIdempotencyKey).toBe(normalized.eventIdempotencyKey)
    expect(otherKind.requestFingerprint).not.toBe(normalized.requestFingerprint)
  })

  it("includes follow-up source identity in the stable caller fingerprint", () => {
    const base: TaskGraphNativeCommandInput = {
      scope, request: { kind: "followup", idempotencyKey: "refine-1", sourceTaskId: "source-a", goal: "Refine" },
    }
    const changed: TaskGraphNativeCommandInput = {
      scope, request: { kind: "followup", idempotencyKey: "refine-1", sourceTaskId: "source-b", goal: "Refine" },
    }
    expect(normalizeNativeCommand(base).requestFingerprint)
      .not.toBe(normalizeNativeCommand(changed).requestFingerprint)
  })

  it("fingerprints explicit unstarted replacement mode and revision while keeping legacy follow-up shape unchanged", () => {
    const legacy = normalizeNativeCommand({
      scope, request: { kind: "followup", idempotencyKey: "replace-source", sourceTaskId: "source", goal: "Continue" },
    })
    const replacementInput = {
      scope,
      request: {
        kind: "followup" as const, idempotencyKey: "replace-source", sourceTaskId: "source", goal: "Continue",
        mode: "replace_unstarted" as const, expectedRevision: 0,
      },
    }
    const replacement = normalizeNativeCommand(replacementInput)
    const staleRevision = normalizeNativeCommand({
      ...replacementInput, request: { ...replacementInput.request, expectedRevision: 1 },
    })

    expect(legacy.request).not.toHaveProperty("mode")
    expect(legacy.request).not.toHaveProperty("expectedRevision")
    expect(replacement.request).toMatchObject({ mode: "replace_unstarted", expectedRevision: 0 })
    expect(replacement.operationId).toBe(legacy.operationId)
    expect(replacement.eventIdempotencyKey).toBe(legacy.eventIdempotencyKey)
    expect(replacement.requestFingerprint).not.toBe(legacy.requestFingerprint)
    expect(staleRevision.requestFingerprint).not.toBe(replacement.requestFingerprint)
  })

  it.each([
    { mode: "replace_unstarted" },
    { expectedRevision: 0 },
    { mode: "replace_unstarted", expectedRevision: -1 },
    { mode: "replace_unstarted", expectedRevision: 2_147_483_645 },
    { mode: "other", expectedRevision: 0 },
    { mode: "replace_unstarted", expectedRevision: 0, constraints: ["untrusted override"] },
    { mode: "replace_unstarted", expectedRevision: 0, successCriteria: ["untrusted override"] },
  ])("rejects malformed native replacement discriminators %#", replacement => {
    const input = {
      scope,
      request: { kind: "followup" as const, idempotencyKey: "replace-invalid", sourceTaskId: "source", goal: "Continue", ...replacement },
    }
    expect(() => normalizeNativeCommand(input as unknown as TaskGraphNativeCommandInput))
      .toThrow("task_graph_native_input_invalid")
  })

  it("does not normalize caller-supplied replacement ownership or policy fields", () => {
    const input = {
      scope,
      request: {
        kind: "followup" as const, idempotencyKey: "replace-forged", sourceTaskId: "source", goal: "Continue",
        mode: "replace_unstarted" as const, expectedRevision: 0, rootTaskId: "forged-root",
      },
    }
    expect(() => normalizeNativeCommand(input as unknown as TaskGraphNativeCommandInput))
      .toThrow("task_graph_native_input_invalid")
  })

  it("rejects unsupported marker contracts and non-JSON caller context instead of silently dropping fields", () => {
    const followup: TaskGraphNativeCommandInput = {
      scope, request: { kind: "followup", idempotencyKey: "refine-1", sourceTaskId: "source-a", goal: "Refine" },
      outputSchemaMarker: { schemaVersion: "agent-harness.v2.subagent.result", role: "scout" },
    }
    const spawn: TaskGraphNativeCommandInput = {
      scope, request: { kind: "spawn", idempotencyKey: "native-1", role: "auditor", taskType: "audit", goal: "Review", context: { token: undefined } },
    }

    expect(() => normalizeNativeCommand(followup)).toThrow("task_graph_native_input_invalid")
    expect(() => normalizeNativeCommand(spawn)).toThrow("task_graph_native_input_invalid")
  })

  it.each([
    { allowedActions: Array.from({ length: 33 }, () => "read") },
    { allowedActions: ["x".repeat(1_001)] },
    { allowedActions: [""] },
  ])("validates spawn allowedActions with bounded string-list rules", ({ allowedActions }) => {
    const invalidActions: TaskGraphNativeCommandInput = {
      scope, request: {
        kind: "spawn", idempotencyKey: "native-actions", role: "auditor", taskType: "audit", goal: "Review",
        allowedActions,
      },
    }
    expect(() => normalizeNativeCommand(invalidActions)).toThrow("task_graph_native_input_invalid")
  })

  it("preserves an own __proto__ context property as data", () => {
    const context = JSON.parse('{"__proto__":{"polluted":true},"safe":"value"}') as unknown
    const spawn: TaskGraphNativeCommandInput = {
      scope, request: {
        kind: "spawn", idempotencyKey: "native-context", role: "auditor", taskType: "audit", goal: "Review", context,
      },
    }

    const normalized = normalizeNativeCommand(spawn).request.context as Record<string, unknown>
    expect(Object.hasOwn(normalized, "__proto__")).toBe(true)
    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype)
    expect(normalized.__proto__).toEqual({ polluted: true })
  })
})
