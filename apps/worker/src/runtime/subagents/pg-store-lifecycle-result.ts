import { TASK_GRAPH_VERIFIER_VERSION, type TaskGraphVerificationReport } from "./task-graph-verification-report.js"
import type { StoredTaskGraphNode } from "./task-graph-snapshot.js"

const RESERVED_RESULT_KEYS = new Set(["taskGraphVerificationReport", "verificationReport", "taskGraphRepairReceipt", "taskGraphScheduledPrepareProofFacts"])
export function unverifiedFailureReport(node: StoredTaskGraphNode): TaskGraphVerificationReport {
  const reasonCode = node.verificationDisposition === "typed" && node.verification ? "result_invalid" : "contract_invalid"
  return { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "unverified", reasonCode, criteria: node.verification?.criteria.map(item => ({ criterionId: item.id, status: "unverified", reasonCode })) ?? [], evidenceDigest: null, resultDigest: null }
}
export function plainObject(value: unknown): Record<string, unknown> | null {
  let parsed = value; if (typeof parsed === "string") { try { parsed = JSON.parse(parsed) as unknown } catch { return null } }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null; const prototype = Object.getPrototypeOf(parsed)
  return prototype === Object.prototype || prototype === null ? parsed as Record<string, unknown> : null
}
export function stripNonterminalDiscoveryRecovery(value: unknown, status: string, retry: boolean): unknown {
  if (status === "failed" && !retry) return value
  const source = plainObject(value)
  if (!source || !Object.hasOwn(source, "discoveryRecovery")) return value
  const result = { ...source }
  delete result.discoveryRecovery
  return result
}
export function stripTaskGraphMetadata(value: unknown, active = new Set<object>(), depth = 0): unknown {
  if (depth > 32) return null
  if (typeof value === "string" && depth > 0) return value
  if (Array.isArray(value)) {
    if (active.has(value)) return null; active.add(value)
    try { return value.map(item => stripTaskGraphMetadata(item, active, depth + 1)) } finally { active.delete(value) }
  }
  const source = plainObject(value)
  if (!source) return value; if (active.has(source)) return null
  active.add(source)
  try {
    return Object.fromEntries(Object.entries(source).filter(([key]) => !RESERVED_RESULT_KEYS.has(key)).map(([key, child]) => [key, stripTaskGraphMetadata(child, active, depth + 1)]))
  } finally { active.delete(source) }
}
export function taskGraphVerificationResult(value: unknown, report: unknown, boundResult: unknown, repairReceipt: Record<string, unknown> | null): unknown { const safe = stripTaskGraphMetadata(plainObject(value) ?? { workerResult: value }) as Record<string, unknown>
  if (boundResult !== undefined) safe.structuredResult = boundResult; else delete safe.structuredResult
  return { ...safe, taskGraphVerificationReport: report, ...(repairReceipt ? { taskGraphRepairReceipt: repairReceipt } : {}) }
}
