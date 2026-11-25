import type pg from "pg"
import type { TurnLease } from "../turns/lease.js"
import { resolveRootTaskVerificationRequirements } from "../context/root-task-objective.js"
import { readCurrentScheduledDraftJobMaterialDigest } from "./scheduled-draft-job-material.js"
import { assertPlanningRootHasNoUnresolvedSteering } from "./pg-store-create.js"
import { createGraphTasks } from "./task-graph-pg-create.js"
import { requireTaskGraphContinuationBudget, hasPersistedPlanReceipt } from "./pg-task-graph-command-port-schedule.js"
import { writePlanReceipt } from "./task-graph-pg-events.js"
import { lockTaskGraphScope, loadTaskGraph, type GraphParent, type LoadedGraph } from "./task-graph-pg-state.js"
import { isExactObjectiveTaskGraphIntent } from "./objective-task-graph-child-authority.js"
import { readObjectiveTailorWaveInventory } from "./objective-tailor-wave-inventory.js"
import { objectiveTailorCorrectionNodeKeys, parseObjectiveTailorCorrectionProof,
  verifyAndBindObjectiveTailorCorrectionProof, type ObjectiveTailorCorrectionProof } from "./objective-tailor-correction-proof.js"
import { prepareObjectiveTailorCorrectionPlan } from "./objective-tailor-correction-plan.js"
import { objectiveTailorGraphFloorMatchesTurn } from "./objective-tailor-score-floor-marker.js"
import { objectiveTailorWaveChildExecutionAllowed } from "./task-graph-pg-create-objective-tailor-wave.js"
import { TaskGraphCommandError, type TaskGraphExecutionScope, type TaskGraphScheduleReceipt } from "./task-graph-command-port.js"
import { requireOwnedRootPlanCriteria } from "./root-plan-criteria.js"
import { canonicalTaskGraphJson, taskGraphFingerprint, taskGraphItemId, taskGraphProposalKey } from "./task-graph-snapshot.js"
import { transaction, type Queryable } from "./pg-store-persistence.js"
import { parsePersistedTaskGraphReceipt } from "./task-graph-pg-event-validation.js"

type Row = Record<string, unknown>
type CorrectionInput = Readonly<{ scope: TaskGraphExecutionScope; expectedRevision: number; correctionSlotId: string }>
type TurnRow = Row & Readonly<{ input: unknown; source: unknown; executionMode: unknown }>
const MAX_REVISION = 2_147_483_646

export function appendObjectiveTailorCorrection(pool: Pick<pg.Pool, "connect">, input: CorrectionInput): Promise<TaskGraphScheduleReceipt> {
  return transaction(pool, client => appendCorrectionWithClient(client, input))
}

