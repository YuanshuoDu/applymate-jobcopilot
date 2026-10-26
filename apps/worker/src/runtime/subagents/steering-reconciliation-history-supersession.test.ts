import { describe, expect, it } from "vitest"
import { normalizedProposalNode } from "./steering-reconciliation-history-supersession.js"

describe("steering reconciliation supersession history helpers", () => {
  it("normalizes an omitted repair root to the persisted root identity", () => {
    expect(normalizedProposalNode({
      key: "repair", templateId: "scout", goal: "Inspect the source", successCriteria: ["Find evidence"], dependsOn: [],
      repairOf: { nodeKey: "source", taskId: "source-task", criterionIds: ["evidence"] },
    }, "root-1")).toEqual({
      key: "repair", templateId: "scout", goal: "Inspect the source", successCriteria: ["Find evidence"], dependsOn: [],
      repairOf: { nodeKey: "source", taskId: "source-task", criterionIds: ["evidence"], graphRootTaskId: "root-1" },
    })
  })

  it("rejects an unknown proposal field or a repair bound to another root", () => {
    expect(normalizedProposalNode({
      key: "repair", templateId: "scout", goal: "Inspect the source", successCriteria: ["Find evidence"], dependsOn: [], extra: true,
    }, "root-1")).toBeNull()
    expect(normalizedProposalNode({
      key: "repair", templateId: "scout", goal: "Inspect the source", successCriteria: ["Find evidence"], dependsOn: [],
      repairOf: { nodeKey: "source", taskId: "source-task", criterionIds: ["evidence"], graphRootTaskId: "root-2" },
    }, "root-1")).toBeNull()
  })
})
