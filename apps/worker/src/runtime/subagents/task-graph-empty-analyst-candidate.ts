import { createHash } from "node:crypto"
import type { PoolClient } from "pg"
import type { TaskExecutionOwnerFence } from "../execution-owner.js"
import type { TurnEngineResult } from "../turns/turn-engine-types.js"
import { validateRoleResult } from "./role-results.js"
import type { PgSubagentPool, SubagentLease } from "./types.js"
import { transaction } from "./pg-store-persistence.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { prepareGraphTransition } from "./task-graph-pg-lifecycle.js"
import { verifyCompletedScoutDependencies } from "./task-graph-pg-completed-dependency-verification.js"
import { verifyTaskGraphNodeEvidence } from "./task-graph-pg-verification.js"
import { TASK_GRAPH_EMPTY_ANALYST_VERIFIER_VERSION } from "./task-graph-verification-report.js"
import { taskGraphVerificationDependencyNodeKeys } from "../planning/task-graph-verification.js"
import { canonicalTaskGraphJson } from "./task-graph-snapshot.js"

declare const emptyAnalystCandidateHandoffBrand: unique symbol
export type EmptyAnalystCandidateHandoff = Readonly<{ [emptyAnalystCandidateHandoffBrand]: true }>
export type EmptyAnalystCandidateAuthorizer = (input: Readonly<{
  identity: TaskExecutionOwnerFence
  candidateText: string
}>) => Promise<EmptyAnalystCandidateHandoff | null>
export type EmptyAnalystCandidateLeaseAuthorizer = (input: Readonly<{
  lease: SubagentLease
  identity: TaskExecutionOwnerFence
  candidateText: string
}>) => Promise<EmptyAnalystCandidateHandoff | null>
export type CandidateStepFinalizer = () => Promise<void | number | undefined>

const MAX_CANDIDATE_BYTES = 8 * 1024
const handoffs = new WeakMap<object, string>()

/** Server-only precheck. The atomic task finish repeats the full proof before writing status. */
export async function authorizeEmptyAnalystCandidate(input: Readonly<{
  pool: PgSubagentPool
  lease: SubagentLease
  identity: TaskExecutionOwnerFence
  candidateText: string
}>): Promise<EmptyAnalystCandidateHandoff | null> {
  const parsed = parseEmptyAnalystCandidate(input.candidateText)
  if (!parsed || !leaseMatchesIdentity(input.lease, input.identity)) return null
  try {
    const allowed = await transaction(input.pool, client => precheck(client, input.lease, parsed))
    return allowed ? mintHandoff(input.candidateText, input.identity) : null
  } catch {
    return null
  }
}

export function createEmptyAnalystCandidateAuthorizer(pool: PgSubagentPool): EmptyAnalystCandidateLeaseAuthorizer {
  return input => authorizeEmptyAnalystCandidate({ ...input, pool })
}

/** Accepts each precheck-issued token once, bound to the exact result and child lease. */
function consumeEmptyAnalystCandidateHandoff(
  value: unknown, candidateText: string, identity: TaskExecutionOwnerFence,
): value is EmptyAnalystCandidateHandoff {
  if (!value || typeof value !== "object") return false
  if (handoffs.get(value) !== handoffBinding(candidateText, identity)) return false
  handoffs.delete(value)
  return true
}

/** Ends only the child execution candidate; durable TaskGraph status is decided later by store.finish(). */
export async function completeEmptyAnalystCandidateOnly(input: Readonly<{
  identity: TaskExecutionOwnerFence | Readonly<{ kind: "turn" }>
  candidateText: string
  authorize?: EmptyAnalystCandidateAuthorizer
  stepCount: number
  toolCallCount: number
  finishStep: CandidateStepFinalizer
}>): Promise<TurnEngineResult | null> {
  if (input.identity.kind !== "task" || !input.authorize) return null
  const handoff = await input.authorize({ identity: input.identity, candidateText: input.candidateText })
  if (!consumeEmptyAnalystCandidateHandoff(handoff, input.candidateText, input.identity)) return null
  await input.finishStep()
  return { status: "completed", stepCount: input.stepCount, toolCallCount: input.toolCallCount, finalText: input.candidateText }
}

function mintHandoff(candidateText: string, identity: TaskExecutionOwnerFence): EmptyAnalystCandidateHandoff {
  const token = Object.freeze({}) as EmptyAnalystCandidateHandoff
  handoffs.set(token, handoffBinding(candidateText, identity))
  return token
}

function handoffBinding(candidateText: string, identity: TaskExecutionOwnerFence): string {
  return JSON.stringify([sha256(candidateText), identity.userId, identity.sessionId, identity.turnId,
    identity.rootTaskId, identity.taskId, identity.ownerId, identity.attemptCount])
}

function parseEmptyAnalystCandidate(candidateText: string): unknown | null {
  if (Buffer.byteLength(candidateText, "utf8") > MAX_CANDIDATE_BYTES) return null
  try {
    const value = JSON.parse(candidateText) as unknown
    const result = validateRoleResult(value, "analyst")
    return result.status === "completed" && result.findings.length === 0 && result.evidence.length === 0 ? result : null
  } catch {
    return null
  }
}

function leaseMatchesIdentity(lease: SubagentLease, identity: TaskExecutionOwnerFence): boolean {
  return identity.kind === "task" && lease.turnId !== null && lease.status === "running"
    && lease.role === "analyst" && lease.taskType === TASK_GRAPH_TEMPLATES.analyst.taskType
    && lease.id === identity.taskId && lease.userId === identity.userId && lease.sessionId === identity.sessionId
    && lease.turnId === identity.turnId && lease.rootTaskId === identity.rootTaskId
    && lease.ownerId === identity.ownerId && lease.leaseOwner === identity.ownerId
    && lease.attemptCount === identity.attemptCount && lease.interruptRequestedAt === null
}

