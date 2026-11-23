import { Buffer } from "node:buffer"
import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, TurnIntentSchema, validate } from "@jobcopilot/agent-protocol"
import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import type { SubagentTaskSpec } from "./types.js"
import type { GraphScope } from "./task-graph-pg-state.js"
import type { TaskGraphTaskTemplate } from "./task-graph-command-port.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-template-definitions.js"
import { templatesForInteractiveScoutDelegation } from "./nested-scout-profile.js"
import { canonicalTaskGraphJson } from "./task-graph-snapshot.js"
import { TASK_GRAPH_DEPENDENCY_CONTEXT_BYTE_LIMIT } from "./task-graph-dependency-context.js"
import type { Queryable } from "./pg-store-persistence.js"

const REGISTERED_OBJECTIVE_CHILDREN = {
  scout: [TASK_GRAPH_TEMPLATES.scout, templatesForInteractiveScoutDelegation(TASK_GRAPH_TEMPLATES, TASK_GRAPH_TEMPLATES)?.scout]
    .filter((template): template is TaskGraphTaskTemplate => Boolean(template)),
  analyst: [TASK_GRAPH_TEMPLATES.analyst],
} satisfies Record<"scout" | "analyst", readonly TaskGraphTaskTemplate[]>

function templateProjection(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const template = value as Record<string, unknown>
  if (typeof template.role !== "string" || typeof template.taskType !== "string"
    || !Array.isArray(template.allowedActions) || !template.allowedActions.every(action => typeof action === "string")) return null
  const constraints = template.constraints ?? []
  if (!Array.isArray(constraints) || !constraints.every(entry => typeof entry === "string")) return null
  return {
    role: template.role, taskType: template.taskType, allowedActions: template.allowedActions,
    constraints, context: template.context ?? {}, expectedOutputSchema: template.expectedOutputSchema ?? {},
  }
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const keys = Reflect.ownKeys(value)
    if (keys.some(key => typeof key !== "string" || !Object.getOwnPropertyDescriptor(value, key)?.enumerable
      || !("value" in Object.getOwnPropertyDescriptor(value, key)!))) return null
    return value as Record<string, unknown>
  } catch { return null }
}

function validDependencyContext(value: unknown): boolean {
  const receipt = plainRecord(value)
  if (!receipt || Object.keys(receipt).sort().join(",") !== "items,schemaVersion"
    || receipt.schemaVersion !== "agent-harness.v2.task-graph.dependency-evidence"
    || !Array.isArray(receipt.items) || receipt.items.length < 1 || receipt.items.length > TASK_GRAPH_LIMITS.maxDependencies
    || Object.getPrototypeOf(receipt.items) !== Array.prototype || Reflect.ownKeys(receipt.items).length !== receipt.items.length + 1
    || receipt.items.some((_item, index) => !Object.hasOwn(receipt.items as unknown[], index))) return false
  try { return Buffer.byteLength(JSON.stringify(receipt), "utf8") <= TASK_GRAPH_DEPENDENCY_CONTEXT_BYTE_LIMIT }
  catch { return false }
}

function registeredObjectiveChildSpec(candidate: Record<string, unknown>): boolean {
  try {
    return Object.values(REGISTERED_OBJECTIVE_CHILDREN).flat().some(template => {
      const expected = templateProjection(template) as Record<string, unknown> | null
      const context = plainRecord(candidate.context)
      if (!expected || !context) return false
      const baseContext = { ...context }
      const hasDependencyContext = Object.hasOwn(context, "taskGraphDependencyResults")
      const dependencyContext = context.taskGraphDependencyResults
      if (hasDependencyContext) delete baseContext.taskGraphDependencyResults
      const actual = { ...candidate, context: baseContext }
      return canonicalTaskGraphJson(actual) === canonicalTaskGraphJson(expected)
        && (!hasDependencyContext || validDependencyContext(dependencyContext))
    })
  } catch { return false }
}

function exactTemplate(value: unknown, registered: TaskGraphTaskTemplate): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    const keys = Reflect.ownKeys(value), expected = Reflect.ownKeys(registered)
    if ((prototype !== Object.prototype && prototype !== null) || keys.length !== expected.length
      || keys.some(key => typeof key !== "string" || !expected.includes(key))) return false
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return false
    }
    return canonicalTaskGraphJson(value) === canonicalTaskGraphJson(registered)
  } catch { return false }
}

/** Matches only registered read-only Scout and Analyst templates for ObjectiveStart. */
export function isRegisteredObjectiveTaskGraphChildTemplate(templateId: string, template: TaskGraphTaskTemplate): boolean {
  const registered = Object.hasOwn(REGISTERED_OBJECTIVE_CHILDREN, templateId)
    ? REGISTERED_OBJECTIVE_CHILDREN[templateId as keyof typeof REGISTERED_OBJECTIVE_CHILDREN] : []
  return registered.some(candidate => exactTemplate(template, candidate))
}

