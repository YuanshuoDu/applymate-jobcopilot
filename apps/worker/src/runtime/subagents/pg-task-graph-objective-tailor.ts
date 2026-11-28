import type pg from "pg"
import { resolveRootTaskVerificationRequirements } from "../context/root-task-objective.js"
import { readCurrentScheduledDraftJobMaterialDigest } from "./scheduled-draft-job-material.js"
import { assertPlanningRootHasNoUnresolvedSteering } from "./pg-store-create.js"
import { createGraphTasks } from "./task-graph-pg-create.js"
import { requireTaskGraphContinuationBudget, hasPersistedPlanReceipt } from "./pg-task-graph-command-port-schedule.js"
import { writePlanReceipt } from "./task-graph-pg-events.js"
import { lockTaskGraphScope, loadTaskGraph, type GraphParent, type LoadedGraph } from "./task-graph-pg-state.js"
import { isExactObjectiveTaskGraphIntent, objectiveTailorNodeKeysForCandidate, objectiveTailorPlan } from "./objective-task-graph-child-authority.js"
import { buildObjectiveTailorCandidateCatalog, resolveObjectiveTailorCandidate, type ObjectiveTailorCandidateCatalog } from "./objective-tailor-candidate.js"
import { bindObjectiveTailorCandidateWitness } from "./objective-tailor-witness.js"
import { TaskGraphCommandError, type TaskGraphExecutionScope, type TaskGraphReadScope, type TaskGraphScheduleReceipt } from "./task-graph-command-port.js"
import { requireOwnedRootPlanCriteria } from "./root-plan-criteria.js"
import { taskGraphFingerprint, taskGraphItemId, taskGraphProposalKey, parseTaskGraphSnapshot } from "./task-graph-snapshot.js"
import { transaction, type Queryable } from "./pg-store-persistence.js"
import { parsePersistedTaskGraphReceipt } from "./task-graph-pg-event-validation.js"

type Row = Record<string, unknown>
type TailorInput = Readonly<{ scope: TaskGraphExecutionScope; expectedRevision: number; candidateRef: string }>
const CANDIDATE_REF = /^otc1_[a-f0-9]{64}$/
const MAX_REVISION = 2_147_483_646

export function readObjectiveTailorCatalog(pool: Pick<pg.Pool, "connect">, scope: TaskGraphReadScope): Promise<ObjectiveTailorCandidateCatalog | undefined> {
  return transaction(pool, client => readObjectiveTailorCatalogWithClient(client, scope))
}

export function appendObjectiveTailor(pool: Pick<pg.Pool, "connect">, input: TailorInput): Promise<TaskGraphScheduleReceipt> {
  return transaction(pool, client => appendObjectiveTailorWithClient(client, input))
}

export async function readObjectiveTailorCatalogWithClient(
  client: Queryable, scope: TaskGraphReadScope,
): Promise<ObjectiveTailorCandidateCatalog | undefined> {
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [scope.userId])
  const parent = await lockTaskGraphScope(client, scope, true)
  const requirements = rootRow(parent, scope) && hasTailorAction(parent.allowedActions)
    ? await readObjectiveRequirements(client, scope) : undefined
  if (!requirements || requirements.status === "invalid") return undefined
  await assertPlanningRootHasNoUnresolvedSteering(client, parent.allowedActions, scope)
  const loaded = await loadTaskGraph(client, scope, true)
  if (!loaded.item || loaded.discoveryTurnEligibility !== "ordinary") return undefined
  return buildObjectiveTailorCandidateCatalog(client, scope, loaded)
}

