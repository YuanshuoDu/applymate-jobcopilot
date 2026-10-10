import type pg from "pg"
import { Buffer } from "node:buffer"
import { redactSensitiveText } from "@jobcopilot/shared"
import { hashArtifactContent } from "./artifact-adapters.js"
import { canonicalNativeVerificationJson, digestNativeVerificationValue, type NativeVerificationEvidence, type NativeVerificationPacket, type NativeVerificationPacketTarget } from "./native-verification-contract.js"
import { nativeVerificationFrontier, type NativeVerificationOwnedState, type NativeVerificationTarget } from "./native-verification-pg-bindings.js"
import { parseTaskGraphVerificationCriterionIds, parseTaskGraphVerificationReport } from "./task-graph-command-port.js"

type Queryable = Pick<pg.PoolClient, "query">; type Row = Record<string, unknown>
export type NativeVerificationPacketContent = Readonly<{
  goal: string
  criteria: NativeVerificationPacket["criteria"]
  target: NativeVerificationPacketTarget
  evidence: readonly NativeVerificationEvidence[]
}>
export type NativeVerificationHistoryEntry = Readonly<{
  controlTaskId: string
  targetTaskId: string
  targetKind: "child" | "root_goal"
  candidateDigest?: string
  childBindingSetDigest?: string
  disposition: string
  status: string
  attempt: number
  reportDigest: string | null
  criterionSummary: string
}>
export type NativeVerificationHistoryTarget = Readonly<{
  controlTaskId: string
  targetKind: "child" | "root_goal"
  candidateDigest?: string
  childBindingSetDigest?: string
}>

const MAX_TOOL_FACTS = 20, MAX_ARTIFACT_FACTS = 8, MAX_EVIDENCE = 32, MAX_SUMMARY_BYTES = 8 * 1024, SECRET_KEY = /api.?key|secret|password|(?:access|refresh).?token|authorization/i
function record(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : null
}
function publicTaskGraphResult(value: unknown): unknown {
  if (typeof value === "string") { try { const parsed = JSON.parse(value) as unknown, safe = publicTaskGraphResult(parsed); return safe === parsed ? value : JSON.stringify(safe) } catch { const trimmed = value.trim(); return trimmed.startsWith("{") || trimmed.startsWith("[") || value.includes("taskGraphVerificationReport") || value.includes("dependencyBindings") ? null : value } }
  const result = record(value)
  if (!result || !Object.hasOwn(result, "taskGraphVerificationReport")) return value
  const report = record(result.taskGraphVerificationReport), ids = report && Array.isArray(report.criteria) ? parseTaskGraphVerificationCriterionIds(report.criteria.map(item => record(item)?.criterionId)) : undefined
  const parsed = ids && parseTaskGraphVerificationReport(report, ids)
  const { taskGraphVerificationReport: _private, ...safe } = result; return parsed ? { ...safe, taskGraphVerificationReport: parsed } : safe
}
function evidenceRef(kind: string, ownedId: string): string { return `${kind}:${digestNativeVerificationValue(ownedId).slice(0, 32)}` }
function criterionRows(values: readonly string[]): NativeVerificationPacket["criteria"] {
  return values.map((requirement, index) => ({ criterionId: `criterion-${index + 1}`, requirement }))
}

export function nativeVerificationRootPacketHistory(
  history: readonly NativeVerificationHistoryEntry[], targets: readonly NativeVerificationHistoryTarget[], candidateDigest: string, childBindingSetDigest: string,
): readonly NativeVerificationHistoryEntry[] {
  const identityByTask = new Map(targets.map(item => [item.controlTaskId, item.targetKind === "root_goal"
    ? { candidateDigest: item.candidateDigest, childBindingSetDigest: item.childBindingSetDigest } : null] as const))
  return history.filter(item => item.targetKind === "child" || item.targetKind === "root_goal"
    && (identityByTask.get(item.controlTaskId)?.candidateDigest !== candidateDigest
      || identityByTask.get(item.controlTaskId)?.childBindingSetDigest !== childBindingSetDigest))
}