function exactObjectiveIntent(value: unknown): boolean {
  const envelope = record(value)
  if (!envelope || Object.hasOwn(envelope, "input")) return false
  const intent = record(envelope.intent)
  return Boolean(intent && Object.keys(intent).sort().join(",") === "kind,version"
    && validate(TurnIntentSchema, intent)
    && canonicalTaskGraphJson(intent) === canonicalTaskGraphJson(OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT))
}

function record(value: unknown): Record<string, unknown> | null {
  return plainRecord(value)
}

function matchingScope(scope: GraphScope, input: SubagentTaskSpec): boolean {
  return typeof scope.stepId === "string" && scope.stepId.trim().length > 0
    && scope.userId === input.userId && scope.sessionId === input.sessionId && scope.turnId === input.turnId
    && scope.parentTaskId === input.parentTaskId && scope.rootTaskId === input.parentTaskId
    && scope.parentTaskId === scope.rootTaskId && typeof scope.turnLeaseOwner === "string" && scope.turnLeaseOwner.trim().length > 0
    && Number.isSafeInteger(scope.turnLeaseVersion) && scope.turnLeaseVersion > 0
    && typeof scope.parentLeaseOwner === "string" && scope.parentLeaseOwner.trim().length > 0
    && Number.isSafeInteger(scope.parentAttemptCount) && scope.parentAttemptCount > 0
}

/** Reuses Session/Turn/Root/Step locks already held by the TaskGraph schedule transaction. */
export async function admitOwnedObjectiveTaskGraphChild(
  client: Queryable, input: SubagentTaskSpec, authority: GraphScope | undefined,
): Promise<boolean> {
  if (!authority || !matchingScope(authority, input)) return false
  let candidate: unknown
  try {
    candidate = templateProjection({ role: input.role, taskType: input.taskType, allowedActions: input.allowedActions,
      constraints: input.constraints, context: input.context, expectedOutputSchema: input.expectedOutputSchema })
  } catch { return false }
  if (!candidate) return false
  if (!registeredObjectiveChildSpec(candidate as Record<string, unknown>)) return false
  const result = await client.query(`WITH live AS MATERIALIZED (SELECT clock_timestamp() AS "at")
    SELECT turn."input", turn."executionMode" FROM live
    JOIN "agent_sessions" AS session ON session."id" = $1 AND session."userId" = $2
      AND session."status" NOT IN ('aborted', 'archived')
    JOIN "agent_turns" AS turn ON turn."id" = $3 AND turn."sessionId" = session."id" AND turn."userId" = session."userId"
      AND turn."source" = 'user' AND (turn."executionMode" IS NULL OR turn."executionMode" = 'canonical_task_graph')
      AND turn."status" = 'in_progress'
      AND turn."rootTaskId" = $4 AND turn."leaseOwnerId" = $5 AND turn."leaseVersion" = $6 AND turn."leaseExpiresAt" > live."at"
    JOIN "sub_agent_tasks" AS root ON root."id" = $4 AND root."sessionId" = session."id" AND root."turnId" = turn."id"
      AND root."rootTaskId" = root."id" AND root."parentTaskId" IS NULL AND root."role" = 'orchestrator'
      AND root."taskType" = 'root' AND root."status" = 'running' AND root."leaseOwner" = $7
      AND root."attemptCount" = $8 AND root."interruptRequestedAt" IS NULL AND root."leaseExpiresAt" > live."at"
    JOIN "agent_steps" AS step ON step."id" = $9 AND step."sessionId" = session."id" AND step."turnId" = turn."id"
      AND step."taskId" = root."id" AND step."status" = 'streaming'
    WHERE NOT EXISTS (SELECT 1 FROM "agent_steps" AS newer WHERE newer."sessionId" = session."id"
      AND newer."turnId" = turn."id" AND newer."taskId" = root."id" AND newer."ordinal" > step."ordinal")`,
  [authority.sessionId, authority.userId, authority.turnId, authority.rootTaskId, authority.turnLeaseOwner,
    authority.turnLeaseVersion, authority.parentLeaseOwner, authority.parentAttemptCount, authority.stepId])
  if (result.rows.length !== 1) return false
  const turn = result.rows[0] as Record<string, unknown>
  if (!exactObjectiveIntent(turn.input)) return false
  if (turn.executionMode === "canonical_task_graph") return true
  if (turn.executionMode !== null) return false
  const promoted = await client.query(`UPDATE "agent_turns" AS turn SET "executionMode" = 'canonical_task_graph'
    WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3
      AND turn."source" = 'user' AND turn."status" = 'in_progress' AND turn."rootTaskId" = $4
      AND turn."leaseOwnerId" = $5 AND turn."leaseVersion" = $6 AND turn."executionMode" IS NULL
      AND turn."leaseExpiresAt" > clock_timestamp() RETURNING turn."id"`,
  [authority.turnId, authority.sessionId, authority.userId, authority.rootTaskId, authority.turnLeaseOwner, authority.turnLeaseVersion])
  return promoted.rowCount === 1 && promoted.rows.length === 1
}
