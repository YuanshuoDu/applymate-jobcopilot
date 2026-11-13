import { createHash } from "node:crypto"
import { Type } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"
import type pg from "pg"
import type { AgentTreeManager } from "./manager.js"
import { NESTED_SCOUT_ALLOWED_SOURCES, nestedScoutDataArray as denseArray, nestedScoutPlainRecord as record,
  nestedScoutStringArray as stringArray, type NestedScoutProfile } from "./nested-scout-profile.js"
import { parseDiscoveryQueryFootprint } from "./child-discovery-query-footprint.js"
import { parseDiscoveryAttemptSidecar, type DiscoveryAttemptSidecar } from "./child-discovery-attempt.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { projectNestedScoutResults } from "./nested-scout-result-projection.js"
import { ToolExecutionError, type RuntimeToolDefinition, type ToolExecutionContext } from "../tools/types.js"
import type { SubagentLease, SubagentTaskSpec } from "./types.js"

const MAX_GOAL_LENGTH = 300, MAX_CHILDREN = 2, MAX_ROWS = 3, MAX_STORED_RESULT_BYTES = 65_536
const MAX_PARENT_CONSTRAINTS = 31, MAX_CONSTRAINT_LENGTH = 1_000
const NESTED_SCOUT_SCOPE_CONSTRAINT = "Use only the server-published Scout tools and immutable discovery scope in task context."
const READ_ACTIONS = Object.freeze(["jobs.discover", "tool_results.read"])
const ACTIVE_CHILD_STATUSES = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user"])
const TERMINAL_CHILD_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled", "closed"])
const SourceSchema = Type.Union([Type.Literal("greenhouse"), Type.Literal("lever"), Type.Literal("workday"), Type.Literal("smartrecruiters"), Type.Literal("personio")])
const DelegateInput = Type.Object({
  goal: Type.String({ minLength: 1, maxLength: MAX_GOAL_LENGTH }),
  sourceSlice: Type.Array(SourceSchema, { minItems: 1, maxItems: NESTED_SCOUT_ALLOWED_SOURCES.length }),
}, { additionalProperties: false })
const DelegateOutput = Type.Object({ taskId: Type.String({ minLength: 1, maxLength: 256 }), status: Type.Union([Type.Literal("queued"), Type.Literal("duplicate")]) }, { additionalProperties: false })
const CandidateOutput = Type.Object({ jobId: Type.String({ minLength: 1, maxLength: 256 }), source: SourceSchema }, { additionalProperties: false })
const ResultOutput = Type.Object({ availability: Type.Union([Type.Literal("available"), Type.Literal("pending"), Type.Literal("unavailable")]), children: Type.Array(Type.Object({
  taskId: Type.String({ minLength: 1, maxLength: 256 }), status: Type.String({ minLength: 1, maxLength: 32 }), candidates: Type.Array(CandidateOutput, { maxItems: 20 }),
}, { additionalProperties: false }), { maxItems: MAX_CHILDREN }) }, { additionalProperties: false })

export type NestedScoutQueryScope = Readonly<{ source: string; targetRoles: readonly string[]; targetLocations: readonly string[]; maxPageSize: number }>
export type NestedScoutTaskScope = Readonly<{ sourceSlice: readonly string[]; queries: readonly NestedScoutQueryScope[] }>
export type NestedScoutManagerProvider = () => Pick<AgentTreeManager, "spawnFromLease"> | undefined

type ParentFence = Pick<SubagentLease, "id" | "userId" | "sessionId" | "turnId" | "rootTaskId" | "ownerId" | "leaseOwner" | "attemptCount" | "status" | "interruptRequestedAt" | "leaseExpiresAt">
type NestedToolOptions = Readonly<{ pool: Pick<pg.Pool, "connect">; lease: SubagentLease; profile: NestedScoutProfile
  subagentManager: NestedScoutManagerProvider; discoveryAttemptSidecar?: () => DiscoveryAttemptSidecar | undefined }>

