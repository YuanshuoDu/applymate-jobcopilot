import { describe, expect, it } from "vitest"
import {
  parseTaskGraphSupersessionRelation,
  taskGraphSupersessionFingerprint,
  taskGraphSupersessionProposalKey,
  taskGraphWaitConditionEvidenceSql,
  type TaskGraphSupersessionRelation,
} from "./task-graph-pg-supersession.js"
import { taskGraphProposalKey } from "./task-graph-snapshot.js"

const validRelation = {
  schemaVersion: "agent-harness.v2.task-graph-supersession.v2",
  operationKey: `agent.plan.reconciliation:sha256:${"a".repeat(64)}`,
  observedRevision: 12,
  cancellationRevision: 13,
  resultingRevision: 14,
  source: { nodeKey: "scout-old", taskId: "task-old" },
  replacement: { nodeKey: "scout-new", taskId: "task-new" },
  cancellationEvent: { id: "cancel-event", sequence: "9007199254740993" },
  planEvent: { id: "plan-event", sequence: "9007199254740994", idempotencyKey: taskGraphSupersessionProposalKey("root-1", 12) },
  replacementFingerprint: "b".repeat(64),
  agentPlanCall: {
    callId: "call-replan",
    stepId: "step-replan",
    expectedRevision: 12,
    replaceUnstarted: { nodeKey: "scout-old" },
  },
} satisfies TaskGraphSupersessionRelation

function changed(path: readonly string[], next: unknown): unknown {
  const copy = structuredClone(validRelation) as unknown as Record<string, unknown>
  let current = copy
  for (const key of path.slice(0, -1)) current = current[key] as Record<string, unknown>
  current[path.at(-1)!] = next
  return copy
}

