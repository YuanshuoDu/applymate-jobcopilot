import { describe, expect, it } from "vitest"

import { issueNativeQuestionControlReceipt } from "./native-question-attestation.js"
import type { ToolCallRecovery, TurnEngineToolResult } from "./turn-engine-types.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"
import { persistRecoveredToolCall } from "./turn-execution-tool-recovery.js"

const identity = { kind: "turn" as const, userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1",
  ownerId: "worker-1", leaseVersion: 1, leaseExpiresAt: new Date("2026-11-05T12:00:00Z") }
const callInput = { question: "Which city?", choices: [{ label: "Berlin", value: "berlin" }] }
const intent = { schemaVersion: "agent-harness.v2.ask-user-intent.v1", kind: "user_question", stage: "user_input", question: "Which city?", options: callInput.choices }

function fixture(result: TurnEngineToolResult) {
  const itemContents: unknown[] = [], eventContents: unknown[] = [], eventPayloads: unknown[] = []
  const writer = {
    completeItem: async (_handle: unknown, content: unknown, _now: Date, _key: string, eventContent?: unknown) => {
      itemContents.push(content); eventContents.push(eventContent)
    },
    append: async (_type: string, _correlationId: string, _itemId: string | null, payload: unknown) => { eventPayloads.push(payload); return "event-1" },
    startItem: async (input: { content: unknown }) => { itemContents.push(input.content); return { id: "result-item", type: "tool_result", phase: null, revision: 0 } },
  }
  const recovery: ToolCallRecovery = { action: "replay", stepId: "step-1", toolVersion: "1", call: { id: "call-1", name: "agent.ask_user", arguments: callInput },
    callItem: { id: "call-item", revision: 0 }, resultItem: { id: "result-item", revision: 0 } }
  return { itemContents, eventContents, eventPayloads, writer, recovery,
    options: { identity, idFactory: (prefix: string) => prefix } as unknown as TurnExecutionOptions, result }
}

describe("persistRecoveredToolCall native question boundary", () => {
  it("keeps the server attestation and call input private while persisting redacted event output", async () => {
    const receipt = issueNativeQuestionControlReceipt({
      identity: { userId: identity.userId, sessionId: identity.sessionId, turnId: identity.turnId, stepId: "step-1", taskId: identity.taskId, rootTaskId: identity.rootTaskId },
      actorRole: "orchestrator", capabilities: ["canManageChildren"],
      toolCallId: "call-1", toolName: "agent.ask_user", toolVersion: "1", requestInput: callInput, effectiveInput: callInput, toolOutput: intent,
    })!
    expect(receipt).toBeTruthy()
    const test = fixture({ id: "call-1", toolName: "agent.ask_user", toolVersion: "1", status: "completed",
      output: { question: "[REDACTED]", choices: [] }, errorCode: null, nativeQuestionReceipt: receipt })

    await expect(persistRecoveredToolCall(test.options, test.writer as never, test.recovery, test.result, () => new Date()))
      .resolves.toMatchObject({ output: { question: "[REDACTED]", choices: [] } })
    expect(JSON.stringify(test.itemContents)).toContain("nativeQuestionAttestation")
    expect(JSON.stringify(test.itemContents)).toContain("Which city?")
    expect(JSON.stringify(test.eventContents)).not.toContain("Which city?")
    expect(JSON.stringify(test.eventPayloads)).not.toContain("Which city?")
    expect(JSON.stringify({ eventContents: test.eventContents, eventPayloads: test.eventPayloads })).not.toContain("nativeQuestionAttestation")
    expect(JSON.stringify(test.eventContents)).not.toContain("berlin")
  })

  it("rejects a completed replay without the unforgeable Router receipt before writes", async () => {
    const test = fixture({ id: "call-1", toolName: "agent.ask_user", toolVersion: "1", status: "completed",
      output: { question: "[REDACTED]", choices: [] }, errorCode: null })
    await expect(persistRecoveredToolCall(test.options, test.writer as never, test.recovery, test.result, () => new Date()))
      .rejects.toMatchObject({ code: "invalid_output" })
    expect(test.itemContents).toEqual([])
    expect(test.eventContents).toEqual([])
    expect(test.eventPayloads).toEqual([])
  })
})
