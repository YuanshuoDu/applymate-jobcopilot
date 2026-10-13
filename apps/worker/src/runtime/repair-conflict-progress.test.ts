import { describe, expect, it } from "vitest"

import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "./planning/task-graph-verification.js"
import { createRepairConflictProgressDetector } from "./repair-conflict-progress.js"

const checkpoint = (inputThroughSequence = 0n, consumedInputIds: readonly string[] = [], taskGraphRevision = 4) => ({
  inputThroughSequence, consumedInputIds, taskGraphRevision,
})
const criterionA = { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }
const criterionB = { id: "evidence", check: { kind: "evidence_count_gte", minimum: 1 } }

function proposal(overrides: Readonly<Record<string, unknown>> = {}) {
  const node = {
    key: "repair-candidates", templateId: "scout", goal: "Find a better set", successCriteria: ["Return matching evidence"], dependsOn: [],
    verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [criterionA, criterionB] },
    repairOf: { nodeKey: "target-node", taskId: "target-task", criterionIds: ["candidate-count", "evidence"] },
    ...overrides,
  }
  return { expectedRevision: 4, nodes: [node] }
}

function denial(callId: string, input = proposal(), overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: `tool-result:${callId}`,
    content: {
      toolCallId: callId, toolName: "agent.plan", input, status: "failed", output: { code: "task_graph_repair_conflict" },
      errorCode: "task_graph_repair_conflict", ...overrides,
    },
  }
}

function call(argumentsValue: unknown = proposal(), name = "agent.plan") {
  return { id: "new-model-call", name, arguments: argumentsValue }
}

function seededDetector() {
  const detector = createRepairConflictProgressDetector(2)
  detector.observe({ snapshot: { toolObservations: [] }, toolCalls: [call()] }, checkpoint())
  detector.observe({ snapshot: { toolObservations: [denial("old-call-1", proposal({ goal: "Earlier wording" }))] }, toolCalls: [call()] }, checkpoint())
  return detector
}

