import type pg from "pg"
import { describe, expect, it } from "vitest"

import type { CanonicalToolSourceName } from "./tool-result-reference-types.js"
import { findCanonicalToolSource, prepareSourceToolResultJson, type CanonicalToolSource } from "./tool-result-reference-source.js"

const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "child-1", stepId: "step-1", toolCallId: "call-1" }
const source: CanonicalToolSource = {
  toolName: "wait_subagents" as CanonicalToolSourceName,
  taskAttemptCount: 2,
  role: "analyst",
  taskType: "research",
  ownerKind: "task",
}

function validWaitOutput(waitId: string) {
  const taskId = "subagent-12345678-1234-4234-9234-123456789012"
  return {
    waitId, status: "ready", taskIds: [taskId], deadlineAt: "2026-10-04T12:00:00.000Z", matchedTaskIds: [taskId],
    tasks: [{ taskId, status: "completed", role: "scout", result: { finding: "safe" }, failureReason: null }],
  }
}

function sourceClient(rows: unknown[]) {
  const calls: Array<{ text: string; values: readonly unknown[] }> = []
  const client = {
    async query<T>(text: string, values: readonly unknown[] = []) {
      calls.push({ text, values })
      return { rows: rows as T[] }
    },
  } as unknown as Pick<pg.PoolClient, "query">
  return { client, calls }
}

describe("tool result reference source provenance", () => {
  it("scopes the canonical tool call lookup to the full persisted owner and rejects duplicate rows", async () => {
    const row = { toolName: "wait_subagents", taskAttemptCount: 2, role: "analyst", taskType: "research", ownerKind: "task" }
    const { client, calls } = sourceClient([row])

    await expect(findCanonicalToolSource(client, scope)).resolves.toEqual({ ...row, toolName: source.toolName })
    expect(calls[0]?.values).toEqual(["session-1", "turn-1", "child-1", "step-1", "call-1", "user-1"])
    expect(calls[0]?.text).toContain('item."content"->>\'toolCallId\' = $5')
    expect(calls[0]?.text).toContain("LIMIT 2")
    await expect(findCanonicalToolSource(sourceClient([row, row]).client, scope)).resolves.toBeNull()
  })

  it("fails closed when persisted source metadata is malformed", async () => {
    const malformed = [
      { toolName: null, taskAttemptCount: 2, role: "analyst", taskType: "research", ownerKind: "task" },
      { toolName: "wait_subagents", taskAttemptCount: -1, role: "analyst", taskType: "research", ownerKind: "task" },
      { toolName: "wait_subagents", taskAttemptCount: 2, role: "analyst", taskType: "research", ownerKind: "root" },
    ]
    for (const row of malformed) await expect(findCanonicalToolSource(sourceClient([row]).client, scope)).resolves.toBeNull()
  })

  it("prepares wait references using the source owner kind and rejects a mismatched ID namespace", () => {
    const childId = "12345678-1234-4234-9234-123456789012"
    const rootId = `wait-${childId}`
    const makeError = (code: string) => new Error(code)

    expect(prepareSourceToolResultJson(validWaitOutput(childId), source, "child-1", makeError).value).toMatchObject({ waitId: childId })
    expect(() => prepareSourceToolResultJson(validWaitOutput(rootId), source, "child-1", makeError)).toThrow("tool_result_invalid_json")
    expect(() => prepareSourceToolResultJson(validWaitOutput(childId), { ...source, ownerKind: "turn" }, "child-1", makeError)).toThrow("tool_result_invalid_json")
  })

  it("maps oversize source output to the repository error code", () => {
    const makeError = (code: string) => new Error(code)
    expect(() => prepareSourceToolResultJson({ text: "x".repeat(1_048_577) }, { ...source, toolName: "notes.read" as CanonicalToolSourceName }, "child-1", makeError))
      .toThrow("tool_result_too_large")
  })
})
