import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ScheduledGateCheckpointEvidence } from "./scheduled-gate-contract.js"
import { readScheduledGateRegistrationReceipt } from "./scheduled-gate-registration-receipt.js"
import type { ScheduledPrepareTaskGraphProof } from "./scheduled-prepare-task-graph-verification.js"
import { readScheduledGatePreparePrefixProof, scheduledGatePreparePrefixMatches } from "./scheduled-gate-prepare-prefix-proof.js"
import type { LoadedGraph } from "./task-graph-pg-state.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"

vi.mock("./scheduled-gate-registration-receipt.js", () => ({ readScheduledGateRegistrationReceipt: vi.fn() }))

const key = (version: "v1" | "v2") => `scheduled-taskgraph:${version === "v2" ? "v2:" : ""}sha256:${"a".repeat(64)}`
function graph(count: 1 | 2 | 4, stage: "gate" | "audit" = "gate"): LoadedGraph {
  const scouts = Array.from({ length: count }, (_, index) => ({ key: `source-${index}`, templateId: "scout", depth: 1, dependsOn: [],
    taskId: `scout-task-${index}`, verificationDisposition: "typed" }))
  const analyst = { key: "analyst", templateId: "analyst", depth: 2, dependsOn: scouts.map(node => node.key).reverse(),
    taskId: "analyst-task", verificationDisposition: "typed" }
  const prepare = { key: "prepare", templateId: "prepare", depth: 3, dependsOn: ["analyst"], taskId: "prepare-task", verificationDisposition: "specialized" }
  const gate = { key: "gate", templateId: "gate", depth: 4, dependsOn: ["prepare"], taskId: "gate-task", verificationDisposition: "specialized" }
  const audit = { key: "scheduled_audit", templateId: "scheduled_audit", depth: 5, dependsOn: ["gate"],
    taskId: "audit-task", verificationDisposition: "specialized" }
  const nodes = [...scouts, analyst, prepare, gate, ...(stage === "audit" ? [audit] : [])]
  const tasks = new Map(nodes.map(node => {
    const template = node.templateId === "scout" ? TASK_GRAPH_TEMPLATES.scout
      : node.templateId === "analyst" ? TASK_GRAPH_TEMPLATES.analyst : TASK_GRAPH_TEMPLATES.prepare
    return [node.taskId, { id: node.taskId, status: node.key === "gate" ? "queued" : "completed",
      attemptCount: node.key === "gate" ? 0 : 1, role: template.role, taskType: template.taskType, failureReason: null, result: {} }]
  }))
  return { snapshot: { schemaVersion: "agent-harness.v2.task-graph-snapshot.v1", nodes } as never,
    state: { revision: 6, appliedEvents: [], nodes: nodes.map(node => ({ key: node.key, taskId: node.taskId,
      status: node.key === "gate" ? "queued" : "completed", failureReason: null })) } as never,
    tasks, rootTaskId: "root", item: null } as unknown as LoadedGraph
}
function proof(count: 1 | 2 | 4): ScheduledPrepareTaskGraphProof {
  const sources = Array.from({ length: count }, (_, index) => ({ taskId: `scout-task-${index}`, attemptCount: 1, role: "scout" as const,
    taskType: TASK_GRAPH_TEMPLATES.scout.taskType, status: "completed" as const, verification: "passed" as const, dependsOnTaskIds: [] }))
  const analyst = { taskId: "analyst-task", attemptCount: 1, role: "analyst" as const, taskType: TASK_GRAPH_TEMPLATES.analyst.taskType,
    status: "completed" as const, verification: "passed" as const, dependsOnTaskIds: sources.map(node => node.taskId).sort() }
  const prepare = { taskId: "prepare-task", attemptCount: 1, role: "prepare" as const, taskType: TASK_GRAPH_TEMPLATES.prepare.taskType,
    status: "completed" as const, verification: "passed" as const, dependsOnTaskIds: ["analyst-task"] }
  return { receipt: { continuationKey: key(count === 1 ? "v1" : "v2"), prepareScheduleRevision: 4 } as never,
    completion: { graphRevision: 5, nodes: [...sources, analyst, prepare], wait: { waitId: "wait", status: "ready", mode: "all",
      targetTaskIds: ["prepare-task"], matchedTaskIds: ["prepare-task"] } } as never, result: {} as never }
}

describe("scheduled Gate Prepare prefix proof", () => {
  beforeEach(() => vi.mocked(readScheduledGateRegistrationReceipt).mockReset())

  it.each([[1, "gate"], [2, "gate"], [4, "audit"]] as const)("matches every current source binding for %i Scouts at %s stage", (count, stage) => {
    const loaded = graph(count, stage), stored = proof(count)
    expect(scheduledGatePreparePrefixMatches(loaded, stored)).toBe(true)
    const changed = new Map(loaded.tasks)
    changed.set("scout-task-0", { ...changed.get("scout-task-0")!, attemptCount: 2 })
    expect(scheduledGatePreparePrefixMatches({ ...loaded, tasks: changed }, stored)).toBe(false)
  })

  it("reads the private receipt before loading proof and rejects a mismatched continuation", async () => {
    const loaded = graph(2), stored = proof(2), receipt = { continuationKey: key("v2"), snapshotDigest: "snapshot",
      evidenceDigest: "b".repeat(64), checkpointDigest: "c".repeat(64), analyzeGraphRevision: 3,
      prepareScheduleRevision: 4, gateAppendRevision: 6, prepareWaitId: "wait", owner: { rootAttemptCount: 1,
        executionId: "execution", executionAttemptCount: 1 } }
    vi.mocked(readScheduledGateRegistrationReceipt).mockResolvedValue(receipt as never)
    const loadProof = vi.fn().mockResolvedValue(stored)
    const result = await readScheduledGatePreparePrefixProof({ client: { query: vi.fn() } as never,
      scope: { userId: "user", sessionId: "session", turnId: "turn", rootTaskId: "root" }, gateTaskId: "gate-task",
      gateRow: { id: "gate-task", status: "queued", attemptCount: 0, rootAttemptCount: 1, executionId: "execution", executionAttemptCount: 1 },
      evidence: { continuationKey: key("v1"), snapshotDigest: "snapshot", evidenceDigest: "b".repeat(64), checkpointDigest: "c".repeat(64),
        analyzeGraphRevision: 3, prepareWaitContinuationKey: key("v2"), owner: { rootAttemptCount: 1, executionId: "execution", executionAttemptCount: 1 } } as ScheduledGateCheckpointEvidence,
      graph: loaded, prepareTask: { id: "prepare-task", result: { taskGraphScheduledPrepareProofFacts: { completion: { graphRevision: 5 } } } },
      loadProof })
    expect(result).toBeNull()
    expect(loadProof).not.toHaveBeenCalled()
    expect(readScheduledGateRegistrationReceipt).toHaveBeenCalledOnce()
  })
})
