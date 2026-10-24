import { describe, expect, it } from "vitest"
import { taskGraphProposalKey } from "./task-graph-snapshot.js"
import {
  parseTaskGraphBranchRepairRelation,
  taskGraphBranchRepairFingerprint,
  TASK_GRAPH_BRANCH_REPAIR_RELATION_SCHEMA_VERSION,
  type TaskGraphBranchRepairRelation,
} from "./task-graph-pg-branch-repair-relation.js"

const branch = {
  root: { nodeKey: "scout-old", taskId: "task-scout-old" },
  sources: [
    { nodeKey: "scout-old", taskId: "task-scout-old", replacementKey: "scout-new" },
    { nodeKey: "analyst-old", taskId: "task-analyst-old", replacementKey: "analyst-new" },
  ],
} as const
const nodes = [
  { key: "scout-new", templateId: "scout", goal: "Search again", successCriteria: ["Find current roles"], dependsOn: ["retained"] },
  { key: "analyst-new", templateId: "analyst", goal: "Reassess findings", successCriteria: ["Compare candidates"], dependsOn: ["scout-new"] },
] as const
const call = { expectedRevision: 12, replaceBranch: branch, nodes, rootSuccessCriteria: ["Preserve the original objective"] } as const

const validRelation = {
  schemaVersion: TASK_GRAPH_BRANCH_REPAIR_RELATION_SCHEMA_VERSION,
  operationKey: `agent.plan.reconciliation:sha256:${"a".repeat(64)}`,
  graphRootTaskId: "graph-root-task",
  observedRevision: 12,
  resultingRevision: 15,
  root: branch.root,
  sources: [
    { source: { nodeKey: "scout-old", taskId: "task-scout-old" }, replacementKey: "scout-new",
      cancellationEvent: { id: "cancel-scout", sequence: "9007199254740993" } },
    { source: { nodeKey: "analyst-old", taskId: "task-analyst-old" }, replacementKey: "analyst-new",
      cancellationEvent: { id: "cancel-analyst", sequence: "9007199254740994" } },
  ],
  planEvent: { id: "plan-event", sequence: "9007199254740995", idempotencyKey: taskGraphProposalKey("graph-root-task", 12) },
  replacementFingerprint: taskGraphBranchRepairFingerprint(call),
  agentPlanCall: { callId: "call-branch-repair", stepId: "step-replan", expectedRevision: 12, replaceBranch: branch },
} satisfies TaskGraphBranchRepairRelation

function changed(path: readonly string[], value: unknown): unknown {
  const copy = structuredClone(validRelation) as unknown as Record<string, unknown>
  let parent = copy
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>
  parent[path.at(-1)!] = value
  return copy
}

