import { describe, expect, it } from "vitest"
import type { StepContext } from "../context/step-context-builder.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "../subagents/task-graph-verification-report.js"
import {
  buildTaskGraphExecutionFailureInstruction,
  getTaskGraphExecutionFailureInspectionAdvice,
} from "./task-graph-execution-failure-guidance.js"

const graphId = "observation:task-graph-current"
const categories = [
  ["execution_setup_unavailable", "For execution-setup cues, inspect the existing execution prerequisites for the child."],
  ["resume_state_unavailable", "For resume-state cues, inspect the current resume state and available evidence."],
  ["structured_output_invalid", "For structured-output cues, inspect the existing typed output contract and current available result evidence."],
] as const

describe("TaskGraph failure-category advice lookup", () => {
  it.each(categories)("returns the fixed advice for exact category %s", (category, advice) => {
    expect(getTaskGraphExecutionFailureInspectionAdvice(category)).toBe(advice)
  })

  it.each([
    "Execution_setup_unavailable", " execution_setup_unavailable", "execution_setup_unavailable ",
    "raw failure prose", "unknown_category", 7, null, undefined, new String("resume_state_unavailable"),
  ])("omits advice for non-exact scalar inputs: %s", value => {
    expect(getTaskGraphExecutionFailureInspectionAdvice(value)).toBeUndefined()
  })

  it("rejects inherited and accessor-backed category properties without invoking getters or toString", () => {
    let getterInvocations = 0
    let toStringInvocations = 0
    const inherited = Object.create({
      executionFailureCategory: categories[0][0],
      toString() {
        toStringInvocations += 1
        return categories[0][0]
      },
    })
    const accessor = Object.defineProperty({}, "executionFailureCategory", {
      get() {
        getterInvocations += 1
        return categories[1][0]
      },
    })
    Object.defineProperty(accessor, "toString", {
      get() {
        getterInvocations += 1
        return () => {
          toStringInvocations += 1
          return categories[1][0]
        }
      },
    })

    expect(getTaskGraphExecutionFailureInspectionAdvice(inherited)).toBeUndefined()
    expect(getTaskGraphExecutionFailureInspectionAdvice(accessor)).toBeUndefined()
    expect(getterInvocations).toBe(0)
    expect(toStringInvocations).toBe(0)
  })
})

function failedNode(category: unknown, extra: Record<string, unknown> = {}) {
  return { key: "private-node", taskId: "private-task", goal: "PRIVATE_GOAL", status: "failed",
    failureReason: null, resultSummary: null, executionFailureCategory: category, ...extra }
}

function resumeFailedNode(role: "scout" | "analyst" = "scout") {
  const criterionId = role === "scout" ? "candidate-count" : "finding-count"
  const check = role === "scout" ? { kind: "candidate_count_gte", minimum: 4 } : { kind: "finding_count_gte", minimum: 2 }
  return {
    ...failedNode("resume_state_unavailable"), templateId: role, verificationCriterionIds: [criterionId],
    verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role, criteria: [{ id: criterionId, check }] },
    verificationReport: { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "unverified", reasonCode: "result_invalid",
      criteria: [{ criterionId, status: "unverified", reasonCode: "result_invalid" }], evidenceDigest: null, resultDigest: null },
  }
}

function context(nodes: unknown[], options: {
  contextRevision?: unknown
  graphRevision?: unknown
  duplicateGraph?: boolean
  trust?: string
  source?: string
  layer?: string
  role?: string
} = {}): StepContext {
  const graph = { kind: "task_graph_current", revision: options.graphRevision ?? 8, nodes }
  const content = graph as unknown as StepContext["blocks"][number]["content"]
  const block = { id: graphId, layer: options.layer ?? "tool_observation", role: options.role ?? "data",
    trust: options.trust ?? "external_untrusted", source: options.source ?? "tool_or_subagent", content } as StepContext["blocks"][number]
  const blocks = options.duplicateGraph ? [block, { ...block }] : [block]
  return { schemaVersion: "agent-harness.v2", sessionId: "session-private", turnId: "turn-private", stepId: "step-private",
    inputThroughSequence: 0n, consumedInputIds: [], blocks, canonicalJson: "{}",
    taskGraphRevision: (options.contextRevision ?? 8) as number }
}