describe("parseTaskGraphSupersessionRelation", () => {
  it("parses the closed v2 relation and returns detached nested values", () => {
    const parsed = parseTaskGraphSupersessionRelation(validRelation)
    expect(parsed).toEqual(validRelation)
    expect(parsed).not.toBe(validRelation)
    expect(parsed?.source).not.toBe(validRelation.source)
    expect(parsed?.agentPlanCall.replaceUnstarted).not.toBe(validRelation.agentPlanCall.replaceUnstarted)
  })

  it("binds the R, R+1, and R+2 revisions and call to the source at R", () => {
    expect(parseTaskGraphSupersessionRelation(validRelation)?.resultingRevision).toBe(14)
    expect(parseTaskGraphSupersessionRelation(changed(["cancellationRevision"], 12))).toBeNull()
    expect(parseTaskGraphSupersessionRelation(changed(["cancellationRevision"], 14))).toBeNull()
    expect(parseTaskGraphSupersessionRelation(changed(["resultingRevision"], 13))).toBeNull()
    expect(parseTaskGraphSupersessionRelation(changed(["resultingRevision"], 15))).toBeNull()
    expect(parseTaskGraphSupersessionRelation(changed(["agentPlanCall", "expectedRevision"], 11))).toBeNull()
  })

  it("rejects extra, missing, inherited, and accessor fields at every level", () => {
    const malformed: unknown[] = [
      changed(["extra"], true),
      changed(["source", "extra"], true),
      changed(["replacement", "extra"], true),
      changed(["cancellationEvent", "extra"], true),
      changed(["planEvent", "extra"], true),
      changed(["agentPlanCall", "extra"], true),
      changed(["agentPlanCall", "replaceUnstarted", "extra"], true),
      changed(["schemaVersion"], "agent-harness.v2.task-graph-supersession.v1"),
      Object.assign(Object.create({ unexpected: true }) as object, validRelation),
    ]
    const accessor = structuredClone(validRelation) as unknown as Record<string, unknown>
    Object.defineProperty(accessor, "operationKey", { enumerable: true, get: () => validRelation.operationKey })
    malformed.push(accessor)
    expect(malformed.every(value => parseTaskGraphSupersessionRelation(value) === null)).toBe(true)
  })

  it("requires distinct task and node identities and ordered event identities", () => {
    expect(parseTaskGraphSupersessionRelation(changed(["replacement", "nodeKey"], "scout-old"))).toBeNull()
    expect(parseTaskGraphSupersessionRelation(changed(["replacement", "taskId"], "task-old"))).toBeNull()
    expect(parseTaskGraphSupersessionRelation(changed(["planEvent", "id"], "cancel-event"))).toBeNull()
    expect(parseTaskGraphSupersessionRelation(changed(["planEvent", "sequence"], "9007199254740993"))).toBeNull()
    expect(parseTaskGraphSupersessionRelation(changed(["cancellationEvent", "sequence"], "9007199254740995"))).toBeNull()
  })

  it("requires canonical bounded IDs, positive decimal sequences, and lower-case fingerprints", () => {
    const invalid: unknown[] = [
      changed(["operationKey"], `agent.plan.reconciliation:sha256:${"A".repeat(64)}`),
      changed(["replacementFingerprint"], "c".repeat(63)),
      changed(["replacementFingerprint"], "C".repeat(64)),
      changed(["source", "nodeKey"], "x".repeat(129)),
      changed(["agentPlanCall", "callId"], " "),
      changed(["cancellationEvent", "sequence"], "0"),
      changed(["cancellationEvent", "sequence"], "01"),
      changed(["cancellationEvent", "sequence"], "1.0"),
      changed(["cancellationEvent", "sequence"], 900),
      changed(["planEvent", "sequence"], "9223372036854775808"),
    ]
    expect(invalid.every(value => parseTaskGraphSupersessionRelation(value) === null)).toBe(true)
  })

  it("derives a distinct root-and-revision supersession event key", () => {
    const key = taskGraphSupersessionProposalKey("root-1", 12)
    expect(key).toBe(taskGraphSupersessionProposalKey("root-1", 12))
    expect(key).not.toBe(taskGraphProposalKey("root-1", 12))
    expect(key).not.toBe(taskGraphSupersessionProposalKey("root-1", 13))
    expect(key).not.toBe(taskGraphSupersessionProposalKey("root-2", 12))
  })

  it("fingerprints the locked source identity and canonical normalized replacement proposal", () => {
    const source = { nodeKey: "scout-old", taskId: "task-old" }
    const proposal = { expectedRevision: 12, replaceUnstartedNodeKey: "scout-old", nodes: [
      { key: "scout-new", templateId: "scout", goal: "Find roles", successCriteria: ["Report"], dependsOn: [] },
    ] }
    const fingerprint = taskGraphSupersessionFingerprint(source, proposal)
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(taskGraphSupersessionFingerprint(source, { ...proposal, nodes: [{ ...proposal.nodes[0] }] })).toBe(fingerprint)
    expect(taskGraphSupersessionFingerprint({ ...source, taskId: "different-task" }, proposal)).not.toBe(fingerprint)
    expect(taskGraphSupersessionFingerprint({ ...source, nodeKey: "different-node" }, proposal)).not.toBe(fingerprint)
    expect(taskGraphSupersessionFingerprint(source, { ...proposal, nodes: [{ ...proposal.nodes[0], goal: "Changed" }] })).not.toBe(fingerprint)
  })

  it("rejects a persisted call that does not describe the superseded source request", () => {
    expect(parseTaskGraphSupersessionRelation(changed(["agentPlanCall", "replaceUnstarted", "nodeKey"], "scout-new"))).toBeNull()
    expect(parseTaskGraphSupersessionRelation(changed(["agentPlanCall", "replaceUnstarted"], { nodeKey: "scout-old", taskId: "task-old" }))).toBeNull()
    expect(parseTaskGraphSupersessionRelation(changed(["agentPlanCall", "stepId"], "\u0000step"))).toBeNull()
  })
})

describe("taskGraphWaitConditionEvidenceSql", () => {
  it("rejects same-turn durable waits that reference the source as parent, target, or match", () => {
    const predicate = taskGraphWaitConditionEvidenceSql()
    expect(predicate).toContain('wait."sessionId" = task."sessionId"')
    expect(predicate).toContain('wait."turnId" = task."turnId"')
    expect(predicate).toContain('wait."parentTaskId" = task."id"')
    expect(predicate).toContain('wait."targetTaskIds" @> jsonb_build_array(task."id")')
    expect(predicate).toContain('wait."matchedTaskIds" @> jsonb_build_array(task."id")')
    expect(predicate).not.toMatch(/status|consumedAt/i)
  })
})
