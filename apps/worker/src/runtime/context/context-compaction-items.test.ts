import { describe, expect, it } from "vitest"

import { completeCompactionItem, createCompactionStartedItem, failCompactionItem } from "./context-compaction-items.js"
import { CompactionError, type CompactionSource } from "./context-compaction-types.js"

const source = { state: { ownerId: "user-a", sessionId: "session-a", throughSequence: 1n, goal: "goal", userConstraints: [], approvals: [], answers: [], artifacts: [], openTasks: [], doNotRepeat: [], facts: [] }, items: [] } as CompactionSource

describe("compaction lifecycle Items", () => {
  it("creates bounded visible started and completed states", () => {
    const started = createCompactionStartedItem({ sessionId: "session-a", turnId: "turn-a", throughSequence: 1n, source, reason: "manual" }, () => "item-1")
    const completed = completeCompactionItem(started, { summary: "x".repeat(500), measurement: { beforeInputTokens: 100, afterInputTokens: 20, reductionTokens: 80, reductionRatio: 0.8 }, report: { preserved: true, preservedFields: ["goal", "approvals", "answers", "artifact_hashes", "open_tasks", "do_not_repeat"], missingFields: [], changedFields: [], beforeDigest: "a", afterDigest: "a" } })
    expect(started).toMatchObject({ id: "item-1", type: "context_compaction", status: "started" })
    expect(completed.status).toBe("completed")
    expect(completed.data.summaryPreview?.length).toBeLessThanOrEqual(280)
  })

  it("makes a failed compaction visible without including raw failure data", () => {
    const started = createCompactionStartedItem({ sessionId: "session-a", turnId: "turn-a", throughSequence: 1n, source, reason: "item_count" }, () => "item-1")
    const failed = failCompactionItem(started, new CompactionError("publish_failed", "secret answer must not be shown"))
    expect(failed).toMatchObject({ status: "failed", data: { errorCode: "publish_failed", previousSnapshotRetained: true } })
    expect(failed.body).not.toContain("secret")
  })
})
