import { describe, expect, it } from "vitest"

import { finalizeTurn, nativeFinalCandidateMatches, serializeFinalResponse, taskGraphFinalSummaryCopiesMatch } from "./finalizer.js"
import { buildGroundedTaskGraphFinalResponse } from "./subagents/task-graph-final-response.js"
import { buildTaskGraphFinalSummaryBinding, TASK_GRAPH_FINAL_SUMMARY_BINDING, type TaskGraphFinalSummaryBinding } from "./subagents/task-graph-final-summary-binding.js"
import { formatTaskGraphFinalSummary } from "./subagents/task-graph-final-summary-format.js"
import { buildTaskGraphFinalSourceManifest } from "./subagents/task-graph-final-source-manifest.js"
import { taskGraphItemId } from "./subagents/task-graph-snapshot.js"
import type { GraphTaskRow, LoadedGraph } from "./subagents/task-graph-pg-state.js"

function graphBinding(taskId = "task-1", graphRevision = 1): TaskGraphFinalSummaryBinding {
  const task: GraphTaskRow = { id: taskId, role: "scout", taskType: "research", status: "completed", failureReason: null,
    result: { status: "completed" } }
  const loaded = {
    rootTaskId: "root-1", item: { id: taskGraphItemId("root-1"), revision: graphRevision, content: {}, createdAt: new Date(0) },
    snapshot: { nodes: [{ taskId, key: "research", templateId: "scout" }] }, state: { revision: graphRevision }, tasks: new Map([[taskId, task]]),
  } as unknown as LoadedGraph
  const binding = buildTaskGraphFinalSummaryBinding(loaded)
  if (!binding) throw new Error("Expected a current TaskGraph final-summary binding")
  return binding
}

function boundTerminal(binding: TaskGraphFinalSummaryBinding, responseText: string, finalItemId = "final-item-1") {
  const summary = formatTaskGraphFinalSummary(binding.summary)
  const final = finalizeTurn({ goal: "Find a role", verification: { ok: true, evidenceRefs: [], businessChecks: [] },
    terminalReason: "goal_satisfied", response: responseText, summaryOverride: summary,
    usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 }, stepCount: 1, toolCallCount: 0 })
  const taskGraphSources = buildTaskGraphFinalSourceManifest(binding, finalItemId)
  if (!taskGraphSources) throw new Error("Expected a current TaskGraph source manifest")
  const finalContent = { text: responseText, final, taskGraphSources }
  const response = serializeFinalResponse(final)
  return { finalItemId, finalContent, response, [TASK_GRAPH_FINAL_SUMMARY_BINDING]: binding }
}