export function deriveNestedScoutSourceScope(value: unknown, profile: NestedScoutProfile, attemptCount: number): NestedScoutTaskScope | null {
  const sidecar = record(value)
  if (!sidecar || !parseDiscoveryAttemptSidecar(value, attemptCount) || !Object.hasOwn(sidecar, "queryFootprint")) return null
  const footprint = parseDiscoveryQueryFootprint(sidecar.queryFootprint)
  if (!footprint || footprint.availability !== "available" || footprint.calls.length < 1) return null
  const queries: NestedScoutQueryScope[] = []
  for (const call of footprint.calls) {
    if (call.criteria.hasCursor) return null
    const sources = call.criteria.source ? [call.criteria.source] : profile.sourceSlice
    for (const source of sources) {
      if (!profile.sourceSlice.includes(source)) return null
      queries.push({ source, targetRoles: call.criteria.targetRoles, targetLocations: call.criteria.targetLocations, maxPageSize: call.criteria.pageSize ?? 50 })
    }
  }
  const unique = [...new Map(queries.map(query => [JSON.stringify(query), query])).values()]
  const sourceSlice = [...new Set(unique.map(query => query.source))]
  return unique.length > 0 && unique.length <= 40 ? Object.freeze({ sourceSlice: Object.freeze(sourceSlice), queries: Object.freeze(unique) }) : null
}

export function restrictNestedScoutScope(parent: NestedScoutTaskScope, requested: unknown): NestedScoutTaskScope | null {
  const sources = stringArray(requested, 1, NESTED_SCOUT_ALLOWED_SOURCES.length)
  if (!sources || new Set(sources).size !== sources.length || sources.some(source => !parent.sourceSlice.includes(source))) return null
  const queries = parent.queries.filter(query => sources.includes(query.source))
  return queries.length ? Object.freeze({ sourceSlice: Object.freeze([...sources]), queries: Object.freeze(queries) }) : null
}

export function nestedScoutQueryAllowed(scope: NestedScoutTaskScope, query: Readonly<{
  targetRoles: readonly string[]; targetLocations: readonly string[]; source?: string; pageSize?: number; cursor?: string
}>): boolean {
  if (!query.source || !scope.sourceSlice.includes(query.source) || query.cursor !== undefined
    || !query.targetRoles.length || query.targetRoles.length > 8 || query.targetLocations.length > 8
    || query.targetRoles.some(role => !safeText(role, 160)) || query.targetLocations.some(location => !safeText(location, 160))) return false
  const pageSize = query.pageSize ?? 50
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) return false
  return scope.queries.some(parent => parent.source === query.source
    && query.targetRoles.length > 0 && query.targetRoles.every(role => parent.targetRoles.includes(role))
    && (parent.targetLocations.length === 0 || query.targetLocations.length > 0 && query.targetLocations.every(location => parent.targetLocations.includes(location)))
    && pageSize <= parent.maxPageSize)
}

