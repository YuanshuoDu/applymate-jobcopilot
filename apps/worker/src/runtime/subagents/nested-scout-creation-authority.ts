import { NESTED_SCOUT_PROFILE_MARKER, nestedScoutPlainRecord, nestedScoutStringArray } from "./nested-scout-profile.js"
import { nestedScoutTaskScopeStateFromContext } from "./nested-scout-tools.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"

export type NestedScoutCreationAuthority = "parent_template" | "child_execution"
export const NESTED_SCOUT_PROTECTED_ACTIONS = ["scout.delegate", "scout.results"] as const
const PRIVATE_CONTEXT_KEYS = ["nestedScoutProfile", "nestedScoutSourceSlice", "nestedScoutQueryScope"] as const
const PROFILE_ACTIONS = ["wait_subagents", ...NESTED_SCOUT_PROTECTED_ACTIONS] as const
const READ_ACTIONS = ["jobs.discover", "tool_results.read"] as const
export type NestedScoutCreationTaskShape = Readonly<{
  role?: unknown; taskType?: unknown; depth?: unknown; parentTaskId?: unknown; rootTaskId?: unknown
  expectedOutputSchema?: unknown; context?: unknown; allowedActions?: unknown
}>

export function hasNestedScoutPrivateContext(value: unknown): boolean {
  if (value === null || typeof value !== "object" && typeof value !== "function") return false
  const context = nestedScoutPlainRecord(value)
  return !context || PRIVATE_CONTEXT_KEYS.some(key => Object.hasOwn(context, key))
}

export function hasNestedScoutProtectedActions(value: unknown): boolean {
  if (value === undefined) return false
  const actions = nestedScoutStringArray(value, 0, 256)
  return !actions || NESTED_SCOUT_PROTECTED_ACTIONS.some(action => actions.includes(action))
}

export function filterNestedScoutProtectedActions(value: unknown): string[] {
  return (nestedScoutStringArray(value, 0, 256) ?? []).filter(action => !NESTED_SCOUT_PROTECTED_ACTIONS.includes(action as typeof NESTED_SCOUT_PROTECTED_ACTIONS[number]))
}

export function isNestedScoutCreationAuthorityValid(authority: unknown, task: NestedScoutCreationTaskShape): authority is NestedScoutCreationAuthority {
  const actions = nestedScoutStringArray(task.allowedActions, 0, 256), schema = nestedScoutPlainRecord(task.expectedOutputSchema)
  if (!actions || new Set(actions).size !== actions.length || !schema || Object.keys(schema).sort().join(",") !== "role,schemaVersion"
    || schema.role !== "scout" || schema.schemaVersion !== ROLE_RESULT_SCHEMA
    || task.role !== "scout" || task.taskType !== "job_discovery" || typeof task.rootTaskId !== "string" || !task.rootTaskId) return false
  const context = nestedScoutPlainRecord(task.context)
  if (authority === "parent_template") return task.depth === 1 && task.parentTaskId === task.rootTaskId
    && context?.nestedScoutProfile === NESTED_SCOUT_PROFILE_MARKER
    && !Object.hasOwn(context, "nestedScoutSourceSlice") && !Object.hasOwn(context, "nestedScoutQueryScope")
    && PROFILE_ACTIONS.every(action => actions.includes(action))
  if (authority === "child_execution") return task.depth === 2 && typeof task.parentTaskId === "string" && !!task.parentTaskId
    && task.parentTaskId !== task.rootTaskId && nestedScoutTaskScopeStateFromContext(context) != null
    && actions.length === READ_ACTIONS.length && READ_ACTIONS.every(action => actions.includes(action))
  return false
}