describe("deterministic finalizer", () => {
  it("always emits the required final shape and attributable usage", () => {
    const response = finalizeTurn({ goal: "Find a role", terminalReason: "budget_exhausted", blocker: "Budget exhausted", usage: { inputTokens: 4, outputTokens: 3, estimatedCostUsd: 0.02 }, stepCount: 2, toolCallCount: 1, next: ["Resume", "Resume"] })
    expect(response).toMatchObject({ completed: false, notCompleted: ["Find a role"], blocker: "Budget exhausted", next: ["Resume"], usage: { inputTokens: 4, outputTokens: 3, estimatedCostUsd: 0.02 } })
    expect(response).not.toHaveProperty("answerEvidence")
    expect(JSON.parse(serializeFinalResponse(response))).toEqual(response)
  })

  it("replaces only the advisory summary while preserving the candidate response", () => {
    const response = finalizeTurn({ goal: "Find a role", verification: { ok: true, evidenceRefs: [], businessChecks: [] }, terminalReason: "goal_satisfied", response: "verified model candidate",
      summaryOverride: "Task-reported results: discovered jobs: 1 (complete).",
      usage: { inputTokens: 1, outputTokens: 2, estimatedCostUsd: 0.01 }, stepCount: 3, toolCallCount: 2 })
    expect(response.response).toBe("verified model candidate")
    expect(response.summary).toBe("Task-reported results: discovered jobs: 1 (complete).")
    expect(response).toMatchObject({ completedTasks: ["Turn goal"], notCompleted: [], stepCount: 3, toolCallCount: 2 })
  })

  it("omits invalid answer evidence without changing the final response or completion decision", () => {
    const response = finalizeTurn({ goal: "Find a role", verification: { ok: true, evidenceRefs: [], businessChecks: [] }, terminalReason: "goal_satisfied",
      response: "Role found.", answerEvidence: { schemaVersion: 1, sources: [{ key: "S1", kind: "job", label: "Engineer", excerpt: "Dublin role." }], rawOutput: "PRIVATE_OUTPUT" },
      usage: { inputTokens: 1, outputTokens: 2, estimatedCostUsd: 0.01 }, stepCount: 3, toolCallCount: 2 })

    expect(response.completed).toBe(true)
    expect(response.response).toBe("Role found.")
    expect(response).not.toHaveProperty("answerEvidence")
    expect(serializeFinalResponse(response)).not.toContain("PRIVATE_OUTPUT")
  })

  it("accepts the deterministic bound response while retaining the raw model candidate for native proof", () => {
    const binding = graphBinding()
    const rawModelCandidate = "All requested jobs were prepared and every application was submitted."
    const groundedResponse = buildGroundedTaskGraphFinalResponse(binding)
    const terminal = boundTerminal(binding, groundedResponse)
    const saved = JSON.parse(terminal.response) as { response: string; summary: string }

    expect(groundedResponse).not.toBe(rawModelCandidate)
    expect(nativeFinalCandidateMatches(terminal, groundedResponse, rawModelCandidate)).toBe(true)
    expect(nativeFinalCandidateMatches(terminal, rawModelCandidate, rawModelCandidate)).toBe(false)
    expect(taskGraphFinalSummaryCopiesMatch(binding, graphBinding(), terminal.finalContent, terminal.response, terminal.finalItemId)).toBe(true)
    expect(terminal.finalContent.text).toBe(groundedResponse)
    expect(terminal.finalContent.final.response).toBe(groundedResponse)
    expect(saved.response).toBe(groundedResponse)
    expect(saved.summary).toBe(formatTaskGraphFinalSummary(binding.summary))
  })

  it("rejects matching but noncanonical copies even when the bound summary remains correct", () => {
    const binding = graphBinding()
    const groundedResponse = buildGroundedTaskGraphFinalResponse(binding)
    const terminal = boundTerminal(binding, groundedResponse)
    const wrongResponse = "Wrong reply copied consistently across the final item and serialized response."
    const wrongFinal = { ...terminal.finalContent.final, response: wrongResponse }
    const wrongContent = { ...terminal.finalContent, text: wrongResponse, final: wrongFinal }
    const wrongSerialized = serializeFinalResponse(wrongFinal)

    expect(wrongFinal.summary).toBe(formatTaskGraphFinalSummary(binding.summary))
    expect(wrongContent.text).toBe(wrongResponse)
    expect(wrongFinal.response).toBe(wrongResponse)
    expect((JSON.parse(wrongSerialized) as { response: string }).response).toBe(wrongResponse)
    expect(nativeFinalCandidateMatches({ ...terminal, finalContent: wrongContent, response: wrongSerialized }, wrongResponse, "raw model candidate")).toBe(false)
    expect(taskGraphFinalSummaryCopiesMatch(binding, graphBinding(), wrongContent, wrongSerialized, terminal.finalItemId)).toBe(false)
    expect(taskGraphFinalSummaryCopiesMatch(binding, graphBinding("task-stale"), terminal.finalContent, terminal.response, terminal.finalItemId)).toBe(false)
    expect(taskGraphFinalSummaryCopiesMatch(binding, graphBinding(), {
      ...terminal.finalContent, taskGraphSources: { ...terminal.finalContent.taskGraphSources, sources: [] },
    }, terminal.response, terminal.finalItemId)).toBe(false)
    expect(taskGraphFinalSummaryCopiesMatch(binding, graphBinding(), terminal.finalContent, terminal.response, "different-final-item")).toBe(false)
  })

  it("preserves exact candidate matching for unbound final responses", () => {
    const rawModelCandidate = "A verified answer without a TaskGraph binding."
    const final = finalizeTurn({ goal: "Find a role", verification: { ok: true, evidenceRefs: [], businessChecks: [] },
      terminalReason: "goal_satisfied", response: rawModelCandidate,
      usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 }, stepCount: 1, toolCallCount: 0 })
    const finalContent = { text: rawModelCandidate, final }
    const response = serializeFinalResponse(final)
    const terminal = { finalContent, response }

    expect(nativeFinalCandidateMatches(terminal, rawModelCandidate, rawModelCandidate)).toBe(true)
    expect(nativeFinalCandidateMatches(terminal, "different persisted text", rawModelCandidate)).toBe(false)
    expect(taskGraphFinalSummaryCopiesMatch(undefined, undefined, finalContent, response, "final-item-1")).toBe(true)
  })
})