/** Undefined means this is not a nested Scout context; null means it is present but invalid. */
export function nestedScoutTaskScopeStateFromContext(value: unknown): NestedScoutTaskScope | null | undefined {
  const context = record(value)
  if (!context) return value === null || value === undefined ? undefined : null
  if (!Object.hasOwn(context, "nestedScoutSourceSlice") && !Object.hasOwn(context, "nestedScoutQueryScope")) return undefined
  if (Object.keys(context).sort().join(",") !== "nestedScoutQueryScope,nestedScoutSourceSlice") return null
  const sourceSlice = stringArray(context.nestedScoutSourceSlice, 1, NESTED_SCOUT_ALLOWED_SOURCES.length)
  const rawQueries = denseArray(context.nestedScoutQueryScope, 1, 40)
  if (!sourceSlice || new Set(sourceSlice).size !== sourceSlice.length || sourceSlice.some(source => !isSource(source))
    || !rawQueries) return null
  const queries: NestedScoutQueryScope[] = []
  for (const item of rawQueries) {
    const row = record(item)
    if (!row || Object.keys(row).sort().join(",") !== "maxPageSize,source,targetLocations,targetRoles"
      || !isSource(row.source) || !sourceSlice.includes(row.source) || !Number.isSafeInteger(row.maxPageSize)
      || Number(row.maxPageSize) < 1 || Number(row.maxPageSize) > 50) return null
    const targetRoles = stringArray(row.targetRoles, 1, 8), targetLocations = stringArray(row.targetLocations, 0, 8)
    if (!targetRoles || !targetLocations || targetRoles.some(role => !safeText(role, 160))
      || targetLocations.some(location => !safeText(location, 160))) return null
    queries.push(Object.freeze({ source: row.source, targetRoles: Object.freeze(targetRoles), targetLocations: Object.freeze(targetLocations), maxPageSize: Number(row.maxPageSize) }))
  }
  if (new Set(queries.map(query => query.source)).size !== sourceSlice.length
    || sourceSlice.some(source => !queries.some(query => query.source === source))) return null
  return Object.freeze({ sourceSlice: Object.freeze(sourceSlice), queries: Object.freeze(queries) })
}

export function nestedScoutTaskScopeFromContext(value: unknown): NestedScoutTaskScope | null {
  return nestedScoutTaskScopeStateFromContext(value) ?? null
}