export async function appendObjectiveTailorWithClient(client: Queryable, input: TailorInput): Promise<TaskGraphScheduleReceipt> {
  if (!validInput(input)) throw new TaskGraphCommandError("objective_tailor_input_invalid", "The candidate selection is invalid")
  const { scope, expectedRevision, candidateRef } = input
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [scope.userId])
  const parent = await lockTaskGraphScope(client, scope, true)
  if (!rootRow(parent, scope) || !hasTailorAction(parent.allowedActions)) throw denied()
  const requirements = await readObjectiveRequirements(client, scope, scope.stepId)
  if (!requirements || requirements.status === "invalid") throw denied()
  const loaded = await loadTaskGraph(client, scope, true)
  if (!loaded.item || !loaded.snapshot || !loaded.state || loaded.discoveryTurnEligibility !== "ordinary") {
    if (await hasPersistedPlanReceipt(client, scope)) throw new TaskGraphCommandError("task_graph_state_missing", "Persisted TaskGraph state is unavailable")
    throw stale()
  }
  const fingerprint = requestFingerprint(scope, expectedRevision, candidateRef)
  const key = taskGraphProposalKey(scope.parentTaskId, expectedRevision)
  const replay = await findExactReplay(client, input, loaded, key, fingerprint)
  if (replay) return replay
  await assertPlanningRootHasNoUnresolvedSteering(client, parent.allowedActions, scope)
  if (loaded.state.revision !== expectedRevision) throw new TaskGraphCommandError("revision_mismatch", "TaskGraph revision is stale", loaded.state.revision)
  if (expectedRevision >= MAX_REVISION) throw new TaskGraphCommandError("revision_limit", "TaskGraph revision limit reached", expectedRevision)
  const withProvenance = await loadTaskGraph(client, scope, true, { includeSourceProvenance: true, currentStepId: scope.stepId, currentStepAttempt: 1 })
  if (!withProvenance.state || !withProvenance.snapshot || withProvenance.state.revision !== expectedRevision) throw stale()
  const selection = await resolveObjectiveTailorCandidate(client, scope, withProvenance, expectedRevision, candidateRef)
  if (!selection || selection.sourceGraphRevision !== expectedRevision) throw stale()
  const job = await client.query(`SELECT "id" FROM "Job" WHERE "id" = $1 AND "userId" = $2 FOR SHARE`, [selection.candidate.jobId, scope.userId])
  if (job.rows.length !== 1 || await readCurrentScheduledDraftJobMaterialDigest(client, scope.userId, selection.candidate.jobId) !== selection.candidate.materialDigest) {
    throw new TaskGraphCommandError("objective_tailor_source_material_stale", "The candidate source material changed")
  }
  const nodeKeys = objectiveTailorNodeKeysForCandidate(candidateRef)
  if (!nodeKeys) throw stale()
  const witness = bindObjectiveTailorCandidateWitness(selection, { ...nodeKeys, admittedRevision: expectedRevision + 1 })
  const plan = witness && objectiveTailorPlan(witness)
  if (!plan) throw stale()
  const pinnedCriteria = withProvenance.snapshot.rootSuccessCriteria === undefined ? undefined
    : await requireOwnedRootPlanCriteria(client, scope, parent, withProvenance.snapshot.rootSuccessCriteria, undefined)
  await requireTaskGraphContinuationBudget(client, scope)
  const scheduleInput = { scope, proposal: plan.proposal, templates: plan.templates, verificationRequirements: requirements }
  const created = await createGraphTasks(client, scheduleInput, parent, withProvenance.state,
    new Map(withProvenance.snapshot.nodes.map(node => [node.key, node.taskId])), withProvenance, undefined, true, undefined, true)
  const snapshot = pinnedCriteria ? parseTaskGraphSnapshot({ ...created.snapshot, rootSuccessCriteria: pinnedCriteria }) : created.snapshot
  const receipt: TaskGraphScheduleReceipt = { status: "accepted", revision: created.state.revision, nodes: created.created, readyTaskIds: created.readyTaskIds }
  await writePlanReceipt(client, { scope, state: created.state, snapshot, expectedRevision, now: new Date(), idempotencyKey: key, fingerprint, receipt })
  return receipt
}

async function readObjectiveRequirements(client: Queryable, scope: TaskGraphReadScope, stepId?: string) {
  const stepJoin = stepId ? `JOIN "agent_steps" AS step ON step."id" = $7 AND step."sessionId" = turn."sessionId" AND step."turnId" = turn."id"
      AND step."taskId" = $4 AND step."status" = 'streaming'` : ""
  const latestStep = stepId ? `AND NOT EXISTS (SELECT 1 FROM "agent_steps" AS newer WHERE newer."sessionId" = step."sessionId"
        AND newer."turnId" = step."turnId" AND newer."taskId" = step."taskId" AND newer."ordinal" > step."ordinal")` : ""
  const values: unknown[] = stepId
    ? [scope.turnId, scope.sessionId, scope.userId, scope.rootTaskId, scope.turnLeaseOwner, scope.turnLeaseVersion, stepId]
    : [scope.turnId, scope.sessionId, scope.userId, scope.rootTaskId, scope.turnLeaseOwner, scope.turnLeaseVersion]
  const result = await client.query(`SELECT turn."input", turn."source", turn."executionMode" FROM "agent_turns" AS turn
    JOIN "agent_sessions" AS session ON session."id" = turn."sessionId" AND session."userId" = turn."userId"
    ${stepJoin}
    WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND turn."rootTaskId" = $4
      AND turn."status" = 'in_progress' AND turn."source" = 'user' AND turn."executionMode" = 'canonical_task_graph'
      AND turn."leaseOwnerId" = $5 AND turn."leaseVersion" = $6 AND turn."leaseExpiresAt" > clock_timestamp()
      ${latestStep}`, values)
  const row = result.rows[0] as Row | undefined
  if (result.rows.length !== 1 || row?.source !== "user" || row.executionMode !== "canonical_task_graph" || !isExactObjectiveTaskGraphIntent(row.input)) return undefined
  return resolveRootTaskVerificationRequirements(row.input)
}

function rootRow(parent: GraphParent, scope: TaskGraphReadScope): boolean {
  return parent.id === scope.rootTaskId && parent.sessionId === scope.sessionId && parent.turnId === scope.turnId
    && parent.rootTaskId === scope.rootTaskId && parent.parentTaskId === null && parent.role === "orchestrator" && parent.taskType === "root"
    && parent.status === "running" && parent.leaseOwner === scope.parentLeaseOwner && Number(parent.attemptCount) === scope.parentAttemptCount
    && parent.interruptRequestedAt === null
}

