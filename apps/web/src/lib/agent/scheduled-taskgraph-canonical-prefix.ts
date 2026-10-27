import { createHash } from "node:crypto"
import { parseScheduledPipelineAttestation } from "@jobcopilot/agent-protocol"
import type { ScheduledTaskGraphPipelineOwner } from "./scheduled-taskgraph-pipeline-checkpoint"

export type ScheduledTaskGraphCanonicalNode = Readonly<{
  key: string; templateId: string; taskId: string; depth: number; dependsOn: readonly string[]; verificationDisposition: string
}>
export type ScheduledTaskGraphCanonicalPrefix = Readonly<{
  scouts: readonly ScheduledTaskGraphCanonicalNode[]; analyst: ScheduledTaskGraphCanonicalNode
  prepare?: ScheduledTaskGraphCanonicalNode; gate?: ScheduledTaskGraphCanonicalNode; audit?: ScheduledTaskGraphCanonicalNode
}>
export type ScheduledTaskGraphCanonicalStage = "analyze" | "prepare" | "gate" | "audit"

export function projectScheduledTaskGraphCanonicalPrefix(
  value: unknown,
  attestationValue: unknown,
  stage: ScheduledTaskGraphCanonicalStage,
): ScheduledTaskGraphCanonicalPrefix | null {
  const graph = record(value), rawNodes = denseArray(graph?.nodes), attestation = parseScheduledPipelineAttestation(attestationValue)
  if (!graph || graph.schemaVersion !== "agent-harness.v2.task-graph" || !rawNodes || !attestation) return null
  const nodes = rawNodes.map(parseNode)
  if (nodes.some(node => !node) || !unique(nodes as ScheduledTaskGraphCanonicalNode[])) return null
  const parsed = nodes as ScheduledTaskGraphCanonicalNode[]
  const sources = attestation.schemaVersion === "agent-harness.v2.scheduled-pipeline-attestation.v1"
    ? [{ nodeKey: "scout", taskId: attestation.scout.taskId }]
    : attestation.scouts.map(source => ({ nodeKey: source.nodeKey, taskId: source.taskId }))
  const scoutCount = sources.length, analyzeCount = scoutCount + 1, prepareCount = analyzeCount + 1
  const expectedCount = stage === "analyze" ? analyzeCount : stage === "prepare" ? prepareCount
    : stage === "audit" ? prepareCount + 2 : prepareCount + 1
  const maxCount = stage === "gate" ? expectedCount + 1 : expectedCount
  if (parsed.length < expectedCount || parsed.length > maxCount) return null
  const scouts = parsed.slice(0, scoutCount), sourceKeys = new Set(sources.map(source => source.nodeKey))
  if (scouts.some(node => !sourceKeys.has(node.key) || !sources.some(source => source.nodeKey === node.key && source.taskId === node.taskId)
    || node.templateId !== "scout" || node.depth !== 1 || node.dependsOn.length !== 0 || node.verificationDisposition !== "typed")) return null
  const analyst = parsed[scoutCount]!
  if (analyst.key !== (attestation.schemaVersion === "agent-harness.v2.scheduled-pipeline-attestation.v1" ? "analyst" : attestation.analyst.nodeKey)
    || analyst.templateId !== "analyst" || analyst.taskId !== attestation.analyst.taskId || analyst.depth !== 2
    || !sameIds(analyst.dependsOn, sources.map(source => source.nodeKey)) || analyst.verificationDisposition !== "typed") return null
  if (stage === "analyze") return { scouts, analyst }
  const prepare = parsed[scoutCount + 1]!
  if (prepare.key !== "prepare" || prepare.templateId !== "prepare" || prepare.depth !== 3
    || !sameStrings(prepare.dependsOn, [analyst.key]) || prepare.verificationDisposition !== "specialized") return null
  if (stage === "prepare") return { scouts, analyst, prepare }
  const gate = parsed[scoutCount + 2]!
  if (gate.key !== "gate" || gate.templateId !== "gate" || gate.depth !== 4
    || !sameStrings(gate.dependsOn, [prepare.key]) || gate.verificationDisposition !== "specialized") return null
  if (parsed.length === scoutCount + 3) return stage === "gate" ? { scouts, analyst, prepare, gate } : null
  const audit = parsed[scoutCount + 3]!
  return stage !== "gate" && stage !== "audit" || audit.key !== "scheduled_audit" || audit.templateId !== "scheduled_audit"
    || audit.depth !== 5 || !sameStrings(audit.dependsOn, [gate.key]) || audit.verificationDisposition !== "specialized"
    ? null : { scouts, analyst, prepare, gate, audit }
}