export function createNestedScoutTools(options: NestedToolOptions): readonly RuntimeToolDefinition[] {
  const lease = options.lease
  const delegate: RuntimeToolDefinition = {
    schemaVersion, name: "scout.delegate", version: "1",
    description: "Create a bounded read-only Scout child inside the current discovery scope.",
    capabilities: ["coordination"], inputSchema: DelegateInput, outputSchema: DelegateOutput,
    risk: "internal_write", domain: "coordination", idempotency: "requires_key", timeoutMs: 30_000, requiredCapabilities: ["read"],
    execute: async (context: ToolExecutionContext, input: unknown) => {
      const callId = assertParentContext(context, lease)
      const row = record(input), goal = row?.goal
      if (!row || Object.keys(row).sort().join(",") !== "goal,sourceSlice" || typeof goal !== "string"
        || !goal.trim() || goal.trim() !== goal || goal.length > MAX_GOAL_LENGTH || /[\u0000-\u001f\u007f]/.test(goal)) throw invalidRequest()
      const parentScope = deriveNestedScoutSourceScope(options.discoveryAttemptSidecar?.(), options.profile, lease.attemptCount)
      const childScope = parentScope && restrictNestedScoutScope(parentScope, row.sourceSlice)
      if (!childScope) throw unavailable("nested_scout_source_scope_unavailable")
      const parentConstraints = validatedParentConstraints(lease.constraints)
      if (!parentConstraints) throw unavailable("nested_scout_constraints_unavailable")
      let manager: Pick<AgentTreeManager, "spawnFromLease"> | undefined
      try { manager = options.subagentManager() } catch { manager = undefined }
      if (!manager || typeof manager.spawnFromLease !== "function") throw unavailable("nested_scout_spawn_unavailable")
      const spec: SubagentTaskSpec = {
        userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, parentTaskId: lease.id,
        role: "scout", taskType: "job_discovery", goal,
        constraints: [...parentConstraints, NESTED_SCOUT_SCOPE_CONSTRAINT],
        successCriteria: ["Return a valid completed structured Scout result."], allowedActions: READ_ACTIONS,
        context: { nestedScoutSourceSlice: childScope.sourceSlice, nestedScoutQueryScope: childScope.queries },
        expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" },
        toolPolicySnapshot: lease.toolPolicySnapshot ?? { version: "policy.v1", rules: [] },
        ...(lease.modelProfileSnapshot === undefined ? {} : { modelProfileSnapshot: lease.modelProfileSnapshot }),
        ...(lease.budgetSnapshot === undefined ? {} : { budgetSnapshot: lease.budgetSnapshot }),
        policy: { maxDepth: 2, maxFanOut: 2 },
      }
      const key = `scout-delegate:${createHash("sha256").update(JSON.stringify([lease.id, lease.attemptCount, callId])).digest("hex")}`
      const result = await manager.spawnFromLease(spec, key, lease, { stepId: context.stepId, toolCallId: callId })
      const child = result.task
      if (result.atomic !== true || !child || child.parentTaskId !== lease.id || child.userId !== lease.userId
        || child.sessionId !== lease.sessionId || child.turnId !== lease.turnId || child.rootTaskId !== lease.rootTaskId
        || child.depth !== 2 || child.role !== "scout" || child.taskType !== "job_discovery") throw unavailable("nested_scout_spawn_unavailable")
      return { taskId: child.id, status: result.duplicate ? "duplicate" : "queued" }
    },
  }
  const results: RuntimeToolDefinition = {
    schemaVersion, name: "scout.results", version: "1",
    description: "Read a bounded projection of this Scout's direct child results.",
    capabilities: ["read"], inputSchema: Type.Object({}, { additionalProperties: false }), outputSchema: ResultOutput,
    risk: "read", domain: "coordination", idempotency: "read_only", timeoutMs: 10_000, requiredCapabilities: ["read"],
    execute: async (context: ToolExecutionContext) => {
      assertParentContext(context, lease)
      const rows = await readDirectScoutChildren(options.pool, lease)
      if (!rows) return { availability: "unavailable", children: [] }
      if (rows.length === 0) return { availability: "available", children: [] }
      if (rows.some(row => row.role !== "scout" || row.taskType !== "job_discovery")) return { availability: "unavailable", children: [] }
      const childScopes = new Map(rows.map(row => [row.taskId, nestedScoutTaskScopeFromContext(row.context)]))
      if ([...childScopes.values()].some(scope => !scope)) return { availability: "unavailable", children: [] }
      if (rows.some(row => !ACTIVE_CHILD_STATUSES.has(row.status) && !TERMINAL_CHILD_STATUSES.has(row.status))) return { availability: "unavailable", children: [] }
      if (rows.some(row => ACTIVE_CHILD_STATUSES.has(row.status))) return { availability: "pending", children: rows.map(row => ({ taskId: row.taskId, status: safeStatus(row.status), candidates: [] })) }
      const completed = rows.filter(row => row.status === "completed")
      const projection = completed.length ? projectNestedScoutResults(completed.map(waitTask), completed.map(row => row.taskId)) : { availability: "available" as const, children: [] }
      if (projection.availability !== "available" || projection.children.some(child => child.candidates.some(candidate =>
        !childScopes.get(child.taskId)?.queries.some(query => query.source === candidate.source)))) {
        return { availability: "unavailable", children: [] }
      }
      const completedById = new Map(projection.children.map(child => [child.taskId, child.candidates]))
      return { availability: "available", children: rows.map(row => ({ taskId: row.taskId, status: safeStatus(row.status),
        candidates: completedById.get(row.taskId) ?? [] })) }
    },
  }
  return Object.freeze([delegate, results])
}

export function assertParentContext(context: ToolExecutionContext, lease: ParentFence): string {
  const callId = context.toolCallId
  if (context.signal.aborted || context.actorRole !== "subagent" || context.scope.userId !== lease.userId
    || context.sessionId !== lease.sessionId || context.turnId !== lease.turnId || context.taskId !== lease.id
    || context.rootTaskId !== lease.rootTaskId || !safeText(context.stepId, 256) || !safeText(callId, 256)
    || lease.status !== "running" || lease.interruptRequestedAt !== null
    || !(lease.leaseExpiresAt instanceof Date) || lease.leaseExpiresAt.getTime() <= Date.now()
    || lease.leaseOwner !== lease.ownerId || !Number.isSafeInteger(lease.attemptCount) || lease.attemptCount < 1) throw unavailable("nested_scout_context_unavailable")
  return callId!
}

