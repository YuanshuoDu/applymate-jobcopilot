import { describe, expect, it } from "vitest"
import { TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SIZE, parseTaskGraphHistoricalDiscoveryPage } from "../subagents/task-graph-historical-discovery-page-contract.js"
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA } from "../subagents/task-graph-command-port.js"
import type { TaskGraphCurrentNode } from "../subagents/task-graph-command-port.js"
import { ROLE_RESULT_SCHEMA, validateRoleResult } from "../subagents/role-results.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "../subagents/task-graph-verification-report.js"
import { taskGraphResultDigest } from "../subagents/task-graph-pg-verification.js"
import { TASK_GRAPH_SNAPSHOT_VERSION, parseTaskGraphSnapshot } from "../subagents/task-graph-snapshot.js"
import type { GraphTaskRow } from "../subagents/task-graph-pg-state.js"
import { TASK_GRAPH_TEMPLATES } from "../subagents/task-graph-templates.js"
import {
  historicalDiscoverySourceToken,
  pageForHistoricalDiscoverySelection,
  selectOrdinaryHistoricalScout,
  unavailableHistoricalDiscoveryPage,
  type HistoricalDiscoveryTokenBinding,
  type HistoricalDiscoveryTaskBinding,
} from "./root-task-history-result-page-selection.js"

const CUID = (n: number) => `c${String(n).padStart(24, "0")}`
const criteria = [{ id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: 1 } }]
function reportFor(result: unknown) {
  return { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed" as const, reasonCode: "criteria_met" as const,
  criteria: [{ criterionId: "candidate-count", status: "passed" as const, reasonCode: "criteria_met" as const }],
  evidenceDigest: "a".repeat(64), resultDigest: taskGraphResultDigest(validateRoleResult(result, "scout")),
  }
}

function fixture(jobIds: readonly string[] = [CUID(1)], status: "completed" | "partial" = "completed", summary = "safe result") {
  const result = {
    schemaVersion: ROLE_RESULT_SCHEMA,
    role: "scout",
    status,
    candidates: jobIds.map((jobId, index) => ({ jobId, source: "greenhouse", url: null, evidenceIds: [`job-${index}`] })),
    evidence: jobIds.map((jobId, index) => ({ id: `job-${index}`, kind: "job", ref: jobId, source: "greenhouse" })),
    summary,
  }
  const verificationReport = reportFor(result)
  const node = parseTaskGraphSnapshot({
    schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
    nodes: [{
      key: "scout-a", templateId: "scout", goal: "Find roles", successCriteria: ["Find at least one role"],
      dependsOn: [], depth: 1, taskId: "task-scout-a", verificationDisposition: "typed",
      verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria },
      registeredScoutEnvelope: {
        role: "scout", taskType: "job_discovery", expectedOutputSchema: TASK_GRAPH_TEMPLATES.scout.expectedOutputSchema,
        allowedActions: [...TASK_GRAPH_TEMPLATES.scout.allowedActions],
      },
    }],
  }).nodes[0]!
  const current: TaskGraphCurrentNode = {
    key: node.key, templateId: node.templateId, goal: node.goal, successCriteria: node.successCriteria,
    dependsOn: node.dependsOn, taskId: node.taskId, status: "completed", readiness: "terminal",
    resultSummary: null, failureReason: null, verificationCriterionIds: ["candidate-count"], verification: node.verification,
    verificationReport,
    resultProjection: {
      schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available",
      role: "scout", status, candidateCount: jobIds.length, evidenceCount: jobIds.length, candidates: [],
    },
  }
  const task: GraphTaskRow = {
    id: node.taskId, status: "completed", role: "scout", taskType: "job_discovery",
    expectedOutputSchema: TASK_GRAPH_TEMPLATES.scout.expectedOutputSchema, attemptCount: 1, failureReason: null,
    result: {
      finalItemId: "final-scout", finalText: "", status: "completed", stepCount: 1, toolCallCount: 1,
      structuredResult: result, taskGraphVerificationReport: verificationReport,
    },
  }
  const binding: HistoricalDiscoveryTaskBinding = {
    allowedActions: [...TASK_GRAPH_TEMPLATES.scout.allowedActions], contextIsObject: true, hasPrivateSelectionContext: false,
  }
  return { node, current, task, binding }
}