describe("semantic repair-conflict progress", () => {
  it("stops only a matching singleton after two new unique persisted denials, ignoring prose and criterion order", () => {
    const detector = seededDetector()
    const prior = denial("old-call-1", proposal({ goal: "Earlier wording", successCriteria: ["Earlier success prose"] }))
    const second = denial("old-call-2", proposal({
      verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [criterionB, criterionA] },
      repairOf: { nodeKey: "target-node", taskId: "target-task", criterionIds: ["evidence", "candidate-count"] },
      goal: "Another harmless phrasing", successCriteria: ["Another success phrase"],
    }))
    const changedProse = proposal({ goal: "A fresh explanation", successCriteria: ["Different but non-authoritative prose"] })

    expect(detector.observe({ snapshot: { toolObservations: [prior, second] }, toolCalls: [call(changedProse)] }, checkpoint())).toEqual({
      signature: "repair_conflict_retry", stateFingerprint: "unchanged_trusted_repair_epoch",
    })
  })

  it("does not treat a different present Root value as the same repair intent", () => {
    const withRoot = (graphRootTaskId: string) => proposal({
      repairOf: { nodeKey: "target-node", taskId: "target-task", criterionIds: ["candidate-count", "evidence"], graphRootTaskId },
    })
    const detector = createRepairConflictProgressDetector(2)
    const first = denial("root-denial-a", withRoot("root-1"))
    const second = denial("root-denial-b", withRoot("root-1"))

    detector.observe({ snapshot: { toolObservations: [] }, toolCalls: [call()] }, checkpoint())
    detector.observe({ snapshot: { toolObservations: [first] }, toolCalls: [call()] }, checkpoint())
    expect(detector.observe({
      snapshot: { toolObservations: [first, second] },
      toolCalls: [call(withRoot("root-2"))],
    }, checkpoint())).toBeNull()
  })

  it("baselines restored observations and never counts a repeated result id twice", () => {
    const restored = [denial("restored-a"), denial("restored-b")]
    const restarted = createRepairConflictProgressDetector(2)
    expect(restarted.observe({ snapshot: { toolObservations: restored }, toolCalls: [call()] }, checkpoint())).toBeNull()
    expect(restarted.observe({ snapshot: { toolObservations: restored }, toolCalls: [call()] }, checkpoint())).toBeNull()

    const detector = createRepairConflictProgressDetector(2)
    detector.observe({ snapshot: { toolObservations: [] }, toolCalls: [call()] }, checkpoint())
    const one = denial("fresh-a")
    expect(detector.observe({ snapshot: { toolObservations: [one] }, toolCalls: [call()] }, checkpoint())).toBeNull()
    expect(detector.observe({ snapshot: { toolObservations: [one, one] }, toolCalls: [call()] }, checkpoint())).toBeNull()
    expect(detector.observe({ snapshot: { toolObservations: [one, denial("fresh-b")] }, toolCalls: [call()] }, checkpoint())).not.toBeNull()
  })

  it.each([
    ["node key", proposal({ key: "different-repair" })],
    ["template", proposal({ templateId: "analyst", verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }] }, repairOf: { nodeKey: "target-node", taskId: "target-task", criterionIds: ["finding-count"] } })],
    ["root presence", proposal({ repairOf: { nodeKey: "target-node", taskId: "target-task", criterionIds: ["candidate-count", "evidence"], graphRootTaskId: "root-1" } })],
    ["root value", proposal({ repairOf: { nodeKey: "target-node", taskId: "target-task", criterionIds: ["candidate-count", "evidence"], graphRootTaskId: "root-2" } })],
    ["target node", proposal({ repairOf: { nodeKey: "other-node", taskId: "target-task", criterionIds: ["candidate-count", "evidence"] } })],
    ["target task", proposal({ repairOf: { nodeKey: "target-node", taskId: "other-task", criterionIds: ["candidate-count", "evidence"] } })],
    ["criterion set", proposal({ repairOf: { nodeKey: "target-node", taskId: "target-task", criterionIds: ["candidate-count"] }, verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [criterionA] } })],
    ["check definition", proposal({ verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 2 } }, criterionB] } })],
    ["dependency set", proposal({ dependsOn: ["another-dependency"] })],
    ["expected revision", { ...proposal(), expectedRevision: 3 }],
    ["unknown field", proposal({ privateFlag: true })],
    ["multiple nodes", { expectedRevision: 4, nodes: [proposal().nodes[0], proposal().nodes[0]] }],
  ])("does not suppress a changed or malformed %s intent", (_label, candidate) => {
    const detector = seededDetector()
    const prior = denial("old-call-1")
    const second = denial("old-call-2")
    expect(detector.observe({ snapshot: { toolObservations: [prior, second] }, toolCalls: [call(candidate)] }, checkpoint())).toBeNull()
  })

  it("does not suppress co-emitted tools, unrelated tool calls, or an invalid repair relation", () => {
    const detector = seededDetector(), prior = denial("old-call-1"), second = denial("old-call-2")
    const history = { snapshot: { toolObservations: [prior, second] } }
    expect(detector.observe({ ...history, toolCalls: [call(), call({}, "jobs.search")] }, checkpoint())).toBeNull()
    expect(detector.observe({ ...history, toolCalls: [call({}, "jobs.search")] }, checkpoint())).toBeNull()
    expect(detector.observe({ ...history, toolCalls: [call(proposal({ repairOf: { nodeKey: "target-node", taskId: "target-task", criterionIds: ["candidate-count"] } }))] }, checkpoint())).toBeNull()
  })

  it.each([
    ["mismatched result id", (value: ReturnType<typeof denial>) => ({ ...value, id: "tool-result:other-call" })],
    ["mismatched toolCallId", (value: ReturnType<typeof denial>) => ({ ...value, content: { ...value.content, toolCallId: "other-call" } })],
    ["stale plan revision", (value: ReturnType<typeof denial>) => ({ ...value, content: { ...value.content, input: { ...value.content.input, expectedRevision: 3 } } })],
    ["untrusted error code", (value: ReturnType<typeof denial>) => ({ ...value, content: { ...value.content, errorCode: "different_code" } })],
    ["mismatched output code", (value: ReturnType<typeof denial>) => ({ ...value, content: { ...value.content, output: { code: "different_code" } } })],
    ["extra output detail", (value: ReturnType<typeof denial>) => ({ ...value, content: { ...value.content, output: { code: "task_graph_repair_conflict", targetTaskId: "private" } } })],
    ["raw message only", (value: ReturnType<typeof denial>) => ({ ...value, content: { ...value.content, errorCode: null, output: { message: "task_graph_repair_conflict" } } })],
    ["extra wrapper field", (value: ReturnType<typeof denial>) => ({ ...value, content: { ...value.content, targetTaskId: "private" } })],
    ["non-failed status", (value: ReturnType<typeof denial>) => ({ ...value, content: { ...value.content, status: "completed" } })],
  ])("does not count a canonical-looking but invalid %s observation", (_label, mutate) => {
    const detector = createRepairConflictProgressDetector(2)
    detector.observe({ snapshot: { toolObservations: [] }, toolCalls: [call()] }, checkpoint())
    const rows = [mutate(denial("spoof-a")), mutate(denial("spoof-b"))]
    expect(detector.observe({ snapshot: { toolObservations: rows }, toolCalls: [call()] }, checkpoint())).toBeNull()
  })

  it("rebaselines on invalid/missing checkpoints and never reactivates old conflict counts", () => {
    const detector = createRepairConflictProgressDetector(2)
    detector.observe({ snapshot: { toolObservations: [] }, toolCalls: [call()] }, checkpoint())
    const one = denial("old-a"), two = denial("old-b")
    detector.observe({ snapshot: { toolObservations: [one] }, toolCalls: [call()] }, checkpoint())
    expect(detector.observe({ snapshot: { toolObservations: [one, two] }, toolCalls: [call()] }, { inputThroughSequence: 0n, consumedInputIds: [] })).toBeNull()
    expect(detector.observe({ snapshot: { toolObservations: [one, two] }, toolCalls: [call()] }, checkpoint())).toBeNull()
    expect(detector.observe({ snapshot: { toolObservations: [one, two, denial("fresh-c")] }, toolCalls: [call()] }, checkpoint())).toBeNull()
    expect(detector.observe({ snapshot: { toolObservations: [one, two, denial("fresh-c"), denial("fresh-d")] }, toolCalls: [call()] }, checkpoint())).not.toBeNull()
  })

  it.each([
    ["input sequence", checkpoint(1n)],
    ["consumed input", checkpoint(0n, ["steer-1"])],
    ["graph revision", checkpoint(0n, [], 5)],
  ])("baselines fresh results after forward %s progress", (_label, advanced) => {
    const detector = createRepairConflictProgressDetector(2)
    detector.observe({ snapshot: { toolObservations: [] }, toolCalls: [call()] }, checkpoint())
    const one = denial("old-a"), two = denial("old-b")
    detector.observe({ snapshot: { toolObservations: [one] }, toolCalls: [call()] }, checkpoint())
    expect(detector.observe({ snapshot: { toolObservations: [one, two] }, toolCalls: [call()] }, advanced)).toBeNull()
    const currentProposal = proposal({ ...proposal().nodes[0] })
    currentProposal.expectedRevision = advanced.taskGraphRevision ?? 4
    const first = denial("new-a", currentProposal), second = denial("new-b", currentProposal)
    expect(detector.observe({ snapshot: { toolObservations: [one, two, first] }, toolCalls: [call(currentProposal)] }, advanced)).toBeNull()
    expect(detector.observe({ snapshot: { toolObservations: [one, two, first, second] }, toolCalls: [call(currentProposal)] }, advanced)).not.toBeNull()
  })

  it("keeps step-local consumed IDs monotonic when later checkpoints omit earlier IDs", () => {
    const detector = createRepairConflictProgressDetector(2)
    detector.observe({ snapshot: { toolObservations: [] }, toolCalls: [call()] }, checkpoint())
    const first = denial("steer-window-a")
    detector.observe({ snapshot: { toolObservations: [first] }, toolCalls: [call()] }, checkpoint(0n, ["steer-1"]))
    expect(detector.observe({ snapshot: { toolObservations: [first, denial("steer-window-b")] }, toolCalls: [call()] }, checkpoint())).toBeNull()
    expect(detector.observe({ snapshot: { toolObservations: [first, denial("steer-window-b"), denial("steer-window-c")] }, toolCalls: [call()] }, checkpoint())).not.toBeNull()
  })
})
