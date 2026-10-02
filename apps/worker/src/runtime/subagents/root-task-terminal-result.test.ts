import { describe, expect, it } from "vitest"

import { parseTerminalRootResult } from "./root-task-terminal-result.js"

describe("terminal root result parsing", () => {
  it("maps only consistent persisted terminal states", () => {
    expect(parseTerminalRootResult({
      id: "root-1", status: "waiting", failureReason: null,
      result: { status: "waiting_for_dependency", stepCount: 2, toolCallCount: 1, waitId: "wait-1" },
    })).toEqual({ rootTaskId: "root-1", result: { status: "waiting_for_dependency", waitId: "wait-1" } })
  })

  it("rejects status mismatches and unbounded counters", () => {
    expect(() => parseTerminalRootResult({ id: "root-1", status: "completed", result: { status: "failed", stepCount: 0, toolCallCount: 0 } }))
      .toThrow("root_terminal_status_mismatch")
    expect(() => parseTerminalRootResult({ id: "root-1", status: "completed", result: { status: "completed", stepCount: -1, toolCallCount: 0 } }))
      .toThrow("root_terminal_step_count_invalid")
  })
})
