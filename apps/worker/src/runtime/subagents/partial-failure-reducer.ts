import { validateRoleResult, type AnalystResult, type RoleEvidence, type ScoutResult, type StructuredRoleResult } from "./role-results.js"
import type { MigratedRole } from "./role-contracts.js"

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
  const successfulRoles: MigratedRole[] = []
  const failedRoles: MigratedRole[] = []
  const results: Partial<Record<MigratedRole, StructuredRoleResult>> = {}
  const failures: Array<{ role: MigratedRole; taskId: string; reason: string }> = []
  for (const outcome of outcomes) {
    if (outcome.status === "completed" && outcome.result !== undefined) {
      const result = validateRoleResult(outcome.result, outcome.role)
      results[outcome.role] = result
      successfulRoles.push(outcome.role)
    } else {
      failedRoles.push(outcome.role)
      failures.push({ role: outcome.role, taskId: outcome.taskId, reason: outcome.failureReason ?? `Role ${outcome.status}` })
    }
  }
  const evidence = Object.values(results).flatMap(result => result?.evidence ?? [])
  const jobIds = [...new Set(Object.values(results).flatMap(result => result ? resultJobIds(result) : []))]
  const status = successfulRoles.length === 0 ? "failed" : failedRoles.length === 0 ? "completed" : "partial"
  return { status, successfulRoles, failedRoles, results, evidence, jobIds, failures }
}

function resultJobIds(result: StructuredRoleResult): readonly string[] {
  return result.role === "scout" ? (result as ScoutResult).candidates.map(item => item.jobId) : (result as AnalystResult).findings.map(item => item.jobId)
}
