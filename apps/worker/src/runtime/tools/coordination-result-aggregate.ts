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
  let omittedCompletedResult = false
  const evaluated: Array<{
    readonly task: CoordinationTaskView
    readonly checked: ReturnType<typeof validatedStructuredResult>
    readonly structured: boolean
    readonly omitted: boolean
  }> = []
  for (const task of terminalRoles) {
    if (task.status !== "completed") {
      evaluated.push({ task, checked: { result: null, invalid: false }, structured: false, omitted: false })
      continue
    }
    const projection = completedStructuredResultProjection(task)
    if (projection === "invalid") return undefined
    if (projection === "oversized") {
      omittedCompletedResult = true
      evaluated.push({ task, checked: { result: null, invalid: false }, structured: true, omitted: true })
      continue
    }
    const checked = validatedStructuredResult(task)
    evaluated.push({ task, checked, structured: projection === "readable", omitted: false })
  }
  const included = evaluated.filter(item => !item.omitted)
  const hasReadableValidatedResult = included.some(item => item.structured && item.checked.result !== null)
  if (omittedCompletedResult && !hasReadableValidatedResult) return undefined
  const hasStructured = included.some(item => item.structured && (item.checked.result || item.checked.invalid))
  if (!hasStructured) return undefined
  const outcomes: RoleExecutionOutcome[] = included.map(({ task, checked }) => ({
    role: task.role as MigratedRole, taskId: task.id, status: checked.invalid ? "failed" : task.status as RoleExecutionOutcome["status"],
    result: checked.result ?? undefined, failureReason: checked.invalid ? "invalid_structured_result" : task.failureReason ?? "structured_result_unavailable",
  }))
  const reduced = reduceScoutAnalystOutcomes(outcomes)
  const pendingRoles = MIGRATED_ROLES.filter(role => latestByRole.get(role) !== undefined && !TERMINAL.has(latestByRole.get(role)!.status))
  const aggregate: WaitAggregate = {
    status: pendingRoles.length > 0 ? "pending" : omittedCompletedResult ? "partial" : reduced.status,
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
type CompletedStructuredResultProjection = "none" | "readable" | "oversized" | "invalid"
function completedStructuredResultProjection(task: CoordinationTaskView): CompletedStructuredResultProjection {
  try {
    if (!task.result || typeof task.result !== "object" || Array.isArray(task.result) || !Object.prototype.hasOwnProperty.call(task.result, "structuredResult")) return "none"
    const preview = sanitizeLifecyclePreview(task.result, MAX_WAIT_RESULT_BYTES)
    return preview && typeof preview === "object" && !Array.isArray(preview) && preview.$truncated === true ? "oversized" : "readable"
  }
  catch { return "invalid" }
}
function boundText(value: string): string {
  let result = ""
  for (const character of value) { const next = result + character; if (Buffer.byteLength(next, "utf8") > 500) break; result = next }
  return result
}
