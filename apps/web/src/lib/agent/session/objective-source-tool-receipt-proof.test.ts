import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { canonicalTaskGraphReadObservations } from "@jobcopilot/shared/task-graph-read-observations"
import { canonicalTaskGraphReceiptJson } from "@jobcopilot/shared/task-graph-tool-receipt-verification"
import { taskGraphEvidenceDigest, taskGraphResultDigest } from "@jobcopilot/shared/task-graph-verification-digest"
import { parseObjectiveSourceToolReceiptEvidence } from "./objective-source-tool-receipts-contract"
import { proveObjectiveSourceToolReceipts, resolveObjectiveSourceToolScope } from "./objective-source-tool-receipt-proof"
import type { ObjectiveTaskToolReceiptSet } from "./objective-journey-report-requirement-receipts"
import type { ObjectiveJourneyProofContext } from "./objective-journey-report-source"

const sourceKey = `src_${"a".repeat(43)}`, root = "root-1", session = "session-1", turn = "turn-1"
const verification = (role: "scout" | "analyst", check: Record<string, unknown> = { kind: "candidate_count_gte", minimum: 1 }) => ({
  schemaVersion: "agent-harness.v2.task-graph-verification.v1", role, criteria: [{ id: "criterion-1", check }],
})
const jobOutput = { job: { id: "job-1", source: "fixture", location: "Dublin" } }

describe("Objective source tool receipt proof", () => {
  it("proves a current Scout Job receipt and hides persisted identity", () => {
    const fixture = makeFixture("scout"), resolved = resolveObjectiveSourceToolScope(fixture.context, sourceKey)
    const proof = resolved && proveObjectiveSourceToolReceipts(fixture.context, resolved, fixture.read)
    expect(proof).toMatchObject({ graphRevision: 7, sourceKey, role: "scout", receipts: [{ ordinal: 1, toolName: "jobs.get", delivery: "fresh" }] })
    expect(JSON.stringify(proof)).not.toContain("scout-task")
    expect(parseObjectiveSourceToolReceiptEvidence(proof)).toEqual(proof)
  })

  it("revalidates Analyst dependency bindings before exposing a receipt", () => {
    const fixture = makeFixture("analyst"), resolved = resolveObjectiveSourceToolScope(fixture.context, sourceKey)
    expect(resolved?.role).toBe("analyst")
    expect(resolved && proveObjectiveSourceToolReceipts(fixture.context, resolved, fixture.read)).toMatchObject({ role: "analyst" })
    const task = fixture.context.tasks.get("analyst-task") as Record<string, unknown>
    const result = task.result as Record<string, unknown>, report = result.taskGraphVerificationReport as Record<string, unknown>
    task.result = { ...result, taskGraphVerificationReport: { ...report, evidenceDigest: "f".repeat(64) } }
    expect(resolved && proveObjectiveSourceToolReceipts(fixture.context, resolved, fixture.read)).toBeUndefined()
  })

  it("marks a validated replay and durable read, while excluding failed and unrelated receipts", () => {
    const fixture = makeFixture("scout", { durable: true, replay: true }), resolved = resolveObjectiveSourceToolScope(fixture.context, sourceKey)
    const proof = resolved && proveObjectiveSourceToolReceipts(fixture.context, resolved, fixture.read)
    expect(proof?.receipts.map(receipt => [receipt.toolName, receipt.delivery])).toEqual([
      ["jobs.discover", "replayed"], ["tool_results.read", "fresh"],
    ])
    expect(proof?.receipts).not.toHaveLength(4)
  })

  it.each(["historical", "foreign", "leased"])("fails closed for %s source scope", variant => {
    const fixture = makeFixture("scout")
    if (variant === "historical") (fixture.context.manifest.sources[0] as unknown as { resultState: string }).resultState = "missing"
    if (variant === "foreign") fixture.context.tasks.get("scout-task")!.sessionId = "foreign"
    if (variant === "leased") fixture.context.tasks.get("scout-task")!.leaseOwner = "worker"
    expect(resolveObjectiveSourceToolScope(fixture.context, sourceKey)).toBeUndefined()
  })

  it("rejects a forged receipt item outside the current task scope", () => {
    const fixture = makeFixture("scout"), resolved = resolveObjectiveSourceToolScope(fixture.context, sourceKey)
    const forged = { ...fixture.read, items: fixture.read.items.map(item => item.type === "tool_call" ? { ...item, taskId: "foreign-task" } : item) }
    expect(resolved && proveObjectiveSourceToolReceipts(fixture.context, resolved, forged)).toBeUndefined()
  })
})