function hasTailorAction(value: unknown): boolean { return Array.isArray(value) && value.includes("agent.tailor") }

async function findExactReplay(client: Queryable, input: TailorInput, loaded: LoadedGraph, key: string, fingerprint: string): Promise<TaskGraphScheduleReceipt | null> {
  const { scope, expectedRevision, candidateRef } = input
  const result = await client.query(`SELECT event."type", event."itemId", event."taskId", event."actor", event."correlationId", event."causationId",
      event."idempotencyKey", event."sequence", event."payload" FROM "agent_events" AS event
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $3 AND event."taskId" = $4
      AND event."idempotencyKey" = $5 AND session."userId" = $6 AND turn."userId" = $6`,
  [scope.sessionId, scope.turnId, taskGraphItemId(scope.rootTaskId), scope.rootTaskId, key, scope.userId])
  if (!result.rows.length) return null
  if (result.rows.length !== 1 || !loaded.item || !loaded.snapshot) throw conflict()
  const row = result.rows[0] as Row, payload = exactRecord(row.payload, "content,fingerprint,item,kind,receipt,revision")
  const item = payload && exactRecord(payload.item, "completedAt,content,createdAt,id,phase,revision,schemaVersion,sessionId,startedAt,status,stepId,taskId,turnId,type,updatedAt")
  if (!payload || payload.kind !== "proposal" || payload.fingerprint !== fingerprint || row.actor !== "orchestrator" || row.correlationId !== scope.turnId
    || !Number.isSafeInteger(Number(row.sequence)) || row.type !== "item.delta") throw conflict()
  if (!item || item.status !== "streaming" || item.phase !== null || item.completedAt !== null || item.stepId !== row.causationId) throw conflict()
  try {
    parsePersistedTaskGraphReceipt(row.type, payload, { id: loaded.item.id, revision: loaded.item.revision }, loaded.snapshot, scope,
      { itemId: row.itemId, taskId: row.taskId, idempotencyKey: row.idempotencyKey, type: row.type })
  } catch { throw conflict() }
  const receipt = exactRecord(payload.receipt, "nodes,readyTaskIds,revision,status"), keys = objectiveTailorNodeKeysForCandidate(candidateRef)
  if (!keys) throw conflict()
  const writerKey = keys.writerNodeKey, reviewerKey = keys.reviewerNodeKey
  if (!receipt || payload.revision !== expectedRevision + 1 || receipt.revision !== expectedRevision + 1 || receipt.status !== "accepted"
    || !Array.isArray(receipt.nodes) || receipt.nodes.length !== 2 || !Array.isArray(receipt.readyTaskIds) || receipt.readyTaskIds.length !== 1
    || !matchesReceiptNode(receipt.nodes[0], writerKey, "queued") || !matchesReceiptNode(receipt.nodes[1], reviewerKey, "waiting")
    || receipt.readyTaskIds[0] !== record(receipt.nodes[0])?.taskId) throw conflict()
  return { status: "duplicate", revision: expectedRevision + 1,
    nodes: receipt.nodes as TaskGraphScheduleReceipt["nodes"], readyTaskIds: receipt.readyTaskIds as string[] }
}

function matchesReceiptNode(value: unknown, key: string, status: string): boolean {
  const row = exactRecord(value, "key,status,taskId")
  return Boolean(row && row.key === key && typeof row.taskId === "string" && row.taskId.trim() === row.taskId
    && row.taskId.length > 0 && row.status === status)
}
function requestFingerprint(scope: TaskGraphExecutionScope, expectedRevision: number, candidateRef: string): string {
  return taskGraphFingerprint({ kind: "objective_tailor_candidate", scope: {
    userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId,
  }, expectedRevision, candidateRef })
}
function validInput(input: TailorInput): boolean {
  return Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0 && CANDIDATE_REF.test(input.candidateRef)
}
function record(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try {
    const row = parsed as Row, keys = Reflect.ownKeys(row)
    return (Object.getPrototypeOf(row) === Object.prototype || Object.getPrototypeOf(row) === null)
      && keys.every(key => typeof key === "string" && Boolean(Object.getOwnPropertyDescriptor(row, key)?.enumerable)
        && "value" in Object.getOwnPropertyDescriptor(row, key)!) ? row : null
  } catch { return null }
}
function exactRecord(value: unknown, keys: string): Row | null {
  const row = record(value), expected = keys.split(",")
  return row && Reflect.ownKeys(row).length === expected.length && Reflect.ownKeys(row).every(key => typeof key === "string" && expected.includes(key)) ? row : null
}
function denied(): TaskGraphCommandError { return new TaskGraphCommandError("objective_tailor_not_eligible", "This Objective cannot add the candidate") }
function stale(): TaskGraphCommandError { return new TaskGraphCommandError("objective_tailor_candidate_stale", "The candidate proof is stale or unavailable") }
function conflict(): TaskGraphCommandError { return new TaskGraphCommandError("idempotency_conflict", "The TaskGraph proposal key was already used") }