export function sameScheduledTaskGraphCanonicalPrefix(priorValue: unknown, nextValue: unknown, nodeCount: number): boolean {
  const prior = record(priorValue), next = record(nextValue), priorNodes = denseArray(prior?.nodes), nextNodes = denseArray(next?.nodes)
  if (!prior || !next || !priorNodes || !nextNodes || !Number.isSafeInteger(nodeCount) || nodeCount < 1
    || priorNodes.length !== nodeCount || nextNodes.length < nodeCount + 1) return false
  return sameScheduledTaskGraphJson({ ...prior, nodes: priorNodes }, { ...next, nodes: nextNodes.slice(0, nodeCount) })
}

function parseNode(value: unknown): ScheduledTaskGraphCanonicalNode | null {
  const row = record(value), dependsOn = denseArray(row?.dependsOn)
  return row && validId(row.key) && validId(row.taskId) && typeof row.templateId === "string"
    && Number.isSafeInteger(row.depth) && Array.isArray(dependsOn) && dependsOn.every(validId)
    && typeof row.verificationDisposition === "string"
    ? { key: row.key, templateId: row.templateId, taskId: row.taskId, depth: Number(row.depth), dependsOn: dependsOn as string[], verificationDisposition: row.verificationDisposition }
    : null
}
function unique(nodes: readonly ScheduledTaskGraphCanonicalNode[]): boolean {
  return new Set(nodes.map(node => node.key)).size === nodes.length && new Set(nodes.map(node => node.taskId)).size === nodes.length
}
function sameIds(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && new Set(actual).size === actual.length && expected.every(key => actual.includes(key))
}
function sameStrings(actual: readonly string[], expected: readonly string[]): boolean { return actual.length === expected.length && actual.every((value, index) => value === expected[index]) }
function denseArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null
  const keys = Reflect.ownKeys(value)
  return keys.length === value.length + 1 && keys.includes("length") ? value : null
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }
export function sameScheduledTaskGraphJson(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)) } catch { return false }
}
export function scheduledTaskGraphVerificationReportMatches(report: Record<string, unknown> | null,
  node: Record<string, unknown>, attestation: Record<string, unknown>): boolean {
  const criteria = denseArray(record(node.verification)?.criteria)?.map(record), rows = denseArray(report?.criteria)?.map(record)
  return report?.verifierVersion === "agent-harness.v2.task-graph-verifier.v1" && report.status === "passed"
    && record(node.verification)?.role === node.templateId && report.reasonCode === "criteria_met"
    && report.resultDigest === attestation.resultDigest && typeof report.evidenceDigest === "string"
    && (!attestation.evidenceDigest || report.evidenceDigest === attestation.evidenceDigest)
    && (!attestation.reportDigest || reportDigest(report) === attestation.reportDigest)
    && Boolean(criteria?.length && rows?.length === criteria.length && rows.every((row, index) => row !== null
      && row.criterionId === criteria[index]?.id && row.status === "passed" && row.reasonCode === "criteria_met"))
}
export function sameScheduledTaskGraphOwnerScope(value: Record<string, unknown> | null, owner: ScheduledTaskGraphPipelineOwner): boolean {
  return Boolean(value && ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount"]
    .every(key => value[key] === owner[key as keyof ScheduledTaskGraphPipelineOwner]))
}
export function sameScheduledTaskGraphIdSet(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.every(validId) && actual.length === expected.length
    && new Set(actual).size === actual.length && expected.every(id => actual.includes(id))
}
export function uniqueScheduledTaskGraphRows<T>(rows: readonly T[], key: (row: T) => string): Map<string, T> | null {
  const result = new Map<string, T>()
  for (const row of rows) { const id = key(row); if (result.has(id)) return null; result.set(id, row) }
  return result
}
export function scheduledTaskGraphAuditNodeMatches(node: Record<string, unknown>, taskId: string, goal: string, criteria: readonly string[]): boolean {
  const keys = ["key", "templateId", "goal", "successCriteria", "dependsOn", "depth", "taskId", "verificationDisposition"]
  return Reflect.ownKeys(node).length === keys.length && Reflect.ownKeys(node).every(key => typeof key === "string" && keys.includes(key))
    && node.key === "scheduled_audit" && node.templateId === "scheduled_audit" && node.taskId === taskId && node.depth === 5
    && sameScheduledTaskGraphIdSet(node.dependsOn, ["gate"]) && node.verificationDisposition === "specialized"
    && node.goal === goal && sameScheduledTaskGraphJson(node.successCriteria, criteria)
}
function reportDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex")
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  const row = record(value)
  return row ? Object.fromEntries(Object.keys(row).sort().map(key => [key, canonical(row[key])])) : value
}
