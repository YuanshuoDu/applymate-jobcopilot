import { Pool } from "pg"
import { createCanonicalTurnRuntime } from "../canonical-turn-runtime.ts"
import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.ts"
import { ROLE_RESULT_SCHEMA } from "./role-results.ts"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.ts"
import { createProductionWorkerBootstrap } from "../../queue/production-bootstrap.ts"
import { enqueueTurn } from "../turns/turn-queue.ts"
import { parsePlanLedger, projectPlanLedger } from "@jobcopilot/agent-protocol"

const [, , mode, rawIds] = process.argv, ids = JSON.parse(rawIds)
const sourceGoal = "Read the durable TaskGraph source", dependentGoal = "Summarize the restored TaskGraph source"
const followUpGoal = "Verify the restored TaskGraph summary after restart", followUpKey = "verification"
const TASK_GRAPH_KEY_ALLOWLIST = new Set(["source", "summary", followUpKey])
const TURN_STATUS_ALLOWLIST = new Set(["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user", "completed", "interrupted", "failed", "cancelled"])
const STEP_STATUS_ALLOWLIST = new Set(["completed", "failed", "interrupted", "waiting_for_tool", "waiting_for_approval", "waiting_for_user"])
const ROOT_TASK_STATUS_ALLOWLIST = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"])
const ITEM_LIFECYCLE_STATUS_ALLOWLIST = new Set(["started", "completed", "failed", "cancelled"])
const TOOL_CALL_STATUS_ALLOWLIST = new Set(["started", "completed", "failed", "interrupted"])
const WAIT_OUTPUT_STATUS_ALLOWLIST = new Set(["waiting", "ready", "timed_out"])
const STEP_ERROR_CLASS_BY_CODE = new Map([
  ["40p01", "database_deadlock"], ["40001", "database_serialization"], ["55p03", "database_lock_wait"],
  ["coordination_invalid_input", "coordination_invalid_input"], ["coordination_task_not_found", "coordination_task_not_found"],
  ["coordination_scope_error", "coordination_scope_error"], ["coordination_wait_unavailable", "coordination_wait_unavailable"],
  ["wait_invalid", "wait_handoff_state"], ["wait_scope_error", "wait_handoff_state"], ["lease_lost", "turn_lease_state"],
  ["tool_execution_failed", "generic_tool_execution_failed"],
])
const resultMarker = "p3-process-restart-source-result", finalMarker = "p3-process-restart-parent-resumed-after-follow-up"
const planCallId = "p3-process-restart-plan", waitCallId = "p3-process-restart-wait"
const followUpPlanCallId = "p3-process-restart-follow-up-plan", followUpWaitCallId = "p3-process-restart-follow-up-wait"
const pool = new Pool({ connectionString: process.env.AGENT_RUNTIME_PG_TEST_URL, max: 5 })
let bootstrap
let stdinBuffer = ""
let initialWaitLineage = null
const queuedCommands = []
const commandWaiters = new Map()
process.stdin.setEncoding("utf8")
function onStdinData(chunk) {
  stdinBuffer += chunk
  const lines = stdinBuffer.split("\n")
  stdinBuffer = lines.pop() ?? ""
  for (const command of lines.map(line => line.trim()).filter(Boolean)) { const waiters = commandWaiters.get(command), resolve = waiters?.shift()
    if (resolve) { if (!waiters.length) commandWaiters.delete(command); resolve() } else queuedCommands.push(command) }
}
process.stdin.on("data", onStdinData)
function say(value) { process.stdout.write(value + "\n") }
function boundedFailureText(error) {
  const detail = error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : String(error)
  return detail.replace(/\s+/g, " ").slice(0, 1200)
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
function waitForCommand(command) {
  const index = queuedCommands.indexOf(command)
  if (index >= 0) { queuedCommands.splice(index, 1); return Promise.resolve() }
  return new Promise(resolve => { const waiters = commandWaiters.get(command) ?? []; waiters.push(resolve); commandWaiters.set(command, waiters) })
}
function record(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : null }
function turnErrorCategory(value) {
  if (typeof value !== "string") return "none"
  const prefix = value.slice(0, 2_000)
  if (prefix.trim().length === 0) return "none"
  const normalized = prefix.toLowerCase()
  if (/\b40p01\b|deadlock detected|deadlock found/.test(normalized)) return "database_deadlock"
  if (/\b40001\b|serialization failure/.test(normalized)) return "database_serialization"
  if (/\b55p03\b|\block_not_available\b|lock timeout/.test(normalized)) return "database_lock_wait"
  if (/\bwait_(?:invalid|scope_error)\b|durablewaithandofferror/.test(normalized)) return "wait_handoff_state"
  if (/\blease_lost\b|turnleaseerror/.test(normalized)) return "turn_lease_state"
  return "other"
}
function modelStepErrorClass(value) {
  if (typeof value !== "string") return "none"
  const code = value.slice(0, 2_000).trim().toLowerCase()
  return code.length === 0 ? "none" : STEP_ERROR_CLASS_BY_CODE.get(code) ?? "other"
}
function fixedEnum(value, allowlist) {
  return value === null || value === undefined ? "none" : typeof value === "string" && allowlist.has(value) ? value : "other"
}
function waitFailureCategory(tool) {
  if (!tool.hasWaitToolCall) return "none"
  const errorClass = modelStepErrorClass(tool.waitToolErrorCode ?? tool.waitToolCallErrorCode)
  if (errorClass !== "none") return errorClass
  if (tool.waitToolCallStatus === "failed") return "generic_tool_execution_failed"
  return tool.hasWaitToolResult ? "none" : "tool_result_missing"
}
function taskStatusCounts(rows) {
  return rows.reduce((counts, row) => {
    const status = fixedEnum(row.status, ROOT_TASK_STATUS_ALLOWLIST)
    const key = status === "none" ? "other" : status
    counts[key] = (counts[key] ?? 0) + Number(row.count)
    return counts
  }, {})
}
function parentSuspensionProjection(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.waits)) return { diagnosticsAvailable: false }
  const matchedWaits = snapshot.waits.filter(wait => wait.matchesLatestWaitToolCall)
  const rootWaits = matchedWaits.filter(wait => wait.parentMatchesRoot)
  return {
    turnStatus: fixedEnum(snapshot.turnStatus, TURN_STATUS_ALLOWLIST),
    rootTaskStatus: snapshot.rootTaskStatus,
    latestModelStepStatus: fixedEnum(snapshot.latestModelStep?.status, STEP_STATUS_ALLOWLIST),
    latestModelStepErrorClass: snapshot.latestModelStep?.errorClass ?? "none",
    turnErrorCategory: snapshot.turnErrorCategory ?? "none",
    planAccepted: snapshot.planReceiptStatuses.some(status => status === "accepted" || status === "duplicate"),
    waitToolCallStatus: snapshot.waitToolCallStatus,
    waitToolCallLifecycleStatus: fixedEnum(snapshot.waitToolCallLifecycleStatus, ITEM_LIFECYCLE_STATUS_ALLOWLIST),
    waitToolResultLifecycleStatus: fixedEnum(snapshot.waitToolResultLifecycleStatus, ITEM_LIFECYCLE_STATUS_ALLOWLIST),
    waitToolOutputStatus: snapshot.waitToolOutputStatus,
    waitFailureCategory: snapshot.waitFailureCategory,
    waits: {
      count: snapshot.waits.length,
      rootCount: rootWaits.length,
      suspendedRootCount: rootWaits.filter(wait => wait.status === "waiting" && wait.hasSuspendedAt).length,
    },
    waitCallIdempotencyKeyPresent: snapshot.waitCallIdempotencyKeyPresent,
    graphNodeCount: snapshot.graph.nodeCount,
    initialWaitLineage: snapshot.initialWaitLineage,
    targetCounts: {
      requested: snapshot.requestedTaskCount,
      graphMatches: snapshot.requestedGraphMatchCount,
      taskRows: snapshot.requestedTaskRowMatchCount,
      graphRows: snapshot.graphTaskRowMatchCount,
    },
    missingKeys: {
      requestedGraph: snapshot.missingRequestedGraphTaskKeys,
      graphTasks: snapshot.missingGraphTaskKeys,
    },
    childStatusCounts: snapshot.childStatusCounts,
    likelyCause: snapshot.likelyCause,
  }
}
function stringArray(value) {
  let parsed = value
  if (typeof value === "string") {
    try { parsed = JSON.parse(value) } catch { return null }
  }
  return Array.isArray(parsed) && parsed.every(item => typeof item === "string") ? parsed : null
}
function isExpectedSourceProjection(value) {
  const projection = record(value), candidates = Array.isArray(projection?.candidates) ? projection.candidates.map(record) : [], candidate = candidates[0]
  return projection?.schemaVersion === "agent-harness.v2.task-graph.result-projection" && projection.trust === "untrusted"
    && projection.availability === "available" && projection.role === "scout" && projection.status === "completed"
    && projection.candidateCount === 1 && projection.evidenceCount === 1 && candidates.length === 1
    && candidate?.jobId === "fixture-job-restart" && candidate.source === "other"
    && Array.isArray(candidate.evidenceKinds) && candidate.evidenceKinds.length === 1 && candidate.evidenceKinds[0] === "job"
}
function latestToolResult(request, callId) {
  const messages = request.messages
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const content = messages[messageIndex]?.content ?? []
    for (let partIndex = content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = content[partIndex]
      if (part?.type !== "tool_result" || part.toolUseId !== callId) continue
      if (typeof part.content !== "string") return null
      try { return JSON.parse(part.content) } catch { return null }
    }
  }
  return null
}
function plannedTaskIds(request, callId = planCallId, expectedCount = 2) {
  const result = record(latestToolResult(request, callId))
  if (result?.status !== "accepted" || !Array.isArray(result.nodes)) throw new Error("p3_plan_receipt_missing")
  const taskIds = result.nodes.map(node => record(node)?.taskId)
  if (taskIds.length !== expectedCount || taskIds.some(taskId => typeof taskId !== "string")) throw new Error("p3_plan_task_ids_missing")
  return taskIds
}
function graphFromRequest(request) {
  const messages = request.messages
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const content = messages[messageIndex]?.content ?? []
    for (let partIndex = content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = content[partIndex]
      if (part?.type !== "text" || !part.text.includes('"kind":"task_graph_current"')) continue
      try { return record(JSON.parse(part.text.slice(part.text.indexOf("\n") + 1))) } catch { return null }
    }
  }
  return null
}
function nodeTaskMap(nodes) {
  if (!Array.isArray(nodes)) return null
  const byKey = new Map()
  const taskIds = new Set()
  for (const value of nodes) {
    const taskNode = record(value)
    if (typeof taskNode?.key !== "string" || typeof taskNode.taskId !== "string"
      || byKey.has(taskNode.key) || taskIds.has(taskNode.taskId)) return null
    byKey.set(taskNode.key, taskNode.taskId)
    taskIds.add(taskNode.taskId)
  }
  return byKey
}
function sortedTaskGraphPairs(nodes) {
  const byKey = nodeTaskMap(nodes)
  return byKey ? [...byKey].sort(([left], [right]) => left.localeCompare(right)) : null
}
function compareTaskGraphNodes(left, right) {
  const leftPairs = sortedTaskGraphPairs(left), rightPairs = sortedTaskGraphPairs(right)
  return leftPairs && rightPairs && leftPairs.length === rightPairs.length
    ? leftPairs.every(([key, taskId], index) => key === rightPairs[index][0] && taskId === rightPairs[index][1])
    : leftPairs && rightPairs ? false : null
}
function mismatchedTaskGraphKeys(left, right) {
  const leftByKey = nodeTaskMap(left), rightByKey = nodeTaskMap(right)
  if (!leftByKey || !rightByKey) return []
  return [...new Set([...leftByKey.keys(), ...rightByKey.keys()])]
    .filter(key => leftByKey.get(key) !== rightByKey.get(key) && TASK_GRAPH_KEY_ALLOWLIST.has(key))
    .sort()
}
function persistedTaskGraphSnapshot(item) {
  const row = record(item), content = record(row?.content)
  const nodes = Array.isArray(content?.nodes) ? content.nodes : null
  const revision = Number(row?.revision)
  return {
    found: Boolean(row),
    valid: Boolean(nodes && nodeTaskMap(nodes)),
    nodeCount: nodes?.length ?? 0,
    revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : null,
    nodes,
  }
}
function assertPersistedGraphComparator() {
  const receipt = [{ key: "source", taskId: "task-a" }, { key: "summary", taskId: "task-b" }]
  const sameInDifferentOrder = [{ key: "summary", taskId: "task-b" }, { key: "source", taskId: "task-a" }]
  const mismatch = [{ key: "source", taskId: "task-c" }, { key: "summary", taskId: "task-d" }]
  const persistedItem = { revision: 1, content: { nodes: sameInDifferentOrder } }
  const malformedItem = { revision: 1, content: { nodes: [{ key: "source" }] } }
  if (!persistedTaskGraphSnapshot(persistedItem).valid
    || compareTaskGraphNodes(receipt, persistedTaskGraphSnapshot(persistedItem).nodes) !== true
    || compareTaskGraphNodes(receipt, mismatch) !== false
    || persistedTaskGraphSnapshot(null).found
    || compareTaskGraphNodes(receipt, persistedTaskGraphSnapshot(null).nodes) !== null
    || persistedTaskGraphSnapshot(malformedItem).valid
    || compareTaskGraphNodes(receipt, persistedTaskGraphSnapshot(malformedItem).nodes) !== null) {
    throw new Error("p3_persisted_graph_comparator_self_test_failed")
  }
}
function countOutside(source, target) {
  if (!Array.isArray(source) || !Array.isArray(target)) return null
  const targetIds = new Set(target)
  return source.filter(taskId => !targetIds.has(taskId)).length
}
async function initialWaitLineageFor(request, requestedTaskIds) {
  const receipt = record(latestToolResult(request, planCallId))
  const receiptNodes = Array.isArray(receipt?.nodes) ? receipt.nodes : null
  const graph = graphFromRequest(request)
  const graphNodes = Array.isArray(graph?.nodes) ? graph.nodes : null
  const receiptRevision = Number.isSafeInteger(receipt?.revision) ? receipt.revision : null
  const graphRevision = Number.isSafeInteger(graph?.revision) ? graph.revision : null
  let persistedItem = null, persistedItemReadSucceeded = false
  try {
    const { rows: [item] } = await pool.query(`SELECT item."revision", item."content"
      FROM "agent_items" AS item JOIN "agent_turns" AS turn
        ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId" AND turn."rootTaskId" = item."taskId"
      WHERE item."sessionId" = $1 AND item."turnId" = $2 AND item."type" = 'task_graph'
      ORDER BY item."revision" DESC, item."updatedAt" DESC LIMIT 1`, [ids.sessionId, ids.turnId])
    persistedItem = item ?? null
    persistedItemReadSucceeded = true
  } catch {}
  const persistedSnapshot = persistedTaskGraphSnapshot(persistedItem)
  const receiptIds = receiptNodes?.map(value => record(value)?.taskId) ?? null
  const graphIds = graphNodes?.map(value => record(value)?.taskId) ?? null
  const validIds = values => Array.isArray(values) && values.every(value => typeof value === "string")
  const sameIds = (left, right) => validIds(left) && validIds(right)
    && left.length === right.length && new Set(left).size === left.length
    && new Set(right).size === right.length && left.every(value => right.includes(value))
  const receiptByKey = nodeTaskMap(receiptNodes)
  const graphNodeKeysMissingReceipt = receiptNodes && graphNodes
    ? [...new Set(graphNodes.flatMap(value => {
      const graphNode = record(value)
      return graphNode && typeof graphNode.key === "string" && TASK_GRAPH_KEY_ALLOWLIST.has(graphNode.key)
        && receiptByKey?.get(graphNode.key) !== graphNode.taskId ? [graphNode.key] : []
    }))].sort()
    : []
  return {
    proposalReceiptFound: receipt?.status === "accepted" && receiptNodes !== null,
    proposalNodeCount: receiptNodes?.length ?? 0,
    graphNodeCount: graphNodes?.length ?? 0,
    receiptRevision,
    graphRevision,
    persistedItemReadSucceeded,
    persistedItemFound: persistedSnapshot.found,
    persistedItemValid: persistedSnapshot.valid,
    persistedItemNodeCount: persistedSnapshot.nodeCount,
    persistedItemRevision: persistedSnapshot.revision,
    proposalRevisionMatchesGraph: receiptRevision !== null && receiptRevision === graphRevision,
    requestMatchesReceipt: sameIds(requestedTaskIds, receiptIds),
    requestMatchesCurrentGraph: sameIds(requestedTaskIds, graphIds),
    proposalMatchesGraph: compareTaskGraphNodes(receiptNodes, graphNodes) === true,
    proposalMatchesPersistedItem: compareTaskGraphNodes(receiptNodes, persistedSnapshot.nodes),
    persistedItemMatchesGraph: compareTaskGraphNodes(persistedSnapshot.nodes, graphNodes),
    requestedIdsOutsideReceiptCount: countOutside(requestedTaskIds, receiptIds),
    requestedIdsOutsideGraphCount: countOutside(requestedTaskIds, graphIds),
    graphNodeKeysMissingReceipt,
    receiptPersistedMismatchKeys: mismatchedTaskGraphKeys(receiptNodes, persistedSnapshot.nodes),
    persistedGraphMismatchKeys: mismatchedTaskGraphKeys(persistedSnapshot.nodes, graphNodes),
  }
}
function assertLatestGraphObservationSelection() {
  const request = { messages: [
    { content: [{ type: "text", text: '[context]\n{"kind":"task_graph_current","revision":1,"nodes":[{"key":"source","taskId":"old"}]}' }] },
    { content: [{ type: "text", text: '[context]\n{"kind":"task_graph_current","revision":2,"nodes":[{"key":"source","taskId":"latest"}]}' }] },
  ] }
  if (graphFromRequest(request)?.revision !== 2) throw new Error("p3_latest_graph_observation_selection_failed")
}
function assertLatestToolResultSelection() {
  const request = { messages: [
    { content: [{ type: "tool_result", toolUseId: planCallId,
      content: JSON.stringify({ status: "accepted", nodes: [{ taskId: "stale" }] }) }] },
    { content: [{ type: "tool_result", toolUseId: "unrelated-call",
      content: JSON.stringify({ status: "accepted", nodes: [{ taskId: "unrelated" }] }) },
    { type: "tool_result", toolUseId: planCallId,
      content: JSON.stringify({ status: "accepted", nodes: [{ taskId: "latest" }] }) }] },
  ] }
  if (plannedTaskIds(request, planCallId, 1)[0] !== "latest") throw new Error("p3_latest_tool_result_selection_failed")
  const invalidNewest = { messages: [...request.messages, { content: [
    { type: "tool_result", toolUseId: planCallId, content: "{invalid json" },
  ] }] }
  if (latestToolResult(invalidNewest, planCallId) !== null) throw new Error("p3_latest_invalid_tool_result_fail_closed_failed")
}
function waitOutcomesFromRequest(request) {
  const outcomes = []
  for (const part of request.messages.flatMap(message => message.content)) {
    if (part.type !== "tool_result" || !part.toolUseId.startsWith("wait:") || typeof part.content !== "string") continue
    try { const outcome = record(JSON.parse(part.content)); if (outcome && Array.isArray(outcome.tasks)) outcomes.push(outcome) } catch { /* Ignore unrelated malformed results. */ }
  }
  return outcomes
}
function waitOutcomeFromRequest(request, predicate) {
  const outcome = waitOutcomesFromRequest(request).find(predicate ?? (() => true))
  if (!outcome) throw new Error("p3_durable_wait_result_missing"); return outcome
}
function structuredResult(role, summary) {
  const evidence = [{ id: "p3-process-restart-evidence", kind: "job", ref: "fixture-job-restart", source: "fixture" }]
  const data = role === "scout" ? { schemaVersion: ROLE_RESULT_SCHEMA, role, status: "completed", candidates: [{ jobId: "fixture-job-restart", source: "fixture", url: null, evidenceIds: [evidence[0].id] }], evidence, summary }
    : { schemaVersion: ROLE_RESULT_SCHEMA, role, status: "completed", findings: [{ jobId: "fixture-job-restart", score: 8, evidenceIds: [evidence[0].id] }], evidence, summary }
  return { status: "completed", stepCount: 2, toolCallCount: 1, finalItemId: "p3-process-restart-final", finalText: summary, structuredResult: data }
}
function modelProfile() {
  return { provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
    continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false, supportsReasoningSummary: false,
    supportsResponseContinuation: false, supportsProviderConversation: false, supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low" }
}
function flags() {
  return { cognitiveLoopEnabled: false, planningEnabled: true, planningExecutionEnabled: true, taskGraphPlanningEnabled: true,
    childExecutionEnabled: true, coordinationEnabled: true, consumeWaitOutcomes: true, canonicalAutomationEnabled: false }
}
function assertRestoredGraph(request) {
  const graph = graphFromRequest(request), nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : [], expected = ids.expectedSnapshot?.nodes
  if (graph?.kind !== "task_graph_current" || !Number.isSafeInteger(graph.revision) || graph.revision <= ids.expectedRevision
    || !Array.isArray(expected) || nodes.length !== expected.length) throw new Error("p3_task_graph_revision_or_snapshot_not_restored")
  const byKey = new Map(nodes.map(node => [node?.key, node]))
  for (const node of expected) {
    const current = byKey.get(node.key)
    if (!current || current.taskId !== node.taskId || current.goal !== node.goal || current.status !== "completed" || current.readiness !== "terminal") {
      throw new Error("p3_task_graph_node_not_restored:" + node.key)
    }
  }
  waitOutcomeFromRequest(request, outcome => outcome.status === "ready" && outcome.tasks.length === expected.length
    && outcome.tasks.every(task => record(task)?.status === "completed"))
  const sourceNode = byKey.get("source")
  if (!sourceNode || !isExpectedSourceProjection(sourceNode.resultProjection)) {
    throw new Error("p3_restored_graph_source_projection_missing")
  }
  say("P3_RESTORED_GRAPH_OK " + JSON.stringify({ revision: graph.revision, nodeCount: nodes.length }))
  say("P3_PARENT_RESUME_CONTEXT_OK")
  return graph
}
function assertFollowUpGraph(request) {
  const graph = graphFromRequest(request), nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : [], expected = ids.expectedSnapshot?.nodes
  if (graph?.kind !== "task_graph_current" || !Number.isSafeInteger(graph.revision) || !Array.isArray(expected) || nodes.length !== expected.length + 1) {
    throw new Error("p3_follow_up_graph_not_restored")
  }
  const byKey = new Map(nodes.map(node => [node?.key, node]))
  for (const node of expected) {
    const current = byKey.get(node.key)
    if (!current || current.taskId !== node.taskId || current.goal !== node.goal || current.status !== "completed" || current.readiness !== "terminal") {
      throw new Error("p3_original_graph_node_changed:" + node.key)
    }
  }
  const followUp = byKey.get(followUpKey)
  if (!followUp || followUp.goal !== followUpGoal || followUp.dependsOn?.length !== 1 || followUp.dependsOn[0] !== "summary"
    || followUp.status !== "completed" || followUp.readiness !== "terminal") throw new Error("p3_follow_up_graph_node_not_completed")
  waitOutcomeFromRequest(request, outcome => outcome.status === "ready" && outcome.tasks.length === 1
    && record(outcome.tasks[0])?.taskId === followUp.taskId && record(outcome.tasks[0])?.status === "completed" && JSON.stringify(outcome).includes(followUpGoal))
  return { revision: graph.revision, taskId: followUp.taskId }
}
async function waitForParentSuspended(ownerId, timeoutMs = 20_000) {
  const waitIdempotencyKey = waitArgs("p3-process-restart-wait", []).idempotencyKey
  const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) {
    const result = await pool.query(`SELECT turn."status" AS "turnStatus", wait."status" AS "waitStatus", wait."suspendedAt", item."revision", item."content"
      FROM "agent_turns" AS turn JOIN "agent_wait_conditions" AS wait ON wait."turnId" = turn."id"
      JOIN "agent_items" AS item ON item."turnId" = turn."id" AND item."type" = 'task_graph'
      WHERE turn."id" = $1 AND wait."parentTaskId" = turn."rootTaskId" AND wait."idempotencyKey" = $2
      ORDER BY wait."createdAt" DESC LIMIT 1`, [ids.turnId, waitIdempotencyKey])
    const row = result.rows[0], content = record(row?.content)
    if (row?.turnStatus === "waiting_for_dependency" && row?.waitStatus === "waiting" && row.suspendedAt && Number(row.revision) > 0 && Array.isArray(content?.nodes) && content.nodes.length === 2) { say("P3_PARENT_SUSPENDED " + JSON.stringify({ ownerId, revision: Number(row.revision), snapshot: content })); return }
    await sleep(20)
  }
  say("P3_PARENT_SUSPENSION_DIAGNOSTICS " + JSON.stringify(parentSuspensionProjection(await parentSuspensionDiagnostics())))
  throw new Error("p3_parent_wait_not_suspended")
}
async function parentSuspensionDiagnostics() {
  try {
    const [turnResult, stepResult, toolResult, waitResult, graphResult, childResult, taskRowResult] = await Promise.all([
      pool.query(`SELECT turn."status" AS "turnStatus", turn."rootTaskId" IS NOT NULL AS "hasRootTask",
          root."status" AS "rootTaskStatus", turn."startedAt" IS NOT NULL AS "hasStartedAt", turn."error" AS "turnError"
        FROM "agent_turns" AS turn LEFT JOIN "sub_agent_tasks" AS root
          ON root."id" = turn."rootTaskId" AND root."sessionId" = turn."sessionId" AND root."turnId" = turn."id"
        WHERE turn."id" = $1`, [ids.turnId]),
      pool.query(`SELECT step."ordinal", step."status", step."errorCode" FROM "agent_steps" AS step
        JOIN "agent_turns" AS turn ON turn."id" = step."turnId"
        WHERE turn."id" = $1 AND (step."taskId" IS NULL OR step."taskId" = turn."rootTaskId")
        ORDER BY step."ordinal"`, [ids.turnId]),
      pool.query(`WITH target_turn AS (
          SELECT "id", "sessionId", "rootTaskId" FROM "agent_turns" WHERE "id" = $1
        ), parent_items AS (
          SELECT item."type", item."status" AS "lifecycleStatus", item."content"->>'toolName' AS "toolName",
            item."content"->>'toolCallId' AS "toolCallId",
            item."content"->>'errorCode' AS "errorCode",
            item."content"->>'status' AS "toolOutcomeStatus",
            item."content"->'input'->'taskIds' AS "inputTaskIds",
            item."content"->'input'->>'idempotencyKey' AS "waitIdempotencyKey",
            item."createdAt" AS "createdAt",
            item."content"->'output'->>'status' AS "outputStatus",
            item."content"->'output'->>'status' AS "planReceiptStatus"
          FROM "agent_items" AS item JOIN target_turn AS turn ON turn."id" = item."turnId"
          WHERE item."sessionId" = turn."sessionId" AND (item."taskId" IS NULL OR item."taskId" = turn."rootTaskId")
            AND item."type" IN ('tool_call', 'tool_result')
        ), latest_wait_call AS (
          SELECT * FROM parent_items WHERE "type" = 'tool_call' AND "toolName" = 'agent.wait'
          ORDER BY "createdAt" DESC LIMIT 1
        )
        SELECT EXISTS (SELECT 1 FROM parent_items WHERE "type" = 'tool_call' AND "toolName" = 'agent.plan') AS "hasPlanToolCall",
          EXISTS (SELECT 1 FROM parent_items AS call JOIN parent_items AS result ON result."toolCallId" = call."toolCallId"
            WHERE call."type" = 'tool_call' AND call."toolName" = 'agent.plan' AND result."type" = 'tool_result') AS "hasPlanToolResult",
          EXISTS (SELECT 1 FROM parent_items AS call JOIN parent_items AS result ON result."toolCallId" = call."toolCallId"
            WHERE call."type" = 'tool_call' AND call."toolName" = 'agent.plan' AND result."type" = 'tool_result'
              AND (call."toolOutcomeStatus" = 'failed' OR call."errorCode" IS NOT NULL OR result."errorCode" IS NOT NULL)) AS "hasFailedPlanToolResult",
          ARRAY(SELECT result."planReceiptStatus" FROM parent_items AS call JOIN parent_items AS result ON result."toolCallId" = call."toolCallId"
            WHERE call."type" = 'tool_call' AND call."toolName" = 'agent.plan' AND result."type" = 'tool_result'
              AND result."planReceiptStatus" IN ('accepted', 'duplicate', 'rejected')
            ORDER BY result."planReceiptStatus") AS "planReceiptStatuses",
          EXISTS (SELECT 1 FROM latest_wait_call) AS "hasWaitToolCall",
          EXISTS (SELECT 1 FROM latest_wait_call AS call JOIN parent_items AS result ON result."toolCallId" = call."toolCallId"
            WHERE result."type" = 'tool_result') AS "hasWaitToolResult",
          (SELECT call."toolOutcomeStatus" FROM latest_wait_call AS call) AS "waitToolCallStatus",
          (SELECT call."lifecycleStatus" FROM latest_wait_call AS call) AS "waitToolCallLifecycleStatus",
          (SELECT call."waitIdempotencyKey" FROM latest_wait_call AS call) AS "waitCallIdempotencyKey",
          (SELECT call."inputTaskIds" FROM latest_wait_call AS call) AS "waitCallTaskIds",
          (SELECT result."lifecycleStatus" FROM latest_wait_call AS call JOIN parent_items AS result ON result."toolCallId" = call."toolCallId"
            WHERE result."type" = 'tool_result' ORDER BY result."createdAt" DESC LIMIT 1) AS "waitToolResultLifecycleStatus",
          (SELECT result."outputStatus" FROM latest_wait_call AS call JOIN parent_items AS result ON result."toolCallId" = call."toolCallId"
            WHERE result."type" = 'tool_result' ORDER BY result."createdAt" DESC LIMIT 1) AS "waitToolOutputStatus",
          (SELECT result."errorCode" FROM latest_wait_call AS call JOIN parent_items AS result ON result."toolCallId" = call."toolCallId"
            WHERE result."type" = 'tool_result' ORDER BY result."createdAt" DESC LIMIT 1) AS "waitToolErrorCode",
          (SELECT call."errorCode" FROM latest_wait_call AS call) AS "waitToolCallErrorCode"`, [ids.turnId]),
      pool.query(`SELECT wait."idempotencyKey" AS "waitIdempotencyKey", wait."status" AS "waitStatus", wait."targetTaskIds", wait."parentTaskId" = turn."rootTaskId" AS "parentMatchesRoot",
          wait."suspendedAt" IS NOT NULL AS "hasSuspendedAt"
        FROM "agent_wait_conditions" AS wait JOIN "agent_turns" AS turn ON turn."id" = wait."turnId"
        WHERE turn."id" = $1`, [ids.turnId]),
      pool.query(`SELECT item."revision", item."content"->'nodes' AS "nodes", jsonb_typeof(item."content"->'nodes') = 'array' AS "hasNodeArray",
          CASE WHEN jsonb_typeof(item."content"->'nodes') = 'array' THEN jsonb_array_length(item."content"->'nodes') ELSE NULL END AS "nodeCount"
        FROM "agent_items" AS item JOIN "agent_turns" AS turn ON turn."id" = item."turnId"
        WHERE turn."id" = $1 AND item."sessionId" = turn."sessionId" AND item."taskId" = turn."rootTaskId"
          AND item."type" = 'task_graph' ORDER BY item."revision" DESC, item."updatedAt" DESC LIMIT 1`, [ids.turnId]),
      pool.query(`SELECT child."status", COUNT(*)::int AS "count"
        FROM "sub_agent_tasks" AS child JOIN "agent_turns" AS turn
          ON turn."id" = child."turnId" AND turn."sessionId" = child."sessionId" AND turn."rootTaskId" = child."parentTaskId"
        WHERE turn."id" = $1 GROUP BY child."status"`, [ids.turnId]),
      pool.query(`SELECT child."id" FROM "sub_agent_tasks" AS child JOIN "agent_turns" AS turn
        ON turn."id" = child."turnId" AND turn."sessionId" = child."sessionId" AND turn."rootTaskId" = child."parentTaskId"
        WHERE turn."id" = $1`, [ids.turnId]),
    ])
    const turn = turnResult.rows[0]
    const graph = graphResult.rows[0]
    const tool = toolResult.rows[0] ?? {}
    const graphNodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
    const graphTaskIds = graphNodes.map(node => node?.taskId).filter(taskId => typeof taskId === "string")
    const taskIds = taskRowResult.rows.map(row => row.id).filter(taskId => typeof taskId === "string")
    const requestedTaskIds = stringArray(tool.waitCallTaskIds)
    const matchingWait = waitResult.rows.find(row => row.parentMatchesRoot
      && typeof tool.waitCallIdempotencyKey === "string" && row.waitIdempotencyKey === tool.waitCallIdempotencyKey)
    const persistedWaitTaskIds = stringArray(matchingWait?.targetTaskIds)
    const latestStep = stepResult.rows[stepResult.rows.length - 1]
    const taskIdSet = new Set(taskIds)
    const graphTaskIdSet = new Set(graphTaskIds)
    const missingGraphTaskKeys = graphNodes.flatMap(node => {
      const key = typeof node?.key === "string" ? node.key : null
      return key && TASK_GRAPH_KEY_ALLOWLIST.has(key)
        && (typeof node.taskId !== "string" || !taskIdSet.has(node.taskId)) ? [key] : []
    })
    const missingRequestedGraphTaskKeys = requestedTaskIds ? graphNodes.flatMap(node => {
      const key = typeof node?.key === "string" ? node.key : null
      return key && TASK_GRAPH_KEY_ALLOWLIST.has(key)
        && (typeof node.taskId !== "string" || !requestedTaskIds.includes(node.taskId)) ? [key] : []
    }) : []
    const snapshot = {
      turnStatus: turn?.turnStatus ?? null,
      hasTurn: Boolean(turn),
      hasRootTask: Boolean(turn?.hasRootTask),
      rootTaskStatus: fixedEnum(turn?.rootTaskStatus, ROOT_TASK_STATUS_ALLOWLIST),
      hasStartedAt: Boolean(turn?.hasStartedAt),
      hasError: typeof turn?.turnError === "string" && turn.turnError.length > 0,
      turnErrorCategory: turnErrorCategory(turn?.turnError),
      modelStepCount: stepResult.rows.length,
      latestModelStep: stepResult.rows.length ? {
        ordinal: Number(latestStep.ordinal),
        status: latestStep.status,
        hasErrorCode: typeof latestStep.errorCode === "string" && latestStep.errorCode.length > 0,
        errorClass: modelStepErrorClass(latestStep.errorCode),
      } : null,
      hasPlanToolCall: Boolean(tool.hasPlanToolCall),
      hasPlanToolResult: Boolean(tool.hasPlanToolResult),
      hasFailedPlanToolResult: Boolean(tool.hasFailedPlanToolResult),
      planReceiptStatuses: Array.isArray(tool.planReceiptStatuses) ? tool.planReceiptStatuses : [],
      hasWaitToolCall: Boolean(tool.hasWaitToolCall),
      waitToolCallStatus: fixedEnum(tool.waitToolCallStatus, TOOL_CALL_STATUS_ALLOWLIST),
      waitToolCallLifecycleStatus: fixedEnum(tool.waitToolCallLifecycleStatus, ITEM_LIFECYCLE_STATUS_ALLOWLIST),
      waitToolResultLifecycleStatus: fixedEnum(tool.waitToolResultLifecycleStatus, ITEM_LIFECYCLE_STATUS_ALLOWLIST),
      waitCallIdempotencyKeyPresent: typeof tool.waitCallIdempotencyKey === "string",
      waitToolOutputStatus: fixedEnum(tool.waitToolOutputStatus, WAIT_OUTPUT_STATUS_ALLOWLIST),
      waitFailureCategory: waitFailureCategory(tool),
      initialWaitLineage,
      waits: waitResult.rows.map(row => ({
        status: row.waitStatus,
        parentMatchesRoot: Boolean(row.parentMatchesRoot),
        hasSuspendedAt: Boolean(row.hasSuspendedAt),
        matchesLatestWaitToolCall: typeof tool.waitCallIdempotencyKey === "string"
          && row.waitIdempotencyKey === tool.waitCallIdempotencyKey,
      })),
      graph: graph ? { present: true, revision: Number(graph.revision), hasNodeArray: Boolean(graph.hasNodeArray), nodeCount: graph.nodeCount === null ? null : Number(graph.nodeCount) }
        : { present: false, revision: null, hasNodeArray: false, nodeCount: null },
      graphTaskIdCount: graphNodes.filter(node => typeof node?.taskId === "string").length,
      taskRowCount: taskIds.length,
      requestedTaskCount: requestedTaskIds?.length ?? null,
      requestedGraphMatchCount: requestedTaskIds?.filter(taskId => graphTaskIdSet.has(taskId)).length ?? null,
      requestedTaskRowMatchCount: requestedTaskIds?.filter(taskId => taskIdSet.has(taskId)).length ?? null,
      persistedWaitTaskCount: persistedWaitTaskIds?.length ?? null,
      persistedWaitGraphMatchCount: persistedWaitTaskIds?.filter(taskId => graphTaskIdSet.has(taskId)).length ?? null,
      persistedWaitTaskRowMatchCount: persistedWaitTaskIds?.filter(taskId => taskIdSet.has(taskId)).length ?? null,
      graphTaskRowMatchCount: graphTaskIds.filter(taskId => taskIdSet.has(taskId)).length,
      missingRequestedGraphTaskKeys: [...new Set(missingRequestedGraphTaskKeys)].sort(),
      missingGraphTaskKeys: [...new Set(missingGraphTaskKeys)].sort(),
      childStatusCounts: taskStatusCounts(childResult.rows),
    }
    snapshot.likelyCause = !snapshot.hasTurn ? "turn_missing"
      : snapshot.modelStepCount === 0 ? "model_never_ran"
      : !snapshot.hasPlanToolCall ? "plan_not_called"
      : snapshot.hasFailedPlanToolResult || !snapshot.hasPlanToolResult
        || !snapshot.planReceiptStatuses.some(status => status === "accepted" || status === "duplicate")
        || !snapshot.graph.present ? "plan_failed_or_incomplete"
       : !snapshot.graph.hasNodeArray || snapshot.graph.nodeCount !== 2 ? "graph_shape_mismatch"
        : !snapshot.hasWaitToolCall ? "wait_call_missing"
        : !snapshot.hasWaitToolResult && snapshot.waitFailureCategory !== "none" && snapshot.waitFailureCategory !== "tool_result_missing"
          ? "wait_tool_failed_before_wait_persistence"
        : !snapshot.hasWaitToolResult ? "wait_result_missing_or_unknown"
       : snapshot.requestedTaskCount === null ? "wait_target_ids_unreadable"
      : snapshot.requestedGraphMatchCount !== snapshot.requestedTaskCount ? "requested_ids_not_in_graph"
      : snapshot.requestedTaskRowMatchCount !== snapshot.requestedTaskCount ? "requested_graph_tasks_missing_child_rows"
       : !snapshot.waits.some(wait => wait.parentMatchesRoot && wait.matchesLatestWaitToolCall)
         && snapshot.waitFailureCategory !== "none" ? "wait_tool_failed_before_wait_persistence"
       : !snapshot.waits.some(wait => wait.parentMatchesRoot && wait.matchesLatestWaitToolCall) ? "wait_row_missing_or_parent_mismatch"
      : snapshot.turnStatus === "failed" ? "turn_failed"
       : !snapshot.waits.some(wait => wait.parentMatchesRoot && wait.matchesLatestWaitToolCall
         && wait.status === "waiting" && wait.hasSuspendedAt) ? "wait_row_not_suspended"
      : "suspension_predicate_not_met"
    return snapshot
  } catch {
    return { diagnosticsAvailable: false }
  }
}
async function projectPersistedPlanLedger() {
  const { rows: [item] } = await pool.query(`SELECT item."taskId", item."revision", item."content" FROM "agent_items" AS item WHERE item."sessionId" = $1 AND item."turnId" = $2 AND item."type" = 'task_graph'`, [ids.sessionId, ids.turnId])
  if (!item) throw new Error("p3_persisted_plan_ledger_graph_missing")
  const { rows: tasks } = await pool.query(`SELECT "id", "sessionId", "status", "role", "goal", "result", "updatedAt" FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "turnId" = $2 AND ("id" = $3 OR "parentTaskId" = $3)`, [ids.sessionId, ids.turnId, item.taskId])
  const ledger = projectPlanLedger({ sessionId: ids.sessionId, revision: Number(item.revision), rootTaskId: item.taskId, graph: item.content, tasks })
  if (!ledger || !parsePlanLedger(JSON.stringify(ledger))) throw new Error("p3_persisted_plan_ledger_projection_invalid")
  return ledger
}
function toolCall(callId, name, args) { return { type: "tool_call_completed", callId, name, arguments: args } }
function node(key, templateId, goal, successCriteria, dependsOn) { return { key, templateId, goal, successCriteria, dependsOn } }
function waitArgs(key, taskIds) { return { idempotencyKey: key + ":" + ids.turnId, taskIds, mode: "all", timeoutMs: 30_000 } }
async function startRuntime(workerOwnerId, resume) {
  return createCanonicalTurnRuntime(pool, {
    workerId: workerOwnerId, productionFlags: flags(), taskGraphCommandPort: createPgTaskGraphCommandPort(pool),
    taskGraphTemplates: TASK_GRAPH_TEMPLATES, authorizeUsage: async () => ({ settle: async () => undefined }),
    modelRuntimeFactory() {
      let modelRounds = 0
      return { adapter: {
        id: resume ? "p3-process-restart-resume-model" : "p3-process-restart-plan-model", profile: modelProfile(),
        async *stream(request) {
          modelRounds++
          if (!resume && modelRounds === 1) {
            yield toolCall(planCallId, "agent.plan", { expectedRevision: 0, nodes: [
              node("source", "scout", sourceGoal, ["Persist source evidence"], []),
              node("summary", "analyst", dependentGoal, ["Use restored dependency evidence"], ["source"]),
            ] })
            yield { type: "completed", finishReason: "tool_calls" }; return
          }
          if (!resume && modelRounds === 2) {
            const taskIds = plannedTaskIds(request)
            initialWaitLineage = await initialWaitLineageFor(request, taskIds)
            if (!initialWaitLineage.proposalMatchesGraph || !initialWaitLineage.proposalRevisionMatchesGraph) {
              throw new Error("p3_initial_wait_plan_graph_mismatch")
            }
            yield toolCall(waitCallId, "agent.wait", waitArgs("p3-process-restart-wait", taskIds))
            yield { type: "completed", finishReason: "tool_calls" }; return
          }
          if (resume) {
            try {
              const graph = graphFromRequest(request), nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
              const followUp = nodes.find(item => item?.key === followUpKey)
              if (!followUp) {
                const restored = assertRestoredGraph(request)
                if (!request.tools.some(tool => record(tool)?.name === "agent.plan")) throw new Error("p3_follow_up_plan_tool_missing")
                yield toolCall(followUpPlanCallId, "agent.plan", { expectedRevision: restored.revision,
                  nodes: [node(followUpKey, "analyst", followUpGoal, ["Verify the restored summary evidence"], ["summary"])] })
                yield { type: "completed", finishReason: "tool_calls" }; return
              }
              const waitReady = waitOutcomesFromRequest(request).some(outcome => outcome.status === "ready"
                && outcome.tasks.some(task => record(task)?.taskId === followUp.taskId && record(task)?.status === "completed"))
              if (!waitReady) {
                const taskIds = plannedTaskIds(request, followUpPlanCallId, 1)
                if (followUp.taskId !== taskIds[0]) throw new Error("p3_follow_up_plan_task_mismatch")
                if (!request.tools.some(tool => record(tool)?.name === "agent.wait")) throw new Error("p3_follow_up_wait_tool_missing")
                yield toolCall(followUpWaitCallId, "agent.wait", waitArgs("p3-process-restart-follow-up-wait", taskIds))
                yield { type: "completed", finishReason: "tool_calls" }; return
              }
              if (followUp.status !== "completed") throw new Error("p3_follow_up_waited_task_not_completed")
              const state = assertFollowUpGraph(request)
              const ledger = await projectPersistedPlanLedger()
              say("P3_PLAN_LEDGER_PROJECTION " + JSON.stringify(ledger))
              say("P3_FOLLOW_UP_GRAPH_READY " + JSON.stringify(state)); await waitForCommand("finalize-parent")
              say("P3_FOLLOW_UP_GRAPH_OK " + JSON.stringify(state))
              yield { type: "text_delta", text: finalMarker }; yield { type: "completed", finishReason: "stop" }; return
            } catch (error) {
              say("P3_PARENT_MODEL_FAILURE " + boundedFailureText(error))
              throw error
            }
          }
          throw new Error("p3_unexpected_parent_model_round")
        },
      }, registry: {}, candidates: [] }
    },
  })
}
async function waitForStop() {
  await waitForCommand("shutdown"); process.stdin.off("data", onStdinData); process.stdin.pause(); process.stdin.destroy()
}
async function runFirstWorker() {
  say("P3_FIRST_WORKER_START_RUNTIME_BEGIN")
  const ownerId = "p3-process-restart-worker-" + process.pid, runtime = await startRuntime(ownerId, false)
  say("P3_FIRST_WORKER_START_RUNTIME_DONE")
  bootstrap = await createProductionWorkerBootstrap({ pool, runtime, ownerId, turnRecoveryIntervalMs: 10,
    waitResolver: { intervalMs: 10, ownerId: "p3-process-restart-wait-resolver-" + process.pid },
    subagents: { intervalMs: 10, async execute() { throw new Error("p3_first_worker_must_not_execute_children") } } })
  say("P3_FIRST_WORKER_BOOTSTRAP_DONE")
  const subagentWorker = bootstrap.subagents?.queue?.worker
  if (typeof subagentWorker?.pause !== "function") throw new Error("p3_first_worker_subagent_pause_unavailable")
  await subagentWorker.pause()
  say("P3_FIRST_WORKER_PAUSE_DONE")
  const activated = await pool.query(`UPDATE "agent_turns" SET "status" = 'queued', "completedAt" = NULL,
      "leaseOwnerId" = NULL, "leaseExpiresAt" = NULL, "leaseStartedAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "status" = 'waiting_for_user'`, [ids.turnId, ids.sessionId, ids.userId])
  if (activated.rowCount !== 1) throw new Error("p3_first_worker_fixture_turn_not_parked")
  say("P3_FIRST_WORKER_TURN_ACTIVATED")
  await enqueueTurn(pool, bootstrap.turns.queue, { turnId: ids.turnId, sessionId: ids.sessionId, ownerId })
  say("P3_FIRST_WORKER_ENQUEUE_DONE")
  await waitForParentSuspended(ownerId); await waitForStop()
}
async function runSecondWorker() {
  const ownerId = "p3-process-restart-worker-" + process.pid, runtime = await startRuntime(ownerId, true)
  bootstrap = await createProductionWorkerBootstrap({ pool, runtime, ownerId, turnRecoveryIntervalMs: 10,
    waitResolver: { intervalMs: 10, ownerId: "p3-process-restart-wait-resolver-" + process.pid },
    subagents: { intervalMs: 10, async execute({ lease }) {
      const dependencyResults = record(record(lease.context)?.taskGraphDependencyResults)
      const dependencyItems = Array.isArray(dependencyResults?.items) ? dependencyResults.items.map(record) : []
      say("P3_CHILD_LEASE " + JSON.stringify({
        taskId: lease.id,
        goal: lease.goal,
        role: lease.role,
        dependencies: dependencyItems.map(item => ({
          dependencyKey: item?.dependencyKey,
          taskStatus: item?.taskStatus,
          hasSourceResult: (JSON.stringify(item?.result) ?? "").includes(resultMarker),
        })),
      }))
      if (lease.goal === sourceGoal && lease.role === "scout") return { status: "completed", result: structuredResult("scout", resultMarker) }
      if (lease.goal === dependentGoal && lease.role === "analyst") {
        const items = Array.isArray(record(record(lease.context)?.taskGraphDependencyResults)?.items)
          ? record(record(lease.context)?.taskGraphDependencyResults).items.map(record) : []
        if (items[0]?.dependencyKey !== "source" || items[0]?.taskStatus !== "completed" || !isExpectedSourceProjection(items[0]?.result)) {
          throw new Error("p3_dependency_context_not_restored")
        }
        say("P3_DEPENDENCY_CONTEXT_OK"); return { status: "completed", result: structuredResult("analyst", dependentGoal) }
      }
      if (lease.goal === followUpGoal && lease.role === "analyst") {
        const items = Array.isArray(record(record(lease.context)?.taskGraphDependencyResults)?.items)
          ? record(record(lease.context)?.taskGraphDependencyResults).items.map(record) : []
        const projection = record(items[0]?.result), findings = Array.isArray(projection?.findings) ? projection.findings.map(record) : []
        if (items[0]?.dependencyKey !== "summary" || items[0]?.taskStatus !== "completed"
          || projection?.role !== "analyst" || projection?.availability !== "available"
          || !findings.some(finding => finding?.jobId === "fixture-job-restart" && finding.score === 8)) {
          throw new Error("p3_follow_up_dependency_context_missing")
        }
        say("P3_FOLLOW_UP_DEPENDENCY_CONTEXT_OK"); await waitForCommand("complete-follow-up-child")
        return { status: "completed", result: structuredResult("analyst", followUpGoal) }
      }
      throw new Error("p3_unexpected_child:" + lease.goal)
    } } })
  say("P3_SECOND_WORKER_READY " + ownerId); await waitForStop()
}
try {
  assertLatestGraphObservationSelection()
  assertLatestToolResultSelection()
  assertPersistedGraphComparator()
  if (mode === "self-test") say("P3_FIXTURE_SELF_TEST_OK")
  else if (mode === "park-parent") await runFirstWorker()
  else if (mode === "resume-parent") await runSecondWorker()
  else throw new Error("p3_unknown_process_restart_mode")
} catch (error) {
  process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + "\n"); process.exitCode = 1
} finally {
  try { if (bootstrap) await bootstrap.close() } catch (error) { process.stderr.write("p3_bootstrap_close_failed:" + String(error) + "\n"); process.exitCode = 1 }
  try { await pool.end() } catch (error) { process.stderr.write("p3_pool_end_failed:" + String(error) + "\n"); process.exitCode = 1 }
  try { const { closeSharedRedisConnections } = await import("../../redis.ts"); await closeSharedRedisConnections() }
  catch (error) { process.stderr.write("p3_redis_close_failed:" + String(error) + "\n"); process.exitCode = 1 }
}