export async function appendCorrectionWithClient(client: pg.PoolClient, raw: unknown): Promise<TaskGraphScheduleReceipt> {
  const input = validInput(raw)
  if (!input || process.env.ENABLE_AGENT_OBJECTIVE_TAILOR_WAVES !== "1") throw denied()
  const { scope, expectedRevision, correctionSlotId } = input
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [scope.userId])
  const parent = await lockTaskGraphScope(client, scope, true)
  const turn = await readObjectiveTurn(client, scope)
  if (!validRoot(parent, scope) || !turn || !eligibleObjective(parent, turn.input, turn.executionMode)) throw denied()
  const requirements = resolveRootTaskVerificationRequirements(turn.input)
  const lease = turnLease(scope, turn)
  if (requirements.status === "invalid" || !lease) throw denied()
  const loaded = await loadTaskGraph(client, scope, true, { includeSourceProvenance: true,
    currentStepId: scope.stepId, currentStepAttempt: 1 })
  if (!loaded.item || !loaded.snapshot || !loaded.state || loaded.discoveryTurnEligibility !== "ordinary") {
    if (await hasPersistedPlanReceipt(client, scope)) throw new TaskGraphCommandError("task_graph_state_missing", "Persisted TaskGraph state is unavailable")
    throw stale()
  }
  if (!objectiveTailorGraphFloorMatchesTurn(loaded.snapshot.objectiveTailor, loaded.snapshot.nodes, turn.input)
    || !objectiveTailorGraphFloorMatchesTurn(loaded.state.objectiveTailor, loaded.state.nodes, turn.input)
    || canonicalTaskGraphJson(loaded.snapshot.objectiveTailor ?? null) !== canonicalTaskGraphJson(loaded.state.objectiveTailor ?? null)) throw denied()
  const key = taskGraphProposalKey(scope.rootTaskId, expectedRevision), fingerprint = correctionFingerprint(scope, expectedRevision, correctionSlotId)
  const replay = await findExactReplay(client, input, loaded, key, fingerprint)
  if (replay) return replay
  await assertPlanningRootHasNoUnresolvedSteering(client, parent.allowedActions, scope)
  if (loaded.state.revision !== expectedRevision) throw new TaskGraphCommandError("revision_mismatch", "TaskGraph revision is stale", loaded.state.revision)
  if (expectedRevision >= MAX_REVISION) throw new TaskGraphCommandError("revision_limit", "TaskGraph revision limit reached", expectedRevision)
  const proof = await verifyAndBindObjectiveTailorCorrectionProof({ client, lease,
    root: { id: scope.rootTaskId, attemptCount: scope.parentAttemptCount }, loaded, slotId: correctionSlotId, expectedRevision })
  if (!proof || proof.slotId !== correctionSlotId) throw stale()
  const current = loaded.snapshot.rootSuccessCriteria === undefined ? loaded.state
    : { ...loaded.state, rootSuccessCriteria: loaded.snapshot.rootSuccessCriteria }
  const plan = prepareObjectiveTailorCorrectionPlan({ current, proof })
  if (!plan || plan.proof.graphRevision !== expectedRevision || plan.proof.admittedRevision !== expectedRevision + 1) throw stale()
  const jobId = proof.candidateWitness.candidate.jobId
  if (await readCurrentScheduledDraftJobMaterialDigest(client, scope.userId, jobId) !== proof.candidateWitness.candidate.materialDigest) {
    throw new TaskGraphCommandError("objective_tailor_correction_source_stale", "The reviewed Job source material changed")
  }
  if (!await lockReviewedArtifactHead(client, scope, proof)) throw stale()
  const pinned = loaded.snapshot.rootSuccessCriteria === undefined ? undefined
    : await requireOwnedRootPlanCriteria(client, scope, parent, loaded.snapshot.rootSuccessCriteria, undefined)
  await requireTaskGraphContinuationBudget(client, scope)
  const created = await createGraphTasks(client, { scope, proposal: plan.proposal, templates: plan.templates, verificationRequirements: requirements },
    parent, loaded.state, new Map(loaded.snapshot.nodes.map(node => [node.key, node.taskId])), loaded, undefined, true, undefined, false,
    { marker: plan.marker, templatesByNodeKey: plan.templatesByNodeKey })
  if (!createdCorrectionMatches(created, plan, expectedRevision)) throw conflict()
  const snapshot = pinned ? { ...created.snapshot, rootSuccessCriteria: pinned } : created.snapshot
  const receipt: TaskGraphScheduleReceipt = { status: "accepted", revision: created.state.revision,
    nodes: created.created, readyTaskIds: created.readyTaskIds }
  await writePlanReceipt(client, { scope, state: created.state, snapshot, expectedRevision, now: new Date(), idempotencyKey: key, fingerprint, receipt })
  return receipt
}

async function readObjectiveTurn(client: Queryable, scope: TaskGraphExecutionScope): Promise<TurnRow | undefined> {
  const result = await client.query(`SELECT turn."input", turn."source", turn."executionMode", turn."leaseStartedAt", turn."leaseExpiresAt"
    FROM "agent_turns" AS turn JOIN "agent_sessions" AS session ON session."id" = turn."sessionId" AND session."userId" = turn."userId"
    JOIN "agent_steps" AS step ON step."id" = $7 AND step."sessionId" = turn."sessionId" AND step."turnId" = turn."id"
      AND step."taskId" = $4 AND step."status" = 'streaming'
    WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND turn."rootTaskId" = $4
      AND turn."status" = 'in_progress' AND turn."source" = 'user' AND turn."executionMode" = 'canonical_task_graph'
      AND turn."leaseOwnerId" = $5 AND turn."leaseVersion" = $6 AND turn."leaseExpiresAt" > clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM "agent_steps" AS newer WHERE newer."sessionId" = step."sessionId"
        AND newer."turnId" = step."turnId" AND newer."taskId" = step."taskId" AND newer."ordinal" > step."ordinal")`,
  [scope.turnId, scope.sessionId, scope.userId, scope.rootTaskId, scope.turnLeaseOwner, scope.turnLeaseVersion, scope.stepId])
  return result.rows.length === 1 ? result.rows[0] as TurnRow : undefined
}

