import type { TaskGraphTaskTemplate } from "./task-graph-command-port.js"

export const NESTED_SCOUT_PROFILE_MARKER = "applymate:nested-scout-profile:v1" as const

export const NESTED_SCOUT_ALLOWED_SOURCES = Object.freeze([
  "greenhouse",
  "lever",
  "workday",
  "smartrecruiters",
  "personio",
] as const)

export type NestedScoutProfile = Readonly<{
  sourceSlice: readonly string[]
}>

export function templatesForInteractiveScoutDelegation(
  templates: Readonly<Record<string, TaskGraphTaskTemplate>> | undefined,
  canonical: Readonly<Record<string, TaskGraphTaskTemplate>>,
): Readonly<Record<string, TaskGraphTaskTemplate>> | undefined {
  if (!templates || templates !== canonical) return templates
  const scout = templates.scout
  if (!scout || scout !== canonical.scout) return templates
  const context = nestedScoutPlainRecord(scout.context) ?? {}
  return Object.freeze({
    ...templates,
    scout: Object.freeze({
      ...scout,
      allowedActions: Object.freeze([...scout.allowedActions, "wait_subagents", "scout.delegate", "scout.results"]),
      context: Object.freeze({ ...context, nestedScoutProfile: NESTED_SCOUT_PROFILE_MARKER }),
    }),
  })
}

const EXCLUDED_CONTEXT_MARKERS = [
  "selectedJobPreparation",
  "applicationFillPreparation",
  "coverLetterBase",
  "coverLetterBaseContext",
  "writerReviewFeedback",
  "writerReviewRevision",
  "scheduledAutomationCriteria",
] as const

/** Returns the server-owned source slice only for a direct child Scout discovery task. */
export function nestedScoutProfileForTask(task: unknown): NestedScoutProfile | null {
  const taskRecord = nestedScoutPlainRecord(task)
  if (!taskRecord || !hasOwnKeys(taskRecord, ["role", "taskType", "depth", "parentTaskId", "rootTaskId", "context"])) return null
  if (taskRecord.role !== "scout" || taskRecord.taskType !== "job_discovery" || taskRecord.depth !== 1) return null
  if (!isNonEmptyString(taskRecord.parentTaskId) || !isNonEmptyString(taskRecord.rootTaskId)
    || taskRecord.parentTaskId !== taskRecord.rootTaskId) return null

  const context = nestedScoutPlainRecord(taskRecord.context)
  if (!context || context.nestedScoutProfile !== NESTED_SCOUT_PROFILE_MARKER
    || EXCLUDED_CONTEXT_MARKERS.some(key => Object.hasOwn(context, key))) return null

  return Object.freeze({ sourceSlice: NESTED_SCOUT_ALLOWED_SOURCES })
}

export function nestedScoutPlainRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null

    const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return null
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return null
      Object.defineProperty(record, key, { value: descriptor.value, enumerable: true, configurable: true, writable: true })
    }
    return record
  } catch {
    return null
  }
}

export function nestedScoutDataArray(value: unknown, minimum: number, maximum: number): unknown[] | null {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) return null
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) return null
    const result: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !("value" in descriptor)) return null
      result.push(descriptor.value)
    }
    return result
  } catch { return null }
}

export function nestedScoutStringArray(value: unknown, minimum: number, maximum: number): string[] | null {
  const values = nestedScoutDataArray(value, minimum, maximum)
  return values?.every((item): item is string => typeof item === "string") ? values as string[] : null
}

function hasOwnKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every(key => Object.hasOwn(record, key))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}
