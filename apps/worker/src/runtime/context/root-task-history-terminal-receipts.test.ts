import { describe, expect, it } from "vitest"
import {
  isHistoryReceiptText,
  parseHistoryReceiptSequence,
  validateHistoryStartReceipt,
  validateHistoryTerminalReceipt,
} from "./root-task-history-terminal-receipts.js"

type Row = Record<string, unknown>
const turnId = "turn-1"
const rootTaskId = "root-1"
const sessionId = "session-1"
const stepId = "step-1"
const prefix = "turn:" + turnId + ":event:"

function startReceipt(overrides: Row = {}): Row {
  return {
    startEventCount: 1, startTurnId: turnId, startTaskId: rootTaskId, startItemId: null,
    startType: "turn.started", startActor: "orchestrator", startCorrelationId: turnId,
    startIdempotencyKey: prefix + "turn-started", startSequence: "90",
    startPayload: { taskId: rootTaskId, rootTaskId }, ...overrides,
  }
}

function completedReceipt(overrides: Row = {}): Row {
  return {
    sessionId, terminalEventCount: 1, terminalTurnId: turnId, terminalTaskId: rootTaskId,
    terminalActor: "orchestrator", terminalType: "turn.completed", terminalItemId: "final-1",
    terminalSequence: "200", terminalCorrelationId: stepId, terminalStepId: stepId,
    terminalStepSessionId: sessionId, terminalStepTurnId: turnId, terminalStepTaskId: rootTaskId,
    terminalStepStatus: "completed", terminalStepEventCount: 1,
    terminalStepEventSessionId: sessionId, terminalStepEventTurnId: turnId,
    terminalStepEventTaskId: rootTaskId, terminalStepEventItemId: null,
    terminalStepEventSequence: "100", terminalStepEventType: "step.completed",
    terminalStepEventActor: "orchestrator", terminalStepEventCorrelationId: stepId,
    terminalStepEventIdempotencyKey: prefix + "step-completed:" + stepId,
    terminalStepEventPayload: { stepId, status: "completed", taskId: rootTaskId },
    terminalIdempotencyKey: prefix + "turn-completed",
    terminalPayload: { turnId, taskId: rootTaskId, finalItemId: "final-1" },
    ...overrides,
  }
}

function failedReceipt(overrides: Row = {}): Row {
  return {
    terminalEventCount: 1, terminalTurnId: turnId, terminalTaskId: rootTaskId,
    terminalActor: "orchestrator", terminalType: "turn.failed", terminalItemId: null,
    terminalSequence: "200", terminalCorrelationId: turnId,
    terminalIdempotencyKey: prefix + "turn-failed:timeout",
    terminalPayload: { turnId, taskId: rootTaskId, errorCode: "timeout", finalItemId: null },
    ...overrides,
  }
}

function interruptedReceipt(overrides: Row = {}): Row {
  return {
    terminalEventCount: 1, terminalTurnId: turnId, terminalTaskId: rootTaskId,
    terminalActor: "orchestrator", terminalType: "turn.interrupted", terminalItemId: null,
    terminalSequence: "200", terminalCorrelationId: turnId,
    terminalIdempotencyKey: prefix + "turn-interrupted",
    terminalPayload: { turnId, taskId: rootTaskId, errorCode: "interrupted" },
    ...overrides,
  }
}

describe("Root history terminal receipts", () => {
  it("accepts positive DB sequences and rejects malformed values", () => {
    expect(parseHistoryReceiptSequence("90")).toBe(90n)
    expect(parseHistoryReceiptSequence(90n)).toBe(90n)
    for (const value of [0, 0n, -1n, "0", "-1", "1.5", "invalid", null]) {
      expect(parseHistoryReceiptSequence(value)).toBeUndefined()
    }
    expect(isHistoryReceiptText("timeout")).toBe(true)
    expect(isHistoryReceiptText("")).toBe(false)
    expect(isHistoryReceiptText(" timeout ")).toBe(false)
    expect(isHistoryReceiptText(10)).toBe(false)
  })

  it("validates one matching start event and parses its payload", () => {
    expect(validateHistoryStartReceipt(startReceipt(), turnId, rootTaskId)).toBe(90n)
    expect(validateHistoryStartReceipt(startReceipt({ startPayload: JSON.stringify({ taskId: rootTaskId, rootTaskId }) }), turnId, rootTaskId)).toBe(90n)
    for (const overrides of [
      { startEventCount: 2 },
      { startTurnId: "other-turn" },
      { startItemId: "unexpected-item" },
      { startIdempotencyKey: "wrong-key" },
      { startSequence: "0" },
      { startPayload: "{bad json" },
      { startPayload: { taskId: rootTaskId, rootTaskId: "other-root" } },
    ]) {
      expect(validateHistoryStartReceipt(startReceipt(overrides), turnId, rootTaskId)).toBeUndefined()
    }
  })

  it("requires a completed terminal to match its single in-range step receipt", () => {
    expect(validateHistoryTerminalReceipt(completedReceipt(), turnId, rootTaskId, "completed", 90n)).toBe(200n)
    const jsonPayload = completedReceipt({
      terminalPayload: JSON.stringify({ turnId, taskId: rootTaskId, finalItemId: "final-1" }),
      terminalStepEventPayload: JSON.stringify({ stepId, status: "completed", taskId: rootTaskId }),
    })
    expect(validateHistoryTerminalReceipt(jsonPayload, turnId, rootTaskId, "completed", 90n)).toBe(200n)

    for (const overrides of [
      { terminalEventCount: 2 },
      { terminalTaskId: "other-root" },
      { terminalItemId: "other-final" },
      { terminalIdempotencyKey: "wrong-key" },
      { terminalStepEventCount: 2 },
      { terminalStepEventSequence: "90" },
      { terminalStepEventSequence: "200" },
      { terminalStepEventType: "step.failed" },
      { terminalStepEventPayload: { stepId, status: "completed", taskId: rootTaskId, extra: true } },
    ]) {
      expect(validateHistoryTerminalReceipt(completedReceipt(overrides), turnId, rootTaskId, "completed", 90n)).toBeUndefined()
    }
  })

  it("validates failed and interrupted terminal shapes independently", () => {
    expect(validateHistoryTerminalReceipt(failedReceipt(), turnId, rootTaskId, "failed", 90n)).toBe(200n)
    expect(validateHistoryTerminalReceipt(interruptedReceipt(), turnId, rootTaskId, "interrupted", 90n)).toBe(200n)
    expect(validateHistoryTerminalReceipt(failedReceipt({ terminalPayload: { turnId, taskId: rootTaskId, errorCode: " ", finalItemId: null } }),
      turnId, rootTaskId, "failed", 90n)).toBeUndefined()
    expect(validateHistoryTerminalReceipt(failedReceipt({ terminalIdempotencyKey: "wrong-key" }),
      turnId, rootTaskId, "failed", 90n)).toBeUndefined()
    expect(validateHistoryTerminalReceipt(interruptedReceipt({ terminalCorrelationId: "other-turn" }),
      turnId, rootTaskId, "interrupted", 90n)).toBeUndefined()
    expect(validateHistoryTerminalReceipt(interruptedReceipt({ terminalPayload: { turnId, taskId: rootTaskId, errorCode: " " } }),
      turnId, rootTaskId, "interrupted", 90n)).toBeUndefined()
    expect(validateHistoryTerminalReceipt(interruptedReceipt({ terminalItemId: "unexpected-item" }),
      turnId, rootTaskId, "interrupted", 90n)).toBeUndefined()
  })
})