export type NestedScoutChildRow = Readonly<{ taskId: string; status: string; role: string; taskType: string; context: unknown; result: unknown; failureReason: string | null }>
type QueryClient = Pick<pg.PoolClient, "query" | "release">
export async function readDirectScoutChildren(pool: Pick<pg.Pool, "connect">, lease: SubagentLease): Promise<NestedScoutChildRow[] | null> {
  let client: QueryClient | undefined, begun = false
  try {
    client = await pool.connect() as QueryClient
    await client.query("BEGIN"); begun = true
    await client.query("SELECT set_config('app.user_id', $1, true)", [lease.userId])
    const owner = (await client.query(`SELECT task."id" FROM "sub_agent_tasks" task JOIN "agent_sessions" session ON session."id" = task."sessionId"
      JOIN "agent_turns" turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
      WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
        AND session."userId" = $5 AND session."status" NOT IN ('aborted', 'archived') AND turn."rootTaskId" = $4
        AND task."status" = 'running' AND task."leaseOwner" = $6 AND task."attemptCount" = $7
        AND task."interruptRequestedAt" IS NULL AND task."leaseExpiresAt" > clock_timestamp()`,
    [lease.id, lease.sessionId, lease.turnId, lease.rootTaskId, lease.userId, lease.ownerId, lease.attemptCount])).rows
    if (owner.length !== 1) throw new Error("nested_scout_owner_unavailable")
    const rows = (await client.query(`SELECT child."id" AS "taskId", child."status", child."role", child."taskType", child."context",
        CASE WHEN octet_length(child."result"::text) <= $7 THEN child."result" ELSE '{"$truncated":true}'::jsonb END AS "result",
        child."failureReason"
      FROM "sub_agent_tasks" child JOIN "agent_sessions" session ON session."id" = child."sessionId"
      WHERE child."sessionId" = $1 AND child."turnId" = $2 AND child."rootTaskId" = $3 AND child."parentTaskId" = $4
        AND child."depth" = 2 AND session."userId" = $5 AND session."status" NOT IN ('aborted', 'archived')
      ORDER BY child."createdAt", child."id" LIMIT $6`,
    [lease.sessionId, lease.turnId, lease.rootTaskId, lease.id, lease.userId, MAX_ROWS, MAX_STORED_RESULT_BYTES])).rows
    await client.query("COMMIT"); begun = false
    return rows.length <= MAX_CHILDREN ? rows.map(row => ({
      taskId: String(row.taskId), status: String(row.status), role: String(row.role), taskType: String(row.taskType),
      context: row.context, result: row.result, failureReason: typeof row.failureReason === "string" ? row.failureReason : null,
    })) : null
  } catch { return null }
  finally {
    if (begun) await client?.query("ROLLBACK").catch(() => undefined)
    client?.release()
  }
}

function waitTask(row: NestedScoutChildRow) { return { taskId: row.taskId, status: row.status, role: row.role, result: row.result, failureReason: row.failureReason } }
function unavailable(code: string): ToolExecutionError { return new ToolExecutionError(code, "Nested Scout access is unavailable") }
function invalidRequest(): ToolExecutionError { return new ToolExecutionError("nested_scout_request_invalid", "Nested Scout request is invalid") }
function validatedParentConstraints(value: unknown): readonly string[] | null {
  const items = denseArray(value, 0, MAX_PARENT_CONSTRAINTS)
  if (!items || items.some(item => !safeText(item, MAX_CONSTRAINT_LENGTH) || /[\u0000-\u001f\u007f]/.test(item))) return null
  return Object.freeze(items as string[])
}
function isSource(value: unknown): value is string { return typeof value === "string" && NESTED_SCOUT_ALLOWED_SOURCES.includes(value as typeof NESTED_SCOUT_ALLOWED_SOURCES[number]) }
function safeText(value: unknown, maximum: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.trim() === value && value.length <= maximum }
function safeStatus(value: string): string { return ["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"].includes(value) ? value : "unknown" }
