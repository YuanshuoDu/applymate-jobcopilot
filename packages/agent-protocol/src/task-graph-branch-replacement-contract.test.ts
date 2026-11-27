import { describe, expect, it } from "vitest"
import {
  parseTaskGraphBranchReplacementContract,
  TASK_GRAPH_MAX_PROPOSAL_NODES,
  type TaskGraphBranchReplacementContract,
} from "./task-graph-branch-replacement-contract.js"

const branch: TaskGraphBranchReplacementContract = {
  root: { nodeKey: "failed-root", taskId: "task-root" },
  sources: [
    { nodeKey: "failed-root", taskId: "task-root", replacementKey: "new-root" },
    { nodeKey: "failed-child", taskId: "task-child", replacementKey: "new-child" },
  ],
}

describe("TaskGraph branch replacement contract", () => {
  it("normalizes the exact closed request and binds proposal keys", () => {
    expect(TASK_GRAPH_MAX_PROPOSAL_NODES).toBe(8)
    expect(parseTaskGraphBranchReplacementContract(branch, [{ key: "new-root" }, { key: "new-child" }]))
      .toEqual({ ok: true, value: branch })
  })

  it("rejects unknown fields, duplicate identities, missing roots, and mismatched proposals", () => {
    expect(parseTaskGraphBranchReplacementContract({ ...branch, extra: true }).ok).toBe(false)
    expect(parseTaskGraphBranchReplacementContract({ ...branch, sources: [branch.sources[0], branch.sources[0]] }).ok).toBe(false)
    expect(parseTaskGraphBranchReplacementContract({ ...branch, root: { nodeKey: "other", taskId: "other-task" } }).ok).toBe(false)
    expect(parseTaskGraphBranchReplacementContract(branch, [{ key: "new-root" }, { key: "foreign" }]).ok).toBe(false)
    expect(parseTaskGraphBranchReplacementContract(branch, [{ key: "new-root", repairOf: {} }, { key: "new-child" }]).ok).toBe(false)
  })

  it("enforces the shared proposal bound and rejects sparse or accessor-backed data", () => {
    const sources = Array.from({ length: TASK_GRAPH_MAX_PROPOSAL_NODES + 1 }, (_, index) => ({
      nodeKey: `node-${index}`, taskId: `task-${index}`, replacementKey: `replacement-${index}`,
    }))
    const oversized = { root: sources[0], sources }
    expect(parseTaskGraphBranchReplacementContract(oversized).ok).toBe(false)

    const sparse: unknown[] = [branch.sources[0], branch.sources[1]]
    delete sparse[1]
    expect(parseTaskGraphBranchReplacementContract({ ...branch, sources: sparse }).ok).toBe(false)

    const accessor = Object.defineProperty({ ...branch.root }, "taskId", { enumerable: true, get: () => "task-root" })
    expect(parseTaskGraphBranchReplacementContract({ ...branch, root: accessor }).ok).toBe(false)
  })
})
