import { describe, expect, it } from "vitest"
import { redactSensitiveText } from "@jobcopilot/shared"
import type { TaskExecutionOwnerFence } from "../execution-owner.js"
import type { ChildWaitReplayReceipt } from "./turn-execution-options.js"
import { childReplayReceiptMatchesInput, childReplayReceiptMatchesObservation } from "./turn-child-replay-receipt-proof.js"

const RAW_KEY = "Bearer abcdefghijklmnop"
const SAFE_INPUT = {
  idempotencyKey: redactSensitiveText(RAW_KEY),
  taskIds: ["child-leaf"],
  mode: "all",
  timeoutMs: 5_000,
}
const RAW_INPUT = { ...SAFE_INPUT, idempotencyKey: RAW_KEY }
const TOOL_CALL_ID = "toolcall-source-1"
const OWNER: TaskExecutionOwnerFence = {
  kind: "task",
  userId: "user-1",
  sessionId: "session-1",
  turnId: "turn-1",
  taskId: "child-1",
  rootTaskId: "root-1",
  ownerId: "worker-a",
  attemptCount: 2,
  leaseExpiresAt: new Date("2026-10-28T10:00:00.000Z"),
}

function fixture(): { receipt: ChildWaitReplayReceipt; content: Record<string, unknown> } {
  const output = {
    waitId: "wait-1",
    status: "ready",
    taskIds: ["child-leaf"],
    deadlineAt: "2099-01-01T00:00:00.000Z",
    matchedTaskIds: ["child-leaf"],
    tasks: [],
  }
  const callItem = { id: "wait-call-item", revision: 2 }
  const resultItem = { id: "wait-result-item", revision: 3 }
  const receipt: ChildWaitReplayReceipt = {
    userId: OWNER.userId,
    sessionId: OWNER.sessionId,
    turnId: OWNER.turnId,
    rootTaskId: OWNER.rootTaskId,
    taskId: OWNER.taskId,
    attempt: 1,
    stepId: "old-step",
    toolCallId: TOOL_CALL_ID,
    toolName: "wait_subagents",
    input: RAW_INPUT,
    callItem,
    resultItem,
    result: { status: "completed", output, errorCode: null },
    waitId: "wait-1",
    source: {
      attempt: 1,
      stepId: "old-step",
      ordinal: 2,
      toolCallId: TOOL_CALL_ID,
      sourceItemId: resultItem.id,
      callItem,
      resultItem,
      input: SAFE_INPUT,
      persistedResult: {
        status: "completed",
        output: { ...output, status: "waiting", matchedTaskIds: [] },
        errorCode: null,
      },
      continuationStepId: "continuation-step",
      continuationOrdinal: 3,
    },
  }
  return {
    receipt,
    content: {
      toolCallId: TOOL_CALL_ID,
      toolName: "wait_subagents",
      input: SAFE_INPUT,
      status: "completed",
      output,
      errorCode: null,
    },
  }
}

function matches(receipt: unknown, content: Record<string, unknown>, owner = OWNER): boolean {
  return childReplayReceiptMatchesObservation(receipt, owner, TOOL_CALL_ID, content, "child-resume:wait-result-item", true)
}

describe("child replay receipt proof", () => {
  it("accepts safe replay input when the persisted wait key is redacted", () => {
    const { receipt, content } = fixture()
    expect(SAFE_INPUT.idempotencyKey).not.toBe(RAW_KEY)
    expect(matches(receipt, content)).toBe(true)
    expect(childReplayReceiptMatchesInput(receipt, SAFE_INPUT)).toBe(true)
  })

  it("rejects a safe source key that does not match the raw receipt key", () => {
    const { receipt, content } = fixture()
    const mismatched = { ...receipt, source: { ...receipt.source, input: { ...SAFE_INPUT, idempotencyKey: "wrong-key" } } }
    expect(matches(mismatched, content)).toBe(false)
  })

  it("rejects model arguments changed from the safe receipt input", () => {
    const { receipt } = fixture()
    expect(childReplayReceiptMatchesInput(receipt, { ...SAFE_INPUT, idempotencyKey: "wrong-key" })).toBe(false)
  })

  it("rejects owner, source item, and revision mismatches", () => {
    const { receipt, content } = fixture()
    expect(matches(receipt, content, { ...OWNER, userId: "other-user" })).toBe(false)
    const wrongItem = { ...receipt, source: { ...receipt.source, resultItem: { ...receipt.resultItem, id: "other-result" } } }
    expect(matches(wrongItem, content)).toBe(false)
    const badRevision = {
      ...receipt,
      callItem: { ...receipt.callItem, revision: -1 },
      source: { ...receipt.source, callItem: { ...receipt.source.callItem, revision: -1 } },
    }
    expect(matches(badRevision, content)).toBe(false)
  })
})
