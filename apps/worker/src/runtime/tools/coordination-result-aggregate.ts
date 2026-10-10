import { reduceScoutAnalystOutcomes, type ScoutAnalystAggregate, type RoleExecutionOutcome } from "../subagents/partial-failure-reducer.js"
import { validateRoleResult, type StructuredRoleResult } from "../subagents/role-results.js"
import { MIGRATED_ROLES, type MigratedRole } from "../subagents/scout-analyst-contracts.js"
import type { CoordinationTaskView } from "./coordination-types.js"
import { sanitizeLifecyclePreview } from "./redaction.js"

const MAX_AGGREGATE_BYTES = 2 * 1024
const MAX_WAIT_RESULT_BYTES = 2 * 1024
const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "closed"])

export type WaitAggregate = {
  readonly status: ScoutAnalystAggregate["status"] | "pending"
  readonly successfulRoles: readonly MigratedRole[]
  readonly failedRoles: readonly MigratedRole[]
  readonly pendingRoles?: readonly MigratedRole[]
  readonly jobIds: readonly string[]
  readonly failures: readonly { readonly role: MigratedRole; readonly taskId: string; readonly reason: string }[]
}

export function validatedStructuredResult(task: CoordinationTaskView): { readonly result: StructuredRoleResult | null; readonly invalid: boolean } {
  const value = task.result
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.prototype.hasOwnProperty.call(value, "structuredResult")) return { result: null, invalid: false }
  if (!isMigratedRole(task.role)) return { result: null, invalid: true }
  if (task.status !== "completed") return { result: null, invalid: false }
  try { return { result: validateRoleResult((value as Record<string, unknown>).structuredResult, task.role), invalid: false } }
  catch { return { result: null, invalid: true } }
}

export function buildScoutAnalystAggregate(tasks: readonly CoordinationTaskView[]): WaitAggregate | undefined {
  const latestByRole = new Map<MigratedRole, CoordinationTaskView>()
  for (const task of tasks) if (isMigratedRole(task.role)) latestByRole.set(task.role, task)
  const latestTasks = [...latestByRole.values()]
  const terminalRoles = latestTasks.filter(task => TERMINAL.has(task.status))
  const checkedRoles = terminalRoles.map(task => {
    if (task.status !== "completed") return { task, projectable: true, checked: { result: null, invalid: false } }
    const projectable = projectableStructuredResult(task)
    return {
      task,
      projectable,
      checked: projectable ? validatedStructuredResult(task) : { result: null, invalid: false },
    }
  })
  const hasOversizedStructuredResult = checkedRoles.some(({ task, projectable }) => !projectable && hasStructuredResult(task))
  const hasReadableValidatedResult = checkedRoles.some(({ projectable, checked }) => projectable && checked.result !== null)
  if (hasOversizedStructuredResult && !hasReadableValidatedResult) return undefined
  const readableRoles = checkedRoles.filter(entry => entry.projectable)
  const hasStructured = readableRoles.some(({ checked }) => checked.result || checked.invalid)
  if (!hasStructured) return undefined
  const outcomes: RoleExecutionOutcome[] = readableRoles.map(({ task, checked }) => ({
    role: task.role as MigratedRole, taskId: task.id, status: checked.invalid ? "failed" : task.status as RoleExecutionOutcome["status"],
    result: checked.result ?? undefined, failureReason: checked.invalid ? "invalid_structured_result" : task.failureReason ?? "structured_result_unavailable",
  }))
  const reduced = reduceScoutAnalystOutcomes(outcomes)
  const pendingRoles = MIGRATED_ROLES.filter(role => latestByRole.get(role) !== undefined && !TERMINAL.has(latestByRole.get(role)!.status))
  const aggregate: WaitAggregate = {
    status: pendingRoles.length > 0 ? "pending" : hasOversizedStructuredResult ? "partial" : reduced.status,
    successfulRoles: reduced.successfulRoles,
    failedRoles: reduced.failedRoles,
    ...(pendingRoles.length > 0 ? { pendingRoles } : {}),
    jobIds: reduced.jobIds,
    failures: reduced.failures.map(failure => ({ ...failure, reason: boundText(failure.reason) })),
  }
  if (aggregate.jobIds.length > 64) return undefined
  try {
    return Buffer.byteLength(JSON.stringify(aggregate), "utf8") <= MAX_AGGREGATE_BYTES ? aggregate : undefined
  } catch { return undefined }
}

function isMigratedRole(value: unknown): value is MigratedRole { return value === "scout" || value === "analyst" }
function hasStructuredResult(task: CoordinationTaskView): boolean {
  const value = task.result
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, "structuredResult")
}
function projectableStructuredResult(task: CoordinationTaskView): boolean {
  if (!hasStructuredResult(task)) return true
  try {
    const preview = sanitizeLifecyclePreview(task.result, MAX_WAIT_RESULT_BYTES)
    return !(preview && typeof preview === "object" && !Array.isArray(preview) && preview.$truncated === true)
  }
  catch { return false }
}
function boundText(value: string): string {
  let result = ""
  for (const character of value) { const next = result + character; if (Buffer.byteLength(next, "utf8") > 500) break; result = next }
  return result
}
