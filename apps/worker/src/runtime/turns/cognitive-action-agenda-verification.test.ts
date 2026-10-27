import { describe, expect, it } from "vitest"

import { mergeTaskGraphCurrentObservation } from "../canonical-turn-task-graph-context.js"
import type { StepContext, StepContextSnapshot } from "../context/step-context-builder.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import type { TaskGraphCurrentNode, TaskGraphVerificationReport } from "../subagents/task-graph-command-port.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "../subagents/task-graph-verification-report.js"
import { countCurrentTypedVerificationCriteria } from "./cognitive-action-agenda-verification.js"

const REVISION = 7
const CURRENT_ID = "observation:task-graph-current"
const DIGEST = "a".repeat(64)
type ReportMode = "failed" | "unverified" | "passed" | "repair_unresolved"

function report(ids: readonly string[], mode: ReportMode): TaskGraphVerificationReport {
  const criteria = ids.map((criterionId, index) => mode === "failed" && index === 0
    ? { criterionId, status: "failed" as const, reasonCode: "criterion_not_met" as const }
    : mode === "unverified" ? { criterionId, status: "unverified" as const, reasonCode: "result_invalid" as const }
      : { criterionId, status: "passed" as const, reasonCode: "criteria_met" as const })
  if (mode === "unverified") return { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "unverified", reasonCode: "result_invalid", criteria, evidenceDigest: null, resultDigest: null }
  if (mode === "repair_unresolved") return { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "unverified", reasonCode: "repair_target_unresolved", criteria, evidenceDigest: null, resultDigest: DIGEST }
  if (mode === "failed") return { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "failed", reasonCode: "criterion_not_met", criteria, evidenceDigest: DIGEST, resultDigest: DIGEST }
  return { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met", criteria, evidenceDigest: DIGEST, resultDigest: DIGEST }
}

function node(input: Readonly<{
  key: string
  mode?: ReportMode
  status?: TaskGraphCurrentNode["status"]
  templateId?: string
  ids?: readonly string[]
  goal?: string
  successCriteria?: readonly string[]
  typed?: boolean
  native?: boolean
}>): TaskGraphCurrentNode {
  const ids = input.ids ?? ["candidate-count"]
  const status = input.status ?? "failed"
  return {
    key: input.key, taskId: `${input.key}-task`, templateId: input.templateId ?? "scout",
    goal: input.goal ?? "PRIVATE_NODE_GOAL", successCriteria: input.successCriteria ?? ["PRIVATE_SUCCESS_CRITERION"], dependsOn: [],
    status, readiness: status === "failed" || status === "completed" || status === "cancelled" ? "terminal" : "active",
    resultSummary: "PRIVATE_RESULT_SUMMARY", failureReason: "PRIVATE_FAILURE_REASON",
    ...(input.typed === false ? { verificationCriterionIds: [...ids] } : {
      verificationCriterionIds: [...ids],
      verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: input.templateId === "analyst" ? "analyst" as const : "scout" as const,
        criteria: ids.map(id => ({ id, check: input.templateId === "analyst" ? { kind: "finding_count_gte" as const, minimum: 1 } : { kind: "candidate_count_gte" as const, minimum: 1 } })) },
    }),
    ...(input.mode ? { verificationReport: report(ids, input.mode) } : {}),
    ...(input.native ? { native: { operationKind: "spawn", operationId: "native-op", requestFingerprint: DIGEST,
      callerTaskId: "root-task", role: "scout", taskType: "search", contextDigest: DIGEST } } : {}),
  } as TaskGraphCurrentNode
}

function context(nodes: readonly TaskGraphCurrentNode[], revision = REVISION): StepContext {
  const seed: StepContextSnapshot = { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] }
  const snapshot = mergeTaskGraphCurrentObservation(seed, { revision, nodes })
  return {
    schemaVersion: "agent-harness.v2", sessionId: "session-1", turnId: "turn-1", stepId: "step-1",
    inputThroughSequence: 1n, consumedInputIds: [], canonicalJson: "{}", taskGraphRevision: revision,
    blocks: snapshot.toolObservations.map(observation => ({ id: `observation:${observation.id}`, layer: "tool_observation",
      role: "data", trust: "external_untrusted", source: "tool_or_subagent", content: observation.content as never })),
  }
}

function currentBlock(value: StepContext): StepContext["blocks"][number] {
  const block = value.blocks.find(item => item.id === CURRENT_ID)
  if (!block) throw new Error("current graph fixture is missing")
  return block
}

function replaceGraph(value: StepContext, content: unknown): StepContext {
  return { ...value, blocks: value.blocks.map(block => block.id === CURRENT_ID ? { ...block, content: content as never } : block) }
}