function makeFixture(role: "scout" | "analyst", options: { durable?: boolean; replay?: boolean } = {}) {
  const scoutNode = { key: "scout-1", taskId: "scout-task", templateId: "scout", dependsOn: [], verificationDisposition: "typed", verification: verification("scout") }
  const analystNode = { key: "analyst-1", taskId: "analyst-task", templateId: "analyst", dependsOn: ["scout-1"], verificationDisposition: "typed",
    verification: verification("analyst", { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout-1" }) }
  const nodes = role === "scout" ? [scoutNode] : [scoutNode, analystNode], taskId = role === "scout" ? "scout-task" : "analyst-task"
  const source = { sourceKey, nodeIndex: role === "scout" ? 0 : 1, role, taskStatus: "completed", resultState: "valid", roleResultStatus: "completed" }
  const evidenceRef = options.durable ? "c123456789012345678901234" : "job-1", evidenceId = `read:job:${evidenceRef}`
  const result = role === "scout" ? { schemaVersion: "agent-harness.v2.subagent.result", role, status: "completed", candidates: [{ jobId: evidenceRef, source: "fixture", url: null, evidenceIds: [evidenceId] }], evidence: [{ id: evidenceId, kind: "job", ref: evidenceRef, source: "fixture" }], summary: "Scout" }
    : { schemaVersion: "agent-harness.v2.subagent.result", role, status: "completed", findings: [{ jobId: evidenceRef, score: 8, evidenceIds: [evidenceId] }], evidence: [{ id: evidenceId, kind: "job", ref: evidenceRef, source: "fixture" }], summary: "Analyst" }
  const items = options.durable ? durableItems(taskId, options.replay) : ordinaryItems(taskId, options.replay), outcomes = new Map(items.filter(item => item.type === "tool_call")
    .map(item => [String((item.content as Record<string, unknown>).toolCallId), (item.content as Record<string, unknown>).status === "failed" ? "failed" as const : "completed" as const]))
  const observations = canonicalTaskGraphReadObservations(items, outcomes), resultDigest = taskGraphResultDigest(result)
  const dependencyBindings = role === "analyst" ? [dependencyBinding(scoutNode)] : undefined
  const reportBase = { verifierVersion: "agent-harness.v2.task-graph-verifier.v1", status: "passed", reasonCode: "criteria_met",
    criteria: [{ criterionId: "criterion-1", status: "passed", reasonCode: "criteria_met" }], resultDigest,
    evidenceDigest: taskGraphEvidenceDigest(items, outcomes, [evidenceId], resultDigest,
      options.replay ? [{ currentCallId: String((items[0]!.content as Record<string, unknown>).toolCallId), sourceCallItem: ["old-call", 0], sourceResultItem: ["old-result", 0] }] : []),
    ...(dependencyBindings ? { dependencyBindings } : {}) }
  const task = taskRow(taskId, role, { ...envelope(result, reportBase) }), dependency = role === "analyst" ? taskRow("scout-task", "scout", scoutEnvelope()) : undefined
  const context = { userId: "user-1", sessionId: session, sourceTurnId: turn, rootTaskId: root, finalItemId: "final-1", graphRevision: 7,
    manifest: { schemaVersion: "agent-harness.v2.task-graph-sources.v1", graphRevision: 7, sources: [source] }, sidecar: {},
    progress: { nodes: nodes.map(node => ({ key: node.key, taskId: node.taskId, templateId: node.templateId })) }, graphNodes: nodes,
    sourceGroups: { schemaVersion: "agent-harness.v2.objective-tailor-source-groups.v1", graphRevision: 7, groups: { discoveredJobs: role === "scout" ? [sourceKey] : [], analyzedJobs: role === "analyst" ? [sourceKey] : [] } },
    tasks: new Map([[taskId, task], ...(dependency ? [["scout-task", dependency] as const] : [])]) } as unknown as ObjectiveJourneyProofContext
  const replayReceipts: ObjectiveTaskToolReceiptSet["replayReceipts"] = options.replay ? [{
    currentCallId: String((items[0]!.content as Record<string, unknown>).toolCallId), sourceCallItem: ["old-call", 0], sourceResultItem: ["old-result", 0],
  }] : []
  const read: ObjectiveTaskToolReceiptSet = { items, outcomes, replayReceipts, evidenceObservations: observations }
  return { context, read }
}

function ordinaryItems(taskId: string, replay = false) {
  const callId = replay ? "task-graph-replay-v1:replayed" : "call-1"
  const call = item(taskId, "tool_call", { toolCallId: callId, toolName: "jobs.get", toolVersion: "1", input: { jobId: "job-1" }, status: "completed", errorCode: null })
  const result = item(taskId, "tool_result", { toolCallId: callId, output: jobOutput, errorCode: null })
  return [call, result, ...failedItem(taskId)]
}
function durableItems(taskId: string, replay = false) {
  const payload = JSON.stringify({ jobs: [{ id: "c123456789012345678901234", title: "Engineer", company: "Example", location: "Dublin",
    url: "https://jobs.example/1", description: "Role", fullDescription: "Role details", salary: null, logo: null, source: "fixture", evidenceRefs: ["source-1"] }],
    evidence: [{ evidenceId: "source-1", jobId: "c123456789012345678901234", kind: "source", source: "fixture", url: "https://jobs.example/1", summary: "Listing" }],
    nextCursor: null, usage: { toolName: "jobs.discover", toolVersion: "1", requests: 1, jobsProcessed: 1, jobsSucceeded: 1,
      jobsFailed: 0, aiCalls: 0, providers: ["fixture"], estimatedCostUsd: 0, durationMs: 1 } }), ref = "tool-result-12345678-1234-4123-8123-123456789012"
  const sha256 = createHash("sha256").update(payload).digest("hex"), discovery = item(taskId, "tool_call", { toolCallId: replay ? "task-graph-replay-v1:discover" : "discover-1", toolName: "jobs.discover", toolVersion: "1", input: {}, status: "completed", errorCode: null })
  const discoveryResult = item(taskId, "tool_result", { toolCallId: replay ? "task-graph-replay-v1:discover" : "discover-1", output: { $ref: ref, sizeBytes: Buffer.byteLength(payload), sha256 }, errorCode: null })
  const read = item(taskId, "tool_call", { toolCallId: "read-1", toolName: "tool_results.read", toolVersion: "1", input: { referenceId: ref }, status: "completed", errorCode: null })
  const readResult = item(taskId, "tool_result", { toolCallId: "read-1", output: { ref, sha256, byteCount: Buffer.byteLength(payload), chunk: payload, nextCursor: null }, errorCode: null })
  return [discovery, discoveryResult, read, readResult]
}
function failedItem(taskId: string) { return [item(taskId, "tool_call", { toolCallId: "failed-1", toolName: "jobs.get", toolVersion: "1", input: { jobId: "other" }, status: "failed", errorCode: "provider_failed" }, true), item(taskId, "tool_result", { toolCallId: "failed-1", output: null, errorCode: "provider_failed" }, true)] }
function item(taskId: string, type: "tool_call" | "tool_result", content: Record<string, unknown>, failed = false) {
  return { id: `${type}-${String(content.toolCallId)}`, sessionId: session, turnId: turn, taskId, rootTaskId: root, turnRootTaskId: root,
    stepId: `step-${String(content.toolCallId)}`, joinedStepId: `step-${String(content.toolCallId)}`, type, status: "completed", revision: 0, attempt: 1, ordinal: failed ? 1 : 0,
    stepStatus: "completed", content }
}
function envelope(result: Record<string, unknown>, report: Record<string, unknown>) { return { finalItemId: null, finalText: "done", status: "completed", stepCount: 1,
  toolCallCount: 1, structuredResult: result, taskGraphVerificationReport: report } }
function taskRow(id: string, role: "scout" | "analyst", result: Record<string, unknown>) { return { id, sessionId: session, turnId: turn, rootTaskId: root, parentTaskId: root,
  role, taskType: role === "scout" ? "job_discovery" : "job_analysis", status: "completed", attemptCount: 1, failureReason: null, leaseOwner: null, leaseExpiresAt: null, result } }
function scoutEnvelope() { const result = { schemaVersion: "agent-harness.v2.subagent.result", role: "scout", status: "completed", candidates: [], evidence: [], summary: "Scout" }, report = {
  verifierVersion: "agent-harness.v2.task-graph-verifier.v1", status: "passed", reasonCode: "criteria_met", criteria: [{ criterionId: "criterion-1", status: "passed", reasonCode: "criteria_met" }],
  resultDigest: taskGraphResultDigest(result), evidenceDigest: "e".repeat(64) }; return envelope(result, report) }
function dependencyBinding(node: Record<string, unknown>) { const depResult = (scoutEnvelope().structuredResult as Record<string, unknown>), depReport = scoutEnvelope().taskGraphVerificationReport as Record<string, unknown>
  return { nodeKey: "scout-1", taskId: "scout-task", attemptCount: 1, nodeDigest: digest(node), resultDigest: taskGraphResultDigest(depResult), evidenceDigest: depReport.evidenceDigest, reportDigest: digest(depReport) } }
function digest(value: unknown) { return createHash("sha256").update(canonicalTaskGraphReceiptJson(value)).digest("hex") }