async function findExactReplay(client: Queryable, input: CorrectionInput, loaded: LoadedGraph, key: string, fingerprint: string): Promise<TaskGraphScheduleReceipt | null> {
  const { scope, expectedRevision, correctionSlotId } = input
  const rows = await client.query(`SELECT event."type", event."itemId", event."taskId", event."actor", event."correlationId", event."causationId",
    event."idempotencyKey", event."sequence", event."payload" FROM "agent_events" AS event
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $3 AND event."taskId" = $4
      AND event."idempotencyKey" = $5 AND session."userId" = $6 AND turn."userId" = $6`,
  [scope.sessionId, scope.turnId, taskGraphItemId(scope.rootTaskId), scope.rootTaskId, key, scope.userId])
  if (!rows.rows.length) return null
  if (rows.rows.length !== 1 || !loaded.item || !loaded.snapshot) throw conflict()
  const row = rows.rows[0] as Row, payload = exact(row.payload, "content,fingerprint,item,kind,receipt,revision")
  const item = payload && exact(payload.item, "completedAt,content,createdAt,id,phase,revision,schemaVersion,sessionId,startedAt,status,stepId,taskId,turnId,type,updatedAt")
  if (!payload || !item || payload.kind !== "proposal" || payload.fingerprint !== fingerprint || row.actor !== "orchestrator"
    || row.correlationId !== scope.turnId || !Number.isSafeInteger(Number(row.sequence)) || row.type !== "item.delta"
    || item.status !== "streaming" || item.phase !== null || item.completedAt !== null || item.stepId !== row.causationId) throw conflict()
  try { parsePersistedTaskGraphReceipt(row.type, payload, { id: loaded.item.id, revision: loaded.item.revision }, loaded.snapshot, scope,
    { itemId: row.itemId, taskId: row.taskId, idempotencyKey: row.idempotencyKey, type: row.type }) } catch { throw conflict() }
  const inventory = await readObjectiveTailorWaveInventory(client, scope, loaded)
  const slot = inventory?.occupiedSlots.find(value => value.slotId === correctionSlotId), correction = slot?.correction
  const proof = parseObjectiveTailorCorrectionProof(correction?.proof), keys = objectiveTailorCorrectionNodeKeys(correctionSlotId)
  const markerSlot = inventory?.marker?.slots.find(value => value.slotId === correctionSlotId)
  if (!inventory || !slot || !correction || !proof || !keys || !markerSlot?.correction
    || proof.graphRevision !== expectedRevision || proof.admittedRevision !== expectedRevision + 1
    || proof.slotId !== correctionSlotId || proof.writerNodeKey !== keys.writerNodeKey || proof.reviewerNodeKey !== keys.reviewerNodeKey
    || slot.writerTaskId !== proof.prior.writerTaskId || slot.reviewerTaskId !== proof.prior.reviewerTaskId
    || correction.writerTaskId === correction.reviewerTaskId || markerSlot.correction.writerNodeKey !== keys.writerNodeKey
    || markerSlot.correction.reviewerNodeKey !== keys.reviewerNodeKey) throw conflict()
  const receipt = exact(payload.receipt, "nodes,readyTaskIds,revision,status"), expectedNodes: TaskGraphScheduleReceipt["nodes"] = [
    { key: keys.writerNodeKey, taskId: correction.writerTaskId, status: "queued" },
    { key: keys.reviewerNodeKey, taskId: correction.reviewerTaskId, status: "waiting" },
  ]
  if (!receipt || payload.revision !== expectedRevision + 1 || receipt.revision !== expectedRevision + 1 || receipt.status !== "accepted"
    || canonicalTaskGraphJson(receipt.nodes) !== canonicalTaskGraphJson(expectedNodes)
    || canonicalTaskGraphJson(receipt.readyTaskIds) !== canonicalTaskGraphJson([correction.writerTaskId])) throw conflict()
  return { status: "duplicate", revision: expectedRevision + 1, nodes: expectedNodes, readyTaskIds: [correction.writerTaskId] }
}

