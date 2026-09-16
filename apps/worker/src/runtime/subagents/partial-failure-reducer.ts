import { validateRoleResult, type AnalystResult, type RoleEvidence, type ScoutResult, type StructuredRoleResult } from "./role-results.js"
import { MIGRATED_ROLES, type MigratedRole } from "./scout-analyst-contracts.js"

export type RoleExecutionOutcome = {
  readonly role: MigratedRole
  readonly taskId: string
  readonly status: "completed" | "failed" | "interrupted" | "cancelled"
  readonly result?: unknown
  readonly failureReason?: string
}

export type ScoutAnalystAggregate = {
  readonly status: "completed" | "partial" | "failed"
  readonly successfulRoles: readonly MigratedRole[]
  readonly failedRoles: readonly MigratedRole[]
  readonly results: Readonly<Partial<Record<MigratedRole, StructuredRoleResult>>>
  readonly evidence: readonly RoleEvidence[]
  readonly jobIds: readonly string[]
  readonly failures: readonly { readonly role: MigratedRole; readonly taskId: string; readonly reason: string }[]
}

export function reduceScoutAnalystOutcomes(outcomes: readonly RoleExecutionOutcome[]): ScoutAnalystAggregate {
  const latestByRole = new Map<MigratedRole, RoleExecutionOutcome>()
  for (const outcome of outcomes) {
    try {
      const role = outcome.role
      if (isMigratedRole(role)) latestByRole.set(role, outcome)
    } catch {
      // A malformed outcome cannot be represented in this aggregate and is ignored safely.
    }
  }

  const results: Partial<Record<MigratedRole, StructuredRoleResult>> = {}
  const failures: Array<{ role: MigratedRole; taskId: string; reason: string }> = []

  // Duplicate role rule: the last occurrence in the supplied sequence wins. The
  // reducer has no timestamp or external sequence, so input order is the only
  // deterministic meaning of "latest".
  for (const role of MIGRATED_ROLES) {
    const outcome = latestByRole.get(role)
    if (!outcome) continue

    const reduced = reduceOutcome(role, outcome)
    if (reduced.result) {
      results[role] = reduced.result
    } else if (reduced.failure) {
      failures.push(reduced.failure)
    }
  }

  const successfulRoles = MIGRATED_ROLES.filter(role => results[role] !== undefined)
  const failedRoles = MIGRATED_ROLES.filter(role => failures.some(failure => failure.role === role))
  const orderedResults = MIGRATED_ROLES.flatMap(role => results[role] ? [results[role]!] : [])
  const evidence = uniqueEvidence(orderedResults.flatMap(result => result.evidence))
  const jobIds = [...new Set(orderedResults.flatMap(resultJobIds))].sort(compareText)
  failures.sort(compareFailures)
  const status = successfulRoles.length === 0 ? "failed" : failedRoles.length === 0 ? "completed" : "partial"
  return { status, successfulRoles, failedRoles, results, evidence, jobIds, failures }
}

function reduceOutcome(role: MigratedRole, outcome: RoleExecutionOutcome): {
  readonly result?: StructuredRoleResult
  readonly failure?: { readonly role: MigratedRole; readonly taskId: string; readonly reason: string }
} {
  try {
    if (outcome.status === "completed" && outcome.result !== undefined) {
      return { result: validateRoleResult(outcome.result, role) }
    }
    return { failure: { role, taskId: safeTaskId(outcome), reason: safeFailureReason(outcome) } }
  } catch {
    // Validation is a child boundary: malformed, foreign, or throwing results fail closed.
    return { failure: { role, taskId: safeTaskId(outcome), reason: "Invalid role result" } }
  }
}

function isMigratedRole(value: unknown): value is MigratedRole {
  return value === "scout" || value === "analyst"
}

function safeTaskId(outcome: RoleExecutionOutcome): string {
  try {
    return typeof outcome.taskId === "string" ? outcome.taskId : "unknown-task"
  } catch {
    return "unknown-task"
  }
}

function safeFailureReason(outcome: RoleExecutionOutcome): string {
  try {
    if (typeof outcome.failureReason === "string") return outcome.failureReason
    return outcome.status === "completed" || outcome.status === "failed" || outcome.status === "interrupted" || outcome.status === "cancelled"
      ? `Role ${outcome.status}`
      : "Role failed"
  } catch {
    return "Role failed"
  }
}

function uniqueEvidence(evidence: readonly RoleEvidence[]): RoleEvidence[] {
  const ordered = [...evidence].sort(compareEvidence)
  const unique: RoleEvidence[] = []
  for (const item of ordered) {
    if (unique.at(-1)?.id !== item.id) unique.push(item)
  }
  return unique
}

function compareEvidence(left: RoleEvidence, right: RoleEvidence): number {
  return compareText(left.id, right.id) || compareText(left.kind, right.kind) || compareText(left.ref, right.ref) || compareText(left.source, right.source)
}

function compareFailures(left: { readonly role: MigratedRole; readonly taskId: string; readonly reason: string }, right: { readonly role: MigratedRole; readonly taskId: string; readonly reason: string }): number {
  return MIGRATED_ROLES.indexOf(left.role) - MIGRATED_ROLES.indexOf(right.role) || compareText(left.taskId, right.taskId) || compareText(left.reason, right.reason)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function resultJobIds(result: StructuredRoleResult): readonly string[] {
  return result.role === "scout" ? (result as ScoutResult).candidates.map(item => item.jobId) : (result as AnalystResult).findings.map(item => item.jobId)
}