/** Builds a packet from the exact current persisted result and server-owned read receipts. */
export async function buildNativeChildPacketContent(
  client: Queryable, state: NativeVerificationOwnedState, target: NativeVerificationTarget,
): Promise<NativeVerificationPacketContent | null> {
  if (containsSecretField(target.task.result)) return null
  const evidence = await readTargetEvidence(client, state, target)
  if (!evidence) return null
  const referenceId = evidenceRef("target", `${target.task.id}:${target.attempt}`)
  return {
    goal: target.goal,
    criteria: criterionRows(target.criteria),
    target: {
      kind: "child", taskId: target.task.id, attempt: target.attempt, resultDigest: target.resultDigest,
      referenceId, resultText: target.resultText,
    },
    evidence,
  }
}

/** Root reviews retain every graph goal/result/failure plus prior independent report summaries. */
export function buildNativeRootPacketContent(input: Readonly<{
  state: NativeVerificationOwnedState
  candidateText: string
  childBindingSetDigest: string
  history: readonly NativeVerificationHistoryEntry[]
}>): NativeVerificationPacketContent | null {
  const { state, candidateText, childBindingSetDigest } = input
  if (!state.goal || state.turnGoalConflict || !state.criteriaValid || !state.criteria.length) return null
  const candidateDigest = digestNativeVerificationValue(candidateText)
  const evidence: NativeVerificationEvidence[] = []
  const nodes = state.snapshot?.nodes ?? []
  const graphLeaves = new Set(nodes.filter(node => !nodes.some(candidate => candidate.dependsOn.includes(node.key))).map(node => node.key))
  const activeNative = new Set(nativeVerificationFrontier(state).map(node => node.key))
  for (const node of nodes) {
    const task = state.tasks.get(node.taskId)
    if (!task) return null
    if (task.result !== null && containsSecretField(task.result)) return null
    let resultDigest: string | null = null
    const safeFailure = task.failureReason === null ? null : redactSensitiveText(task.failureReason)
    let persistedResult: unknown = null
    try { if (task.result !== null) { persistedResult = publicTaskGraphResult(JSON.parse(canonicalNativeVerificationJson(task.result)) as unknown); resultDigest = digestNativeVerificationValue(persistedResult) } } catch { return null }
    const summary = JSON.stringify({
      kind: "graph_node_history", nodeId: node.key, taskId: node.taskId, goal: node.goal,
      criteria: node.successCriteria, dependsOn: node.dependsOn, status: task.status,
      attempt: task.attemptCount, failureReason: safeFailure, resultDigest,
      persistedResult,
      nativeSource: node.nativeDelegation?.source ?? null,
      activeNative: activeNative.has(node.key),
    })
    if (Buffer.byteLength(summary, "utf8") > MAX_SUMMARY_BYTES) return null
    evidence.push({ referenceId: evidenceRef("graph", node.taskId), kind: "graph_history", summary })
    if (node.nativeDelegation || graphLeaves.has(node.key) || activeNative.has(node.key)) {
      if (activeNative.has(node.key) && (task.status !== "completed" || task.failureReason !== null || task.result === null)) return null
    }
  }
  for (const task of state.sourceTasks.values()) {
    if (nodes.some(node => node.taskId === task.id)) continue
    if (task.result !== null && containsSecretField(task.result)) return null
    let resultDigest: string | null = null
    let result: unknown = null
    try { if (task.result !== null) { result = publicTaskGraphResult(JSON.parse(canonicalNativeVerificationJson(task.result)) as unknown); resultDigest = digestNativeVerificationValue(result) } } catch { return null }
    const criteria = sourceCriteria(task.successCriteria)
    if (!criteria || !task.goal.trim() || task.goal.trim() !== task.goal) return null
    const summary = JSON.stringify({ kind: "native_legacy_source_history", taskId: task.id, goal: task.goal,
      criteria, status: task.status, attempt: task.attemptCount,
      failureReason: task.failureReason === null ? null : redactSensitiveText(task.failureReason), resultDigest, result })
    if (Buffer.byteLength(summary, "utf8") > MAX_SUMMARY_BYTES) return null
    evidence.push({ referenceId: evidenceRef("source", task.id), kind: "source_history", summary })
  }
  for (const item of input.history) {
    const summary = JSON.stringify({
      kind: "native_review_history", targetTaskId: item.targetTaskId, targetKind: item.targetKind,
      status: item.status, attempt: item.attempt, disposition: item.disposition,
      reportDigest: item.reportDigest, criteria: item.criterionSummary,
    })
    if (Buffer.byteLength(summary, "utf8") > MAX_SUMMARY_BYTES) return null
    evidence.push({ referenceId: evidenceRef("review", item.controlTaskId), kind: "review_history", summary })
  }
  if (evidence.length > MAX_EVIDENCE) return null
  const bindingSummary = JSON.stringify({ kind: "current_child_binding_set", digest: childBindingSetDigest })
  evidence.push({ referenceId: evidenceRef("bindings", childBindingSetDigest), kind: "child_binding_set", summary: bindingSummary })
  if (evidence.length > MAX_EVIDENCE) return null
  return {
    goal: state.goal,
    criteria: criterionRows(state.criteria),
      target: { kind: "root_goal", candidateDigest, referenceId: evidenceRef("candidate", candidateDigest), candidateText },
    evidence,
  }
}

