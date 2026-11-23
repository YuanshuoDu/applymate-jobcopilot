import { describe, expect, it } from "vitest"
import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT } from "@jobcopilot/agent-protocol"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2 } from "../planning/task-graph-verification.js"
import { parseTaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { TaskGraphVerificationReceipts } from "./task-graph-pg-verification-receipts.js"
import { objectiveEmptySearchCriterionIds } from "./task-graph-pg-empty-search-shortfall.js"

const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", taskId: "scout-1", attemptCount: 1 }
const node = parseTaskGraphSnapshot({ schemaVersion: "agent-harness.v2.task-graph", nodes: [{
  key: "scout", templateId: "scout", goal: "Find jobs", successCriteria: ["Find roles"], dependsOn: [], depth: 1,
  taskId: scope.taskId, verificationDisposition: "typed", verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2,
    role: "scout", criteria: [
      { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 3 } },
      { id: "location", check: { kind: "candidate_location_in", locations: ["Dublin"] } },
    ] },
}] }).nodes[0]!
const turn = (minimum = 2) => ({ goal: "Find roles", intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT,
  verificationRequirements: { schemaVersion: "agent-harness.v2.objective-requirements.v1", requirements: [
    { id: "candidate-count", check: { kind: "candidate_count_gte", minimum } },
  ] } })

function receipts(options: { toolName?: string; version?: string; input?: unknown; output?: unknown; status?: string; errorCode?: unknown; outcome?: "completed" | "failed"; replay?: boolean } = {}): TaskGraphVerificationReceipts {
  const call = { toolCallId: "call-1", toolName: options.toolName ?? "jobs.search", toolVersion: options.version ?? "1",
    input: options.input ?? { location: "Dublin", page: 1 }, status: options.status ?? "completed", errorCode: options.errorCode ?? null }
  const result = { toolCallId: call.toolCallId, output: options.output ?? { jobs: [], page: 1, hasMore: false }, errorCode: options.errorCode ?? null }
  return { items: [{ type: "tool_call", content: call }, { type: "tool_result", content: result }],
    outcomes: new Map([[call.toolCallId, options.outcome ?? "completed"]]), replayReceipts: options.replay ? [{} as never] : [], evidenceObservations: [] }
}

function check(overrides: { source?: unknown; mode?: unknown; input?: unknown; graphNode?: typeof node; proof?: TaskGraphVerificationReceipts } = {}) {
  return objectiveEmptySearchCriterionIds({ scope, node: overrides.graphNode ?? node, turnSource: overrides.source ?? "user",
    turnExecutionMode: overrides.mode ?? "canonical_task_graph", turnInput: overrides.input ?? turn(), receipts: overrides.proof ?? receipts() })
}

describe("objective empty search shortfall proof", () => {
  it("binds an empty first-page search to matching typed objective criteria", () => {
    expect(check()).toEqual(["candidate-count"])
  })

  it.each([
    [{ source: "automation" }], [{ mode: "selected_job" }],
    [{ input: { ...turn(), intent: { kind: "interactive_discovery_shortlist", version: 1 } } }],
    [{ input: { ...turn(), intent: { ...OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, extra: true } } }],
    [{ input: { ...turn(), input: { intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT } } }],
    [{ input: turn(4) }],
    [{ input: { ...turn(), verificationRequirements: { schemaVersion: "invalid", requirements: [] } } }],
  ] as const)("rejects non-objective or incompatible persisted authority %j", overrides => {
    expect(check(overrides as Parameters<typeof check>[0])).toBeUndefined()
  })

  it("requires the exact Scout task and root-matched criterion ID", () => {
    expect(check({ graphNode: { ...node, taskId: "foreign-scout" } })).toBeUndefined()
    const wrongTemplate = { ...node, templateId: "analyst" } as typeof node
    expect(check({ graphNode: wrongTemplate })).toBeUndefined()
    const wrongCriterion = { ...node, verification: { ...node.verification!, criteria: node.verification!.criteria.map(item => ({ ...item, id: "different" })) } }
    expect(check({ graphNode: wrongCriterion })).toBeUndefined()
    const legacy = { ...node, verificationDisposition: "legacy_unverified" as const }
    expect(check({ graphNode: legacy })).toBeUndefined()
  })

  it.each([
    ["non-search tool", receipts({ toolName: "jobs.get" })],
    ["unsupported version", receipts({ version: "2" })],
    ["failed call", receipts({ status: "failed", errorCode: "tool_failed", outcome: "failed" })],
    ["bad input", receipts({ input: { location: "Dublin", extra: true } })],
    ["later page", receipts({ input: { page: 2 } })],
    ["nonempty results", receipts({ output: { jobs: [{ id: "job-1" }], page: 1, hasMore: false } })],
    ["later page output", receipts({ output: { jobs: [], page: 2, hasMore: false } })],
    ["more results", receipts({ output: { jobs: [], page: 1, hasMore: true } })],
    ["extra output field", receipts({ output: { jobs: [], page: 1, hasMore: false, count: 0 } })],
    ["replay receipt", receipts({ replay: true })],
  ])("rejects %s as proof of an empty first-page search", (_label, proof) => {
    expect(check({ proof })).toBeUndefined()
  })

  it("rejects missing and duplicate pair sets", () => {
    expect(check({ proof: { ...receipts(), items: [], outcomes: new Map() } })).toBeUndefined()
    const single = receipts(), duplicate = { ...single.items[0]!, content: { ...(single.items[0]!.content as object) } }
    expect(check({ proof: { ...single, items: [...single.items, duplicate, ...single.items.slice(1)] } })).toBeUndefined()
    const tooMany = Array.from({ length: 33 }, (_, index) => {
      const id = `call-${index}`, call = { ...(single.items[0]!.content as Record<string, unknown>), toolCallId: id }
      const result = { ...(single.items[1]!.content as Record<string, unknown>), toolCallId: id }
      return [{ ...single.items[0]!, content: call }, { ...single.items[1]!, content: result }]
    }).flat()
    const outcomes = new Map(Array.from({ length: 33 }, (_, index) => [`call-${index}`, "completed" as const]))
    expect(check({ proof: { ...single, items: tooMany, outcomes } })).toBeUndefined()
    const extraResult = { ...single, items: [single.items[0]!, { ...single.items[1]!, content: { ...(single.items[1]!.content as object), extra: true } }] }
    expect(check({ proof: extraResult })).toBeUndefined()
  })
})