const tokenBinding: HistoricalDiscoveryTokenBinding = {
  current: {
    userId: "user", sessionId: "session-current", turnId: "turn-current", rootTaskId: "root-current",
    turnLeaseOwner: "worker", turnLeaseVersion: 3, parentLeaseOwner: "worker", rootAttemptCount: 2,
  },
  objectiveDigest: "c".repeat(64),
  source: {
    sessionId: "session-source", turnId: "turn-source", rootTaskId: "root-source", terminalSequence: "17",
    terminalStatus: "completed", terminalReceiptDigest: "d".repeat(64), graphRevision: 4,
    nodeKey: "scout-a", taskId: "task-scout-a", attemptCount: 1, sourceResultStatus: "completed", resultIdsDigest: "e".repeat(64),
  },
}

describe("historical discovery result selection", () => {
  it("accepts a typed ordinary Scout with a separately matched report and a completed result", () => {
    const value = fixture([CUID(1), CUID(1), CUID(2)], "completed")
    const selected = selectOrdinaryHistoricalScout(value.node, value.current, value.task, value.binding)
    expect(selected).toMatchObject({ jobIds: [CUID(1), CUID(2)], sourceResultStatus: "completed", truncated: false })
  })

  it("rejects a structurally valid partial Scout result because typed completion cannot attest it", () => {
    const value = fixture([CUID(1)], "partial")
    expect(selectOrdinaryHistoricalScout(value.node, value.current, value.task, value.binding)).toBeUndefined()
  })

  it("rejects the whole source when any candidate ID is noncanonical", () => {
    const value = fixture([CUID(1), "not-a-canonical-id"])
    expect(selectOrdinaryHistoricalScout(value.node, value.current, value.task, value.binding)).toBeUndefined()
  })

  it("rejects legacy, private-context, policy-mismatched, repair, and report-mismatched nodes", () => {
    const value = fixture()
    expect(selectOrdinaryHistoricalScout({ ...value.node, verificationDisposition: "legacy_unverified" }, value.current, value.task, value.binding)).toBeUndefined()
    expect(selectOrdinaryHistoricalScout(value.node, value.current, value.task, { ...value.binding, hasPrivateSelectionContext: true })).toBeUndefined()
    expect(selectOrdinaryHistoricalScout(value.node, value.current, value.task, {
      ...value.binding, allowedActions: [...TASK_GRAPH_TEMPLATES.scout.allowedActions].reverse(),
    })).toBeUndefined()
    expect(selectOrdinaryHistoricalScout({ ...value.node, repairOf: { graphRootTaskId: "root-source", nodeKey: "target", taskId: "target", criterionIds: ["candidate-count"] } }, value.current, value.task, value.binding)).toBeUndefined()
    const changedReport = { ...value.task, result: { ...(value.task.result as Record<string, unknown>), taskGraphVerificationReport: { ...(value.current.verificationReport as object), resultDigest: "f".repeat(64) } } }
    expect(selectOrdinaryHistoricalScout(value.node, value.current, changedReport, value.binding)).toBeUndefined()
    expect(selectOrdinaryHistoricalScout({ ...value.node, registeredScoutEnvelope: { ...value.node.registeredScoutEnvelope!, taskType: "other" } }, value.current, value.task, value.binding)).toBeUndefined()
    expect(selectOrdinaryHistoricalScout(value.node, { ...value.current, native: {} as NonNullable<TaskGraphCurrentNode["native"]> }, value.task, value.binding)).toBeUndefined()
    const malformed = { ...value.task, result: { ...(value.task.result as Record<string, unknown>), extraField: true } }
    expect(selectOrdinaryHistoricalScout(value.node, value.current, malformed, value.binding)).toBeUndefined()
    const noReport = { ...value.task, result: { ...(value.task.result as Record<string, unknown>) } }
    delete (noReport.result as Record<string, unknown>).taskGraphVerificationReport
    expect(selectOrdinaryHistoricalScout(value.node, value.current, noReport, value.binding)).toBeUndefined()
  })

  it("rejects a valid-looking result changed after its persisted verification report", () => {
    const value = fixture()
    const stored = value.task.result as Record<string, unknown>
    const structuredResult = { ...(stored.structuredResult as Record<string, unknown>), summary: "tampered after verification" }
    const task = { ...value.task, result: { ...stored, structuredResult } }
    expect(selectOrdinaryHistoricalScout(value.node, value.current, task, value.binding)).toBeUndefined()
  })

  it("allows a validated source when its compact projection is unavailable", () => {
    const value = fixture([CUID(1)], "completed")
    const current = { ...value.current, resultProjection: {
      schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted" as const, availability: "unavailable" as const,
    } }
    expect(selectOrdinaryHistoricalScout(value.node, current, value.task, value.binding)).toMatchObject({ jobIds: [CUID(1)], truncated: false })
  })

  it("rejects structured results beyond the 256 KiB source bound", () => {
    const value = fixture([CUID(1)], "completed", "x".repeat(256 * 1024))
    const current = { ...value.current, resultProjection: {
      schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted" as const, availability: "unavailable" as const,
    } }
    expect(selectOrdinaryHistoricalScout(value.node, current, value.task, value.binding)).toBeUndefined()
  })

  it("caps deduplicated IDs at 24 and marks the resulting page as truncated", () => {
    const value = fixture(Array.from({ length: 26 }, (_, index) => CUID(index + 1)), "completed")
    const selected = selectOrdinaryHistoricalScout(value.node, value.current, value.task, value.binding)!
    expect(selected.jobIds).toHaveLength(24)
    expect(selected.truncated).toBe(true)
    const page = parseTaskGraphHistoricalDiscoveryPage(pageForHistoricalDiscoverySelection(selected, tokenBinding, { offset: 0 }))
    expect(page).toMatchObject({ availability: "available", totalCount: 24, truncated: true })
  })

  it("binds page continuations and emits only closed available or unavailable pages", () => {
    const value = fixture(Array.from({ length: 5 }, (_, index) => CUID(index + 1)), "completed")
    const selected = selectOrdinaryHistoricalScout(value.node, value.current, value.task, value.binding)!
    const first = parseTaskGraphHistoricalDiscoveryPage(pageForHistoricalDiscoverySelection(selected, tokenBinding, { offset: 0 }))
    if (!first || first.availability !== "available") throw new Error("expected an available first historical page")
    expect(first).toMatchObject({ availability: "available", sourceResultStatus: "completed", nextOffset: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SIZE })
    const next = parseTaskGraphHistoricalDiscoveryPage(pageForHistoricalDiscoverySelection(selected, tokenBinding, {
      offset: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SIZE, sourceToken: first.sourceToken,
    }))
    expect(next).toMatchObject({ availability: "available", offset: 3, nextOffset: null })
    expect(parseTaskGraphHistoricalDiscoveryPage(pageForHistoricalDiscoverySelection(selected, tokenBinding, { offset: 3, sourceToken: "0".repeat(64) })))
      .toEqual(unavailableHistoricalDiscoveryPage("source_changed"))
    expect(parseTaskGraphHistoricalDiscoveryPage(pageForHistoricalDiscoverySelection(selected, tokenBinding, { offset: 24, sourceToken: first.sourceToken })))
      .toEqual(unavailableHistoricalDiscoveryPage("offset_out_of_range"))
  })

  it("changes the source token when the validated structured result IDs change", () => {
    expect(historicalDiscoverySourceToken(tokenBinding)).not.toBe(historicalDiscoverySourceToken({
      ...tokenBinding, source: { ...tokenBinding.source, resultIdsDigest: "f".repeat(64) },
    }))
  })
})