function sourceCriteria(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > 32 || Reflect.ownKeys(value).length !== value.length + 1
    || value.some(item => typeof item !== "string" || !item.trim() || item.trim() !== item || Buffer.byteLength(item, "utf8") > 2_000)) return null
  return value as string[]
}

async function readTargetEvidence(
  client: Queryable, state: NativeVerificationOwnedState, target: NativeVerificationTarget,
): Promise<readonly NativeVerificationEvidence[] | null> {
  const task = target.task, scope = state.scope
  const result = await client.query(`SELECT item."id", item."revision", item."content", step."attempt", call_item."id" AS "callItemId",
      call_item."revision" AS "callRevision",
      call_item."content" AS "callContent", COUNT(call_item."id") OVER (PARTITION BY item."id") AS "callMatches", COUNT(*) OVER (PARTITION BY item."stepId", item."content"->>'toolCallId') AS "resultMatches"
    FROM "agent_items" AS item JOIN "agent_steps" AS step ON step."id" = item."stepId"
      AND step."sessionId" = item."sessionId" AND step."turnId" = item."turnId" AND step."taskId" = item."taskId"
    LEFT JOIN "agent_items" AS call_item ON call_item."sessionId" = item."sessionId" AND call_item."turnId" = item."turnId"
      AND call_item."taskId" = item."taskId" AND call_item."stepId" = item."stepId" AND call_item."type" = 'tool_call'
      AND call_item."content"->>'toolCallId' = item."content"->>'toolCallId'
    JOIN "sub_agent_tasks" AS owner ON owner."id" = item."taskId" AND owner."sessionId" = item."sessionId" AND owner."turnId" = item."turnId"
    JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
    JOIN "agent_sessions" AS session ON session."id" = item."sessionId"
    WHERE item."taskId" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND owner."rootTaskId" = $4
      AND owner."parentTaskId" = $4 AND owner."status" = 'completed' AND step."attempt" = $5 AND item."type" = 'tool_result'
      AND turn."userId" = $6 AND session."userId" = $6
    ORDER BY step."ordinal", item."createdAt", item."id" LIMIT $7`,
  [task.id, scope.sessionId, scope.turnId, scope.rootTaskId, target.attempt, scope.userId, MAX_TOOL_FACTS + 1])
  if (result.rows.length > MAX_TOOL_FACTS) return null
  const evidence: NativeVerificationEvidence[] = []
  for (const raw of result.rows) {
    const row = raw as Row, content = record(row.content), call = record(row.callContent)
    if (typeof row.id !== "string" || !Number.isSafeInteger(row.revision) || !content || !call
      || Number(row.callMatches) !== 1 || Number(row.resultMatches) !== 1 || typeof row.callItemId !== "string" || !Number.isSafeInteger(row.callRevision)
      || typeof content.toolCallId !== "string" || call.toolCallId !== content.toolCallId
      || typeof call.toolName !== "string" || typeof call.status !== "string"
      || !Object.hasOwn(content, "output") || containsSecretField(content.output)) return null
    let outputDigest: string, callDigest: string
    let output: unknown
    try {
      outputDigest = digestNativeVerificationValue(content.output)
      callDigest = digestNativeVerificationValue(call)
      output = JSON.parse(canonicalNativeVerificationJson(content.output)) as unknown
    } catch { return null }
    const toolSummary = JSON.stringify({ itemId: row.id, revision: row.revision, attempt: row.attempt,
      callItemId: row.callItemId, callRevision: row.callRevision, toolCallId: content.toolCallId,
      callDigest, tool: call.toolName, status: call.status, outputDigest, output })
    if (Buffer.byteLength(toolSummary, "utf8") > MAX_SUMMARY_BYTES) return null
    evidence.push({
      referenceId: evidenceRef("tool", row.id), kind: "tool_result",
      summary: toolSummary,
    })
  }
  const artifacts = await client.query(`SELECT version."id", version."artifactId", version."version", version."artifactType", version."contentHash", version."sourceDigest", version."content"
    FROM "agent_artifact_version" AS version
    JOIN "agent_sessions" AS session ON session."id" = version."sessionId" AND session."userId" = version."userId"
    JOIN "agent_turns" AS turn ON turn."id" = $3 AND turn."sessionId" = version."sessionId" AND turn."userId" = version."userId"
    JOIN "sub_agent_tasks" AS owner ON owner."id" = version."taskId" AND owner."sessionId" = version."sessionId"
      AND owner."turnId" = turn."id" AND owner."rootTaskId" = $4 AND owner."parentTaskId" = $4
    JOIN "agent_items" AS item ON item."taskId" = version."taskId" AND item."sessionId" = version."sessionId"
      AND item."turnId" = turn."id" AND item."type" = 'tool_result' AND item."content"->>'toolCallId' = version."toolCallId"
    JOIN "agent_steps" AS step ON step."id" = item."stepId" AND step."sessionId" = item."sessionId"
      AND step."turnId" = item."turnId" AND step."taskId" = item."taskId" AND step."attempt" = $6
    WHERE version."taskId" = $1 AND version."sessionId" = $2 AND version."userId" = $5
    ORDER BY version."id" LIMIT $7`, [task.id, scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId, target.attempt, MAX_ARTIFACT_FACTS + 1])
  if (artifacts.rows.length > MAX_ARTIFACT_FACTS || evidence.length + artifacts.rows.length > MAX_EVIDENCE) return null
  for (const raw of artifacts.rows) {
    const row = raw as Row
    if (typeof row.id !== "string" || typeof row.artifactId !== "string" || !Number.isSafeInteger(row.version)
      || typeof row.artifactType !== "string" || typeof row.contentHash !== "string" || typeof row.sourceDigest !== "string"
      || containsSecretField(row.content)) return null
    let artifactContent: unknown
    try {
      if (hashArtifactContent(row.content) !== row.contentHash) return null
      artifactContent = JSON.parse(canonicalNativeVerificationJson(row.content)) as unknown
    } catch { return null }
    const artifactSummary = JSON.stringify({ artifactId: row.artifactId, version: row.version, artifactType: row.artifactType,
      contentHash: row.contentHash, sourceDigest: row.sourceDigest, content: artifactContent })
    if (Buffer.byteLength(artifactSummary, "utf8") > MAX_SUMMARY_BYTES) return null
    evidence.push({
      referenceId: evidenceRef("artifact", row.id), kind: "artifact_version",
      summary: artifactSummary,
    })
  }
  return evidence
}

function containsSecretField(value: unknown): boolean {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown
      if (parsed !== value) return containsSecretField(parsed)
    } catch { /* ordinary persisted string */ }
    return false
  }
  if (Array.isArray(value)) return value.some(containsSecretField)
  if (!value || typeof value !== "object") return false
  return Object.entries(value).some(([key, child]) => SECRET_KEY.test(key) || containsSecretField(child))
}