async function precheck(client: PoolClient, lease: SubagentLease, structuredResult: unknown): Promise<boolean> {
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [lease.userId])
  const session = await client.query(`SELECT "id" FROM "agent_sessions"
    WHERE "id" = $1 AND "userId" = $2 AND "status" NOT IN ('aborted', 'archived') FOR UPDATE`,
  [lease.sessionId, lease.userId])
  if (!session.rows[0]) return false

  const turn = await client.query(`SELECT "id" FROM "agent_turns"
    WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "rootTaskId" = $4
      AND "status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled') FOR UPDATE`,
  [lease.turnId, lease.sessionId, lease.userId, lease.rootTaskId])
  if (!turn.rows[0]) return false
  const root = await client.query(`SELECT "id" FROM "sub_agent_tasks"
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $1
      AND "parentTaskId" IS NULL AND "status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed') FOR UPDATE`,
  [lease.rootTaskId, lease.sessionId, lease.turnId])
  if (!root.rows[0]) return false

  const graph = await prepareGraphTransition(client, {
    taskId: lease.id, sessionId: lease.sessionId, type: "task.completed", attemptCount: lease.attemptCount,
  })
  if (!graph || "blocked" in graph) return false
  if (graph.scope.userId !== lease.userId || graph.scope.sessionId !== lease.sessionId
    || graph.scope.turnId !== lease.turnId || graph.scope.rootTaskId !== lease.rootTaskId
    || graph.scope.parentTaskId !== lease.rootTaskId) return false

  const live = await client.query(`SELECT task."id", task."turnId", task."rootTaskId", task."parentTaskId", task."role",
      task."taskType", task."status", task."leaseOwner", task."attemptCount", task."interruptRequestedAt",
      task."leaseExpiresAt", task."absoluteDeadlineAt", task."expectedOutputSchema", task."allowedActions"
    FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $4
      AND session."userId" = $5 AND turn."userId" = $5 AND turn."rootTaskId" = $4
      AND task."role" = 'analyst' AND task."taskType" = $6 AND task."status" = 'running'
      AND task."leaseOwner" = $7 AND task."attemptCount" = $8 AND task."interruptRequestedAt" IS NULL
      AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
      AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled')
    FOR UPDATE OF task`,
  [lease.id, lease.sessionId, lease.turnId, lease.rootTaskId, lease.userId, TASK_GRAPH_TEMPLATES.analyst.taskType,
    lease.ownerId, lease.attemptCount])
  const row = live.rows[0] as Record<string, unknown> | undefined
  if (!row || row.id !== lease.id || row.turnId !== lease.turnId || row.rootTaskId !== lease.rootTaskId
    || row.parentTaskId !== lease.rootTaskId || row.role !== "analyst" || row.taskType !== TASK_GRAPH_TEMPLATES.analyst.taskType
    || row.status !== "running" || row.leaseOwner !== lease.ownerId || Number(row.attemptCount) !== lease.attemptCount
    || row.interruptRequestedAt !== null
    || !sameJson(row.expectedOutputSchema, TASK_GRAPH_TEMPLATES.analyst.expectedOutputSchema)
    || !sameJson(row.allowedActions, TASK_GRAPH_TEMPLATES.analyst.allowedActions)) return false
  const checkedAt = await client.query<{ checkedAt: Date }>(`SELECT clock_timestamp() AS "checkedAt"`)
  const now = checkedAt.rows[0]?.checkedAt
  if (!(now instanceof Date) || !validAfter(row.leaseExpiresAt, now)
    || row.absoluteDeadlineAt !== null && row.absoluteDeadlineAt !== undefined && !validAfter(row.absoluteDeadlineAt, now)) return false
  const node = graph.snapshot.nodes.find(candidate => candidate.taskId === lease.id)
  const contract = node?.verification
  if (!node || node.templateId !== "analyst" || node.verificationDisposition !== "typed"
    || contract?.role !== "analyst" || !contract.criteria.some(item => item.check.kind === "findings_cover_each_scout_candidates_gte")) return false
  const dependencyKeys = taskGraphVerificationDependencyNodeKeys(contract)
  if (dependencyKeys.length < 2 || dependencyKeys.length > 8 || dependencyKeys.some(key => !node.dependsOn.includes(key))) return false

  const dependencies = await verifyCompletedScoutDependencies(client, graph.scope, graph.snapshot, node)
  if (!dependencies || dependencies.projections.size !== dependencyKeys.length || dependencies.bindings.length !== dependencyKeys.length) return false
  const result = await verifyTaskGraphNodeEvidence(client, {
    scope: { ...graph.scope, taskId: lease.id, attemptCount: lease.attemptCount },
    snapshot: graph.snapshot, node, structuredResult, dependencies: dependencies.projections,
    dependencyBindings: dependencies.bindings, graphRevision: graph.expectedRevision,
  })
  return result.report.verifierVersion === TASK_GRAPH_EMPTY_ANALYST_VERIFIER_VERSION
    && result.report.status === "failed" && result.report.reasonCode === "criterion_not_met"
    && result.evaluation.status === "failed" && result.persistDependencyBindings === true
    && /^[a-f0-9]{64}$/.test(result.report.evidenceDigest ?? "")
    && /^[a-f0-9]{64}$/.test(result.report.resultDigest ?? "")
    && result.report.criteria.length === contract.criteria.length
    && result.report.criteria.every(item => item.status === "passed" || item.status === "failed")
    && result.report.criteria.some(item => item.status === "failed")
}

function sameJson(left: unknown, right: unknown): boolean {
  try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false }
}

function validAfter(value: unknown, now: Date): boolean {
  const time = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(time) && time > now.getTime()
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex") }