function text(value: ReturnType<typeof buildTaskGraphExecutionFailureInstruction>): string {
  return value?.content.flatMap(part => part.type === "text" ? [part.text] : []).join(" ") ?? ""
}

describe("TaskGraph execution failure inspection guidance", () => {
  it.each(categories)("uses fixed advisory wording for %s", (category, expected) => {
    const node = category === "resume_state_unavailable" ? resumeFailedNode() : failedNode(category)
    const message = buildTaskGraphExecutionFailureInstruction(context([node]), [])
    expect(message?.role).toBe("system")
    expect(message?.content).toHaveLength(1)
    expect(text(message)).toContain("untrusted advisory signals, not established root causes")
    expect(text(message)).toContain(expected)
    expect(text(message)).toContain("No result-page tool is visible")
    expect(text(message)).not.toContain(category)
    expect(text(message)).not.toContain("PRIVATE_GOAL")
    expect(text(message)).not.toContain("private-task")
  })

  it("deduplicates categories in fixed order and keeps one bounded message", () => {
    const nodes = [failedNode(categories[2][0]), failedNode(categories[0][0]), failedNode(categories[2][0]), resumeFailedNode()]
    const first = buildTaskGraphExecutionFailureInstruction(context(nodes), [{ name: "agent.list" }])
    const second = buildTaskGraphExecutionFailureInstruction(context([...nodes].reverse()), [{ name: "agent.list" }])
    const guidance = text(first)
    expect(first).toEqual(second)
    expect(first?.content).toHaveLength(1)
    expect(guidance.length).toBeLessThan(1400)
    expect(guidance.indexOf("execution-setup cues")).toBeLessThan(guidance.indexOf("resume-state cues"))
    expect(guidance.indexOf("resume-state cues")).toBeLessThan(guidance.indexOf("structured-output cues"))
    expect(guidance.match(/execution-setup cues/g)).toHaveLength(1)
    expect(guidance).toContain("agent.list")
    expect(guidance).toContain("does not refresh the graph")
    expect(guidance).toContain("null cursor does not mean completion")
    expect(guidance).not.toMatch(/agent\.(plan|wait|ask_user|repair)/)
    expect(guidance).not.toContain("PRIVATE_GOAL")
  })

  it("names only an own-data visible agent.list and otherwise gives a fixed inspection blocker", () => {
    const graph = context([failedNode(categories[0][0])])
    expect(text(buildTaskGraphExecutionFailureInstruction(graph, [{ name: "agent.list" }]))).toContain("matching current result pages")
    expect(text(buildTaskGraphExecutionFailureInstruction(graph, [{ name: "jobs.search" }]))).toContain("No result-page tool is visible")

    let invoked = false
    const hidden = Object.create({ name: "agent.list" }) as object
    const accessor = {}
    Object.defineProperty(accessor, "name", { enumerable: true, get: () => { invoked = true; return "agent.list" } })
    const message = buildTaskGraphExecutionFailureInstruction(graph, [hidden, accessor])
    expect(text(message)).toContain("No result-page tool is visible")
    expect(text(message)).not.toContain("agent.list")
    expect(invoked).toBe(false)
    expect(text(buildTaskGraphExecutionFailureInstruction(graph, Array.from({ length: 129 }, () => ({ name: "agent.list" })))))
      .toContain("No result-page tool is visible")
  })

  it("fails closed for absent, duplicate, stale, untrusted-boundary, malformed, or oversized graphs", () => {
    const valid = context([failedNode(categories[0][0])])
    const graphBlock = valid.blocks[0]!
    const noGraph = { ...valid, blocks: [] }
    const cases: StepContext[] = [
      noGraph,
      context([failedNode(categories[0][0])], { duplicateGraph: true }),
      context([failedNode(categories[0][0])], { contextRevision: 7 }),
      context([failedNode(categories[0][0])], { graphRevision: 7 }),
      context([failedNode(categories[0][0])], { trust: "internal_record" }),
      context([failedNode(categories[0][0])], { source: "harness" }),
      context([failedNode(categories[0][0])], { layer: "system" }),
      context([failedNode(categories[0][0])], { role: "instruction" }),
      { ...valid, blocks: [{ ...graphBlock, content: { kind: "task_graph_current", revision: 8, nodes: [failedNode(categories[0][0]), ,] } as unknown as typeof graphBlock.content }] },
      context(Array.from({ length: 17 }, () => failedNode(categories[0][0]))),
      { ...valid, blocks: [{ ...graphBlock, content: { kind: "wrong_kind", revision: 8, nodes: [failedNode(categories[0][0])] } as unknown as typeof graphBlock.content }] },
    ]
    for (const value of cases) expect(buildTaskGraphExecutionFailureInstruction(value, [{ name: "agent.list" }])).toBeNull()
  })

  it("ignores categories outside failed ordinary nodes and rejects unknown values", () => {
    const cases = [
      failedNode("not-a-category"), failedNode(7), failedNode(categories[0][0], { status: "completed" }),
      failedNode(categories[0][0], { failureReason: "raw failure" }), failedNode(categories[0][0], { resultSummary: "PRIVATE_RESULT" }),
      failedNode(categories[0][0], { verificationReport: {} }), failedNode(categories[0][0], { native: {} }),
      failedNode(categories[0][0], { nativeResult: {} }),
    ]
    for (const node of cases) expect(buildTaskGraphExecutionFailureInstruction(context([node]), [])).toBeNull()
    expect(buildTaskGraphExecutionFailureInstruction(context([{ status: "failed", failureReason: null, resultSummary: null }]), [])).toBeNull()
  })

  it("allows report-bearing resume advice only for the canonical typed Scout or Analyst failure", () => {
    for (const role of ["scout", "analyst"] as const) {
      expect(text(buildTaskGraphExecutionFailureInstruction(context([resumeFailedNode(role)]), [])))
        .toContain("For resume-state cues, inspect the current resume state and available evidence.")
    }

    const valid = resumeFailedNode()
    const report = valid.verificationReport
    const criterion = report.criteria[0]!
    const { verificationReport: _report, ...withoutReport } = valid
    const rejected = [
      withoutReport,
      { ...valid, templateId: "writer" },
      { ...valid, verificationReport: { ...report, reasonCode: "contract_invalid",
        criteria: [{ ...criterion, reasonCode: "contract_invalid" }] } },
      { ...valid, verificationReport: { ...report, criteria: [{ ...criterion, status: "failed" }] } },
      { ...valid, verificationReport: { ...report, status: "passed", reasonCode: "criteria_met",
        criteria: [{ ...criterion, status: "passed", reasonCode: "criteria_met" }], evidenceDigest: "a".repeat(64), resultDigest: "b".repeat(64) } },
      { ...valid, verificationReport: { ...report, criteria: [{ ...criterion, criterionId: "other-criterion" }] } },
      { ...valid, verificationReport: { ...report, evidenceDigest: "a".repeat(64), resultDigest: "b".repeat(64) } },
      { ...valid, executionFailureCategory: "structured_output_invalid" },
      { ...valid, native: {} },
      { ...valid, nativeResult: {} },
    ]
    for (const node of rejected) expect(buildTaskGraphExecutionFailureInstruction(context([node]), [])).toBeNull()
  })

  it("does not invoke accessor-backed or proxied current records", () => {
    let getterCalled = false
    const accessorNode = failedNode(categories[0][0])
    Object.defineProperty(accessorNode, "executionFailureCategory", {
      enumerable: true, get: () => { getterCalled = true; return categories[0][0] },
    })
    expect(buildTaskGraphExecutionFailureInstruction(context([accessorNode]), [])).toBeNull()
    expect(getterCalled).toBe(false)

    const badNodes = new Proxy([failedNode(categories[0][0])], { ownKeys: () => { throw new Error("proxy trap") } })
    expect(buildTaskGraphExecutionFailureInstruction(context(badNodes), [])).toBeNull()
  })
})