async function lockReviewedArtifactHead(client: Queryable, scope: TaskGraphExecutionScope, proof: ObjectiveTailorCorrectionProof): Promise<boolean> {
  const ref = proof.prior.artifactRef, version = proof.prior.artifactVersion, witness = proof.candidateWitness
  try {
    const result = await client.query(`SELECT artifact."id" AS "artifactId", artifact."userId", artifact."jobId", artifact."artifactType",
      artifact."lifecycle", artifact."version" AS "headVersion", artifact."hash" AS "headHash", version_row."version",
      version_row."contentHash", version_row."sourceDigest", version_row."taskId", version_row."previousHash",
      version_row."sessionId" FROM "agent_artifact" AS artifact
      JOIN "agent_artifact_version" AS version_row ON version_row."artifactId" = artifact."id"
        AND version_row."version" = artifact."version" AND version_row."userId" = artifact."userId"
        AND version_row."jobId" = artifact."jobId" AND version_row."artifactType" = artifact."artifactType"
        AND version_row."contentHash" = artifact."hash"
      WHERE artifact."id" = $1 AND artifact."userId" = $2 AND artifact."jobId" = $3
        AND artifact."artifactType" = 'cover_letter' AND artifact."lifecycle" = 'draft'
        AND version_row."sessionId" = $4 AND version_row."taskId" = $5 AND version_row."contentHash" = $6
        AND version_row."sourceDigest" = $7 AND version_row."previousHash" IS NOT DISTINCT FROM $8
      FOR SHARE OF artifact NOWAIT`, [ref.artifactId, scope.userId, witness.candidate.jobId, scope.sessionId, version.taskId,
      ref.contentHash, ref.sourceDigest, version.previousHash])
    const row = result.rows[0] as Row | undefined
    return result.rows.length === 1 && row?.artifactId === ref.artifactId && row.userId === scope.userId
      && row.jobId === witness.candidate.jobId && row.sessionId === scope.sessionId
      && row.artifactType === "cover_letter" && row.lifecycle === "draft" && Number(row.headVersion) === ref.version
      && Number(row.version) === version.version && row.headHash === ref.contentHash && row.contentHash === ref.contentHash
      && row.sourceDigest === ref.sourceDigest && row.taskId === version.taskId && row.previousHash === version.previousHash
  } catch { return false }
}

function createdCorrectionMatches(created: Awaited<ReturnType<typeof createGraphTasks>>,
  plan: NonNullable<ReturnType<typeof prepareObjectiveTailorCorrectionPlan>>, revision: number): boolean {
  const slot = plan.marker.slots.find(value => value.slotId === plan.proof.slotId), keys = objectiveTailorCorrectionNodeKeys(plan.proof.slotId)
  const [writer, reviewer] = created.created
  return !!slot?.correction && !!keys && created.state.revision === revision + 1 && created.created.length === 2
    && created.readyTaskIds.length === 1 && writer?.key === keys.writerNodeKey && writer.status === "queued" && !!writer.taskId
    && reviewer?.key === keys.reviewerNodeKey && reviewer.status === "waiting" && !!reviewer.taskId && writer.taskId !== reviewer.taskId
    && slot.correction.writerNodeKey === writer.key && slot.correction.reviewerNodeKey === reviewer.key
    && created.readyTaskIds[0] === writer.taskId && created.taskIds.get(writer.key) === writer.taskId
    && created.taskIds.get(reviewer.key) === reviewer.taskId
    && created.state.nodes.find(node => node.key === writer.key)?.status === "queued"
    && created.state.nodes.find(node => node.key === reviewer.key)?.status === "waiting"
    && created.snapshot.nodes.find(node => node.key === writer.key)?.taskId === writer.taskId
    && created.snapshot.nodes.find(node => node.key === reviewer.key)?.taskId === reviewer.taskId
    && canonicalTaskGraphJson(created.state.objectiveTailor) === canonicalTaskGraphJson(plan.marker)
    && canonicalTaskGraphJson(created.snapshot.objectiveTailor) === canonicalTaskGraphJson(plan.marker)
}

