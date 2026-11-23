import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { taskGraphItemId, taskGraphLifecycleKey, taskGraphProposalKey } from "./task-graph-receipt-keys.js"

describe("TaskGraph receipt key compatibility", () => {
  it("preserves the persisted item, proposal, and lifecycle key formats", () => {
    const rootHash = createHash("sha256").update("root-1", "utf8").digest("hex")
    const nodeHash = createHash("sha256").update("scout-node", "utf8").digest("hex").slice(0, 20)
    expect(taskGraphItemId("root-1")).toBe(`task-graph-${rootHash}`)
    expect(taskGraphProposalKey("root-1", 4)).toBe(`task-graph-${rootHash}:proposal:4`)
    expect(taskGraphLifecycleKey("root-1", "scout-node", 3, "task.failed"))
      .toBe(`task-graph-${rootHash}:node:${nodeHash}:3:task.failed`)
  })
})