describe("parseTaskGraphBranchRepairRelation", () => {
  it("parses a detached plural relation with exact graph-root proposal identity", () => {
    const parsed = parseTaskGraphBranchRepairRelation(validRelation)
    expect(parsed).toEqual(validRelation)
    expect(parsed).not.toBe(validRelation)
    expect(parsed?.sources).not.toBe(validRelation.sources)
    expect(parsed?.sources[0]?.cancellationEvent).not.toBe(validRelation.sources[0]?.cancellationEvent)
    expect(parsed?.agentPlanCall.replaceBranch).not.toBe(validRelation.agentPlanCall.replaceBranch)
  })

  it("binds the cancellation count to revision advancement and the original call", () => {
    expect(parseTaskGraphBranchRepairRelation(validRelation)?.resultingRevision).toBe(15)
    expect(parseTaskGraphBranchRepairRelation(changed(["resultingRevision"], 14))).toBeNull()
    expect(parseTaskGraphBranchRepairRelation(changed(["resultingRevision"], 16))).toBeNull()
    expect(parseTaskGraphBranchRepairRelation(changed(["agentPlanCall", "expectedRevision"], 11))).toBeNull()
    expect(parseTaskGraphBranchRepairRelation(changed(["agentPlanCall", "replaceBranch", "root", "taskId"], "foreign"))).toBeNull()
  })

  it("requires the exact TaskGraph proposal key for this graph root and observed revision", () => {
    expect(parseTaskGraphBranchRepairRelation(changed(["planEvent", "idempotencyKey"], taskGraphProposalKey("other-root", 12)))).toBeNull()
    expect(parseTaskGraphBranchRepairRelation(changed(["planEvent", "idempotencyKey"], taskGraphProposalKey("graph-root-task", 13)))).toBeNull()
    expect(parseTaskGraphBranchRepairRelation(changed(["graphRootTaskId"], "other-root"))).toBeNull()
    expect(parseTaskGraphBranchRepairRelation(changed(["planEvent", "idempotencyKey"], "task-graph-" + "a".repeat(64) + ":12"))).toBeNull()
  })

  it("requires one-to-one source mappings and ordered distinct cancellation receipts", () => {
    expect(parseTaskGraphBranchRepairRelation(changed(["sources", "0", "source", "taskId"], "foreign-task"))).toBeNull()
    expect(parseTaskGraphBranchRepairRelation(changed(["sources", "1", "replacementKey"], "scout-new"))).toBeNull()
    expect(parseTaskGraphBranchRepairRelation(changed(["sources", "1", "cancellationEvent", "id"], "cancel-scout"))).toBeNull()
    expect(parseTaskGraphBranchRepairRelation(changed(["sources", "1", "cancellationEvent", "sequence"], "9007199254740992"))).toBeNull()
    expect(parseTaskGraphBranchRepairRelation(changed(["sources", "0", "cancellationEvent", "sequence"], "9007199254740994"))).toBeNull()
    expect(parseTaskGraphBranchRepairRelation(changed(["planEvent", "id"], "cancel-analyst"))).toBeNull()
    expect(parseTaskGraphBranchRepairRelation(changed(["sources", "1", "source", "nodeKey"], "scout-old"))).toBeNull()
    const selfCollision = structuredClone(validRelation) as unknown as {
      agentPlanCall: { replaceBranch: { sources: Array<{ replacementKey: string }> } }
      sources: Array<{ replacementKey: string }>
    }
    selfCollision.agentPlanCall.replaceBranch.sources[0]!.replacementKey = "scout-old"
    selfCollision.sources[0]!.replacementKey = "scout-old"
    expect(parseTaskGraphBranchRepairRelation(selfCollision)).toBeNull()
  })

  it("rejects malformed, oversized, noncanonical, and open nested records", () => {
    const invalid: unknown[] = [
      changed(["schemaVersion"], "agent-harness.v2.task-graph-branch-repair.v0"),
      changed(["unexpected"], true),
      changed(["root", "unexpected"], true),
      changed(["sources", "0", "cancellationEvent", "extra"], true),
      changed(["operationKey"], `agent.plan.reconciliation:sha256:${"A".repeat(64)}`),
      changed(["replacementFingerprint"], "b".repeat(63)),
      changed(["replacementFingerprint"], "B".repeat(64)),
      changed(["sources", "0", "source", "nodeKey"], "x".repeat(129)),
      changed(["sources", "0", "cancellationEvent", "sequence"], "01"),
      changed(["planEvent", "sequence"], "9223372036854775808"),
      changed(["sources"], [validRelation.sources[0]]),
      changed(["sources"], [...validRelation.sources, validRelation.sources[0]]),
    ]
    const accessor = structuredClone(validRelation) as unknown as Record<string, unknown>
    Object.defineProperty(accessor, "operationKey", { enumerable: true, get: () => validRelation.operationKey })
    invalid.push(accessor, Object.assign(Object.create({ forged: true }) as object, validRelation))
    expect(invalid.every(value => parseTaskGraphBranchRepairRelation(value) === null)).toBe(true)
  })
})

describe("taskGraphBranchRepairFingerprint", () => {
  it("hashes the immutable call payload before graph lookup and distinguishes every call change", () => {
    const fingerprint = taskGraphBranchRepairFingerprint(call)
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(taskGraphBranchRepairFingerprint({ ...call, nodes: [{ ...nodes[0] }, { ...nodes[1] }] })).toBe(fingerprint)
    expect(taskGraphBranchRepairFingerprint({ ...call, expectedRevision: 13 })).not.toBe(fingerprint)
    expect(taskGraphBranchRepairFingerprint({ ...call, nodes: [{ ...nodes[0], goal: "Changed" }, nodes[1]] })).not.toBe(fingerprint)
    expect(taskGraphBranchRepairFingerprint({ ...call, replaceBranch: { ...branch, sources: branch.sources.slice(0, 1) } })).not.toBe(fingerprint)
    expect(taskGraphBranchRepairFingerprint({ ...call, rootSuccessCriteria: ["Changed objective"] })).not.toBe(fingerprint)
  })
})