function eligibleObjective(parent: GraphParent, input: unknown, mode: unknown): boolean {
  return mode === "canonical_task_graph" && isExactObjectiveTaskGraphIntent(input)
    && objectiveTailorWaveChildExecutionAllowed({ turnInput: input, executionMode: mode,
      rootBudgetSnapshot: parent.budgetSnapshot, rootAllowedActions: parent.allowedActions })
}
function validRoot(parent: GraphParent, scope: TaskGraphExecutionScope): boolean {
  return parent.id === scope.rootTaskId && parent.sessionId === scope.sessionId && parent.turnId === scope.turnId
    && parent.rootTaskId === scope.rootTaskId && parent.parentTaskId === null && parent.role === "orchestrator"
    && parent.taskType === "root" && parent.status === "running" && parent.leaseOwner === scope.parentLeaseOwner
    && Number(parent.attemptCount) === scope.parentAttemptCount && parent.interruptRequestedAt === null
}
function turnLease(scope: TaskGraphExecutionScope, turn: TurnRow): TurnLease | undefined {
  const date = (value: unknown) => value instanceof Date ? value : typeof value === "string" ? new Date(value) : undefined
  const leaseStartedAt = date(turn.leaseStartedAt), leaseExpiresAt = date(turn.leaseExpiresAt)
  if (!leaseStartedAt || !Number.isFinite(leaseStartedAt.getTime()) || !leaseExpiresAt || !Number.isFinite(leaseExpiresAt.getTime())) return undefined
  return { turnId: scope.turnId, sessionId: scope.sessionId, ownerId: scope.turnLeaseOwner, userId: scope.userId,
    leaseVersion: scope.turnLeaseVersion, leaseStartedAt, leaseExpiresAt }
}
function validInput(value: unknown): CorrectionInput | undefined {
  const row = exact(value, "correctionSlotId,expectedRevision,scope")
  const scope = row && exact(row.scope, "parentAttemptCount,parentLeaseOwner,parentTaskId,rootTaskId,sessionId,stepId,turnId,turnLeaseOwner,turnLeaseVersion,userId")
  if (!row || !scope || typeof row.correctionSlotId !== "string" || !objectiveTailorCorrectionNodeKeys(row.correctionSlotId)
    || !Number.isSafeInteger(row.expectedRevision) || Number(row.expectedRevision) < 1 || Number(row.expectedRevision) >= MAX_REVISION) return undefined
  return { scope: scope as unknown as TaskGraphExecutionScope, expectedRevision: Number(row.expectedRevision), correctionSlotId: row.correctionSlotId }
}
function correctionFingerprint(scope: TaskGraphExecutionScope, expectedRevision: number, correctionSlotId: string): string {
  return taskGraphFingerprint({ kind: "objective_tailor_same_slot_correction", scope: {
    userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId,
  }, expectedRevision, correctionSlotId })
}
function exact(value: unknown, keys: string): Row | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const row = value as Row, actual = Reflect.ownKeys(row), expected = keys.split(",")
    return (Object.getPrototypeOf(row) === Object.prototype || Object.getPrototypeOf(row) === null)
      && actual.length === expected.length && actual.every(key => typeof key === "string" && expected.includes(key)
        && Object.getOwnPropertyDescriptor(row, key)?.enumerable && "value" in Object.getOwnPropertyDescriptor(row, key)!) ? row : undefined
  } catch { return undefined }
}
function denied(): TaskGraphCommandError { return new TaskGraphCommandError("objective_tailor_wave_not_eligible", "Objective tailoring is unavailable for this Turn") }
function stale(): TaskGraphCommandError { return new TaskGraphCommandError("objective_tailor_correction_stale", "The current reviewed correction evidence is unavailable") }
function conflict(): TaskGraphCommandError { return new TaskGraphCommandError("idempotency_conflict", "The TaskGraph proposal key was already used") }