describe("cognitive agenda current verification projection", () => {
  it("counts only failed and unverified rows in current failed typed Scout or Analyst reports", () => {
    const current = context([
      node({ key: "failed", mode: "failed", ids: ["failed-check", "passed-check"] }),
      node({ key: "unverified", mode: "unverified", ids: ["unknown-a", "unknown-b"] }),
      node({ key: "analyst", mode: "failed", templateId: "analyst", ids: ["finding-count"] }),
      node({ key: "completed", mode: "passed", status: "completed" }),
    ])
    expect(countCurrentTypedVerificationCriteria(current)).toBe(4)
  })

  it("accepts bounded canonical prose padding and a clipped trailing space", () => {
    const longGoal = `${"x".repeat(1199)} tail`
    const current = context([node({ key: "padded", mode: "failed", goal: longGoal, successCriteria: [" item "] })])
    const projected = currentBlock(current).content as unknown as { nodes: readonly { goal: string }[] }

    expect(projected.nodes[0]?.goal).toBe(`${"x".repeat(1199)} `)
    expect(countCurrentTypedVerificationCriteria(current)).toBe(1)
  })

  it.each([
    ["missing report", node({ key: "missing" })],
    ["legacy IDs-only metadata", node({ key: "legacy", mode: "unverified", typed: false })],
    ["active typed work", node({ key: "active", mode: "failed", status: "running" })],
    ["queued typed work", node({ key: "queued", mode: "failed", status: "queued" })],
    ["cancelled typed work", node({ key: "cancelled", mode: "failed", status: "cancelled" })],
    ["specialized node", node({ key: "special", mode: "failed", templateId: "prepare", typed: false })],
    ["native node", node({ key: "native", mode: "failed", native: true })],
    ["repair target unresolved with passed criteria", node({ key: "repair-unresolved", mode: "repair_unresolved" })],
  ] as const)("does not count %s", (_name, item) => {
    expect(countCurrentTypedVerificationCriteria(context([item]))).toBe(0)
  })

  it("fails closed when an eligible typed report disagrees with failed task status", () => {
    const mismatch = node({ key: "mismatch", mode: "passed" })
    expect(countCurrentTypedVerificationCriteria(context([mismatch]))).toBe(0)
  })

  it("requires the unique exact current block and matching StepContext revision", () => {
    const valid = context([node({ key: "current", mode: "failed" })])
    const block = currentBlock(valid)
    const graph = block.content as unknown as Record<string, unknown>
    expect(countCurrentTypedVerificationCriteria(valid)).toBe(1)
    expect(countCurrentTypedVerificationCriteria({ ...valid, taskGraphRevision: REVISION + 1 })).toBe(0)
    expect(countCurrentTypedVerificationCriteria({ ...valid, blocks: [block, block] })).toBe(0)
    expect(countCurrentTypedVerificationCriteria({ ...valid, blocks: [{ ...block, id: "observation:lookalike" }] })).toBe(0)
    expect(countCurrentTypedVerificationCriteria({ ...valid, blocks: [block, { ...block, id: "observation:lookalike" }] })).toBe(1)
    expect(countCurrentTypedVerificationCriteria(replaceGraph(valid, { ...graph, revision: REVISION + 1 }))).toBe(0)
    expect(countCurrentTypedVerificationCriteria(replaceGraph(valid, { ...graph, kind: "other" }))).toBe(0)
    for (const changed of [
      { ...block, layer: "profile" }, { ...block, role: "assistant" },
      { ...block, trust: "internal_record" }, { ...block, source: "user_input" },
    ]) expect(countCurrentTypedVerificationCriteria({ ...valid, blocks: [changed as StepContext["blocks"][number]] })).toBe(0)
  })

  it("rejects sparse arrays, hostile prototypes, accessors, and duplicate current identities", () => {
    const valid = context([node({ key: "first", mode: "failed" }), node({ key: "second", mode: "failed" })])
    const block = currentBlock(valid), graph = block.content as unknown as Record<string, unknown>
    const sparse = new Array(2)
    expect(countCurrentTypedVerificationCriteria(replaceGraph(valid, { ...graph, nodes: sparse }))).toBe(0)
    expect(countCurrentTypedVerificationCriteria({ ...valid, blocks: new Array(1) as StepContext["blocks"] })).toBe(0)
    const hostileGraph = Object.assign(Object.create({ forged: true }), graph)
    expect(countCurrentTypedVerificationCriteria(replaceGraph(valid, hostileGraph))).toBe(0)
    const originalNodes = graph.nodes as TaskGraphCurrentNode[]
    const hostileNodes = originalNodes.slice()
    Object.setPrototypeOf(hostileNodes, Object.create(Array.prototype))
    expect(countCurrentTypedVerificationCriteria(replaceGraph(valid, { ...graph, nodes: hostileNodes }))).toBe(0)
    const hostileNode = Object.assign(Object.create({ forged: true }), originalNodes[0])
    expect(countCurrentTypedVerificationCriteria(replaceGraph(valid, { ...graph, nodes: [hostileNode, originalNodes[1]] }))).toBe(0)
    expect(countCurrentTypedVerificationCriteria(replaceGraph(valid, { ...graph, nodes: [originalNodes[0], { ...originalNodes[1], key: originalNodes[0]!.key }] }))).toBe(0)
    expect(countCurrentTypedVerificationCriteria(replaceGraph(valid, { ...graph, nodes: [originalNodes[0], { ...originalNodes[1], taskId: originalNodes[0]!.taskId }] }))).toBe(0)
    const accessor = { ...originalNodes[0] }
    Object.defineProperty(accessor, "verificationReport", { enumerable: true, get: () => { throw new Error("must not run") } })
    expect(countCurrentTypedVerificationCriteria(replaceGraph(valid, { ...graph, nodes: [accessor, originalNodes[1]] }))).toBe(0)
    const accessorGraph = { ...graph }
    Object.defineProperty(accessorGraph, "revision", { enumerable: true, get: () => { throw new Error("must not run") } })
    expect(countCurrentTypedVerificationCriteria(replaceGraph(valid, accessorGraph))).toBe(0)
  })

  it("returns a zero count for malformed eligible typed metadata", () => {
    const valid = context([node({ key: "typed", mode: "failed" })])
    const block = currentBlock(valid), graph = block.content as unknown as Record<string, unknown>
    const original = (graph.nodes as TaskGraphCurrentNode[])[0]!
    const badReport = { ...original.verificationReport!, criteria: [{ criterionId: "other-check", status: "failed", reasonCode: "criterion_not_met" }] }
    expect(countCurrentTypedVerificationCriteria(replaceGraph(valid, { ...graph, nodes: [{ ...original, verificationReport: badReport }] }))).toBe(0)
  })
})
