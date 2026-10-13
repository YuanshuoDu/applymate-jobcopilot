import { describe, expect, it } from "vitest"

import { parseRootTaskFinishMetadata, parseTerminalRootResult } from "./root-task-terminal-result.js"

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

  it("validates finish metadata against the terminal result while retaining permitted failures", () => {
    const completed = { schemaVersion: 1, status: "completed", items: [{ jobId: "job-1", score: 8, evidenceIds: ["read:job-1"] }], failures: [] }
    expect(parseRootTaskFinishMetadata({ interactiveDiscoveryShortlist: completed }, "completed")).toEqual(completed)
    expect(parseRootTaskFinishMetadata(undefined, "completed")).toBeUndefined()
    expect(() => parseRootTaskFinishMetadata({ interactiveDiscoveryShortlist: { ...completed, private: true } }, "completed"))
      .toThrow("root_terminal_discovery_shortlist_invalid")
    expect(() => parseRootTaskFinishMetadata({ interactiveDiscoveryShortlist: { schemaVersion: 1, status: "failed", items: [], failures: ["discovery_runtime_failed"] } }, "completed"))
      .toThrow("root_terminal_discovery_status_mismatch")
    expect(() => parseRootTaskFinishMetadata({ interactiveDiscoveryShortlist: completed }, "waiting_for_user"))
      .toThrow("root_terminal_discovery_status_mismatch")
    expect(parseRootTaskFinishMetadata({ interactiveDiscoveryShortlist: { schemaVersion: 1, status: "partial", items: [{ jobId: "job-1", score: 8, evidenceIds: ["read:job-1"] }], failures: ["discovery_runtime_failed"] } }, "failed"))
      .toMatchObject({ status: "partial", failures: ["discovery_runtime_failed"] })
  })
})
