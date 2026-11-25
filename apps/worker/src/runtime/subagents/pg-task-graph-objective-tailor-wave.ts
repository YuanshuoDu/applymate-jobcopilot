import type pg from "pg"
import { resolveRootTaskVerificationRequirements } from "../context/root-task-objective.js"
import { readCurrentScheduledDraftJobMaterialDigest } from "./scheduled-draft-job-material.js"
import { assertPlanningRootHasNoUnresolvedSteering } from "./pg-store-create.js"
import { createGraphTasks } from "./task-graph-pg-create.js"
import { requireTaskGraphContinuationBudget, hasPersistedPlanReceipt } from "./pg-task-graph-command-port-schedule.js"
import { writePlanReceipt } from "./task-graph-pg-events.js"
import { lockTaskGraphScope, loadTaskGraph, type GraphParent, type LoadedGraph } from "./task-graph-pg-state.js"
import { isExactObjectiveTaskGraphIntent } from "./objective-task-graph-child-authority.js"
import { buildObjectiveTailorWaveCandidateCatalog, resolveObjectiveTailorWaveCandidates,
  type ObjectiveTailorWaveCandidateCatalog } from "./objective-tailor-candidate-v2.js"
import { readObjectiveTailorWaveInventory, type ObjectiveTailorWaveInventory } from "./objective-tailor-wave-inventory.js"
import { buildObjectiveTailorGraphMarker, objectiveTailorGraphFloorMatchesTurn,
  readObjectiveTailorScoreFloorRequest } from "./objective-tailor-score-floor-marker.js"
import { bindObjectiveTailorWaveCandidateWitness, parseObjectiveTailorWaveCandidateRefs,
  type ObjectiveTailorWaveCandidateWitness } from "./objective-tailor-wave-witness.js"
import type { ObjectiveTailorGraph } from "@jobcopilot/agent-protocol"
import { objectiveTailorWaveChildExecutionAllowed, prepareObjectiveTailorWaveCreatePlan,
  type ObjectiveTailorWaveCreatePlan } from "./task-graph-pg-create-objective-tailor-wave.js"
import { TaskGraphCommandError, type TaskGraphExecutionScope, type TaskGraphReadScope, type TaskGraphScheduleReceipt } from "./task-graph-command-port.js"
import { requireOwnedRootPlanCriteria } from "./root-plan-criteria.js"
import { canonicalTaskGraphJson, taskGraphFingerprint, taskGraphItemId, taskGraphProposalKey, parseTaskGraphSnapshot } from "./task-graph-snapshot.js"
import { transaction, type Queryable } from "./pg-store-persistence.js"
import { parsePersistedTaskGraphReceipt } from "./task-graph-pg-event-validation.js"

type Row = Record<string, unknown>
type WaveInput = Readonly<{ scope: TaskGraphExecutionScope; expectedRevision: number; candidateRefs: readonly string[] }>
const MAX_REVISION = 2_147_483_646

export function readObjectiveTailorWaveCatalog(pool: Pick<pg.Pool, "connect">, scope: TaskGraphReadScope): Promise<ObjectiveTailorWaveCandidateCatalog | undefined> {
  return transaction(pool, client => readCatalogWithClient(client, scope))
}
export function appendObjectiveTailorWave(pool: Pick<pg.Pool, "connect">, input: WaveInput): Promise<TaskGraphScheduleReceipt> {
  return transaction(pool, client => appendWaveWithClient(client, input))
}

export async function readCatalogWithClient(client: Queryable, scope: TaskGraphReadScope): Promise<ObjectiveTailorWaveCandidateCatalog | undefined> {
  if (process.env.ENABLE_AGENT_OBJECTIVE_TAILOR_WAVES !== "1") return undefined
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [scope.userId])
  const parent = await lockTaskGraphScope(client, scope, true)
  const turn = await readObjectiveTurn(client, scope)
  if (!validRoot(parent, scope) || !turn || !eligibleObjective(parent, turn.input, turn.executionMode)) return undefined
  await assertPlanningRootHasNoUnresolvedSteering(client, parent.allowedActions, scope)
  const loaded = await loadTaskGraph(client, scope, true)
  if (!loaded.item || !loaded.snapshot || !loaded.state || loaded.discoveryTurnEligibility !== "ordinary"
    || !objectiveTailorGraphFloorMatchesTurn(loaded.snapshot.objectiveTailor, loaded.snapshot.nodes, turn.input)
    || !objectiveTailorGraphFloorMatchesTurn(loaded.state.objectiveTailor, loaded.state.nodes, turn.input)
    || canonicalTaskGraphJson(loaded.snapshot.objectiveTailor ?? null) !== canonicalTaskGraphJson(loaded.state.objectiveTailor ?? null)) return undefined
  return buildObjectiveTailorWaveCandidateCatalog(client, scope, loaded)
}

export async function appendWaveWithClient(client: Queryable, raw: WaveInput): Promise<TaskGraphScheduleReceipt> {
  const input = validInput(raw)
  if (!input || process.env.ENABLE_AGENT_OBJECTIVE_TAILOR_WAVES !== "1") throw denied()
  const { scope, expectedRevision, candidateRefs } = input
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [scope.userId])
  const parent = await lockTaskGraphScope(client, scope, true)
  const turn = await readObjectiveTurn(client, scope, scope.stepId)
  if (!validRoot(parent, scope) || !turn || !eligibleObjective(parent, turn.input, turn.executionMode)) throw denied()
  const requirements = resolveRootTaskVerificationRequirements(turn.input)
  if (requirements.status === "invalid") throw denied()
  const loaded = await loadTaskGraph(client, scope, true, { includeSourceProvenance: true, currentStepId: scope.stepId, currentStepAttempt: 1 })
  if (!loaded.item || !loaded.snapshot || !loaded.state || loaded.discoveryTurnEligibility !== "ordinary") {
    if (await hasPersistedPlanReceipt(client, scope)) throw new TaskGraphCommandError("task_graph_state_missing", "Persisted TaskGraph state is unavailable")
    throw stale()
  }
  const scoreFloorRequest = readObjectiveTailorScoreFloorRequest(turn.input)
  if (scoreFloorRequest.status === "invalid"
    || !objectiveTailorGraphFloorMatchesTurn(loaded.snapshot.objectiveTailor, loaded.snapshot.nodes, turn.input)
    || !objectiveTailorGraphFloorMatchesTurn(loaded.state.objectiveTailor, loaded.state.nodes, turn.input)
    || canonicalTaskGraphJson(loaded.snapshot.objectiveTailor ?? null) !== canonicalTaskGraphJson(loaded.state.objectiveTailor ?? null)) throw denied()
  const key = taskGraphProposalKey(scope.rootTaskId, expectedRevision), fingerprint = requestFingerprint(scope, expectedRevision, candidateRefs)
  const replay = await findExactReplay(client, input, loaded, key, fingerprint)
  if (replay) return replay
  await assertPlanningRootHasNoUnresolvedSteering(client, parent.allowedActions, scope)
  if (loaded.state.revision !== expectedRevision) throw new TaskGraphCommandError("revision_mismatch", "TaskGraph revision is stale", loaded.state.revision)
  if (expectedRevision >= MAX_REVISION) throw new TaskGraphCommandError("revision_limit", "TaskGraph revision limit reached", expectedRevision)
  const resolved = await resolveObjectiveTailorWaveCandidates(client, scope, loaded, expectedRevision, candidateRefs)
  const inventory = resolved?.inventory, selections = resolved?.selections
  if (!inventory || !selections || selections.length !== candidateRefs.length) throw stale()
  const slots = nextSlots(inventory, selections.length)
  if (!slots) throw stale()
  const witnesses = selections.map((selection, index) => bindObjectiveTailorWaveCandidateWitness(selection,
    { slotId: slots[index]!, admittedRevision: expectedRevision + 1 }))
  if (witnesses.some(value => !value)) throw stale()
  const completeWitnesses = witnesses as ObjectiveTailorWaveCandidateWitness[]
  for (const jobId of [...new Set(selections.map(value => value.candidate.jobId))].sort()) {
    const job = await client.query(`SELECT "id" FROM "Job" WHERE "id" = $1 AND "userId" = $2 FOR SHARE`, [jobId, scope.userId])
    const selection = selections.find(value => value.candidate.jobId === jobId)
    if (job.rows.length !== 1 || !selection || await readCurrentScheduledDraftJobMaterialDigest(client, scope.userId, jobId) !== selection.candidate.materialDigest) {
      throw new TaskGraphCommandError("objective_tailor_wave_source_stale", "A candidate source material changed")
    }
  }
  const nextMarker = buildObjectiveTailorGraphMarker(inventory.sourceNodeCount,
    [...(inventory.marker?.slots ?? []), ...completeWitnesses.map(value => ({ slotId: value.slotId,
      sourceAnalystNodeKey: value.sourceAnalystKeys[0]!, writerNodeKey: value.writerNodeKey, reviewerNodeKey: value.reviewerNodeKey
    } as ObjectiveTailorGraph["slots"][number]))], scoreFloorRequest)
  if (!nextMarker) throw denied()
  const plan = prepareObjectiveTailorWaveCreatePlan({ current: loaded.state, witnesses: completeWitnesses, nextMarker })
  if (!plan) throw stale()
  const pinned = loaded.snapshot.rootSuccessCriteria === undefined ? undefined
    : await requireOwnedRootPlanCriteria(client, scope, parent, loaded.snapshot.rootSuccessCriteria, undefined)
  await requireTaskGraphContinuationBudget(client, scope)
  const created = await createGraphTasks(client, { scope, proposal: plan.proposal, templates: plan.templates, verificationRequirements: requirements },
    parent, loaded.state, new Map(loaded.snapshot.nodes.map(node => [node.key, node.taskId])), loaded, undefined, true, undefined, false,
    { marker: plan.marker, templatesByNodeKey: plan.templatesByNodeKey })
  if (!createdWaveMatches(created, plan, expectedRevision)) throw conflict()
  const snapshot = pinned ? parseTaskGraphSnapshot({ ...created.snapshot, rootSuccessCriteria: pinned }) : created.snapshot
  const receipt: TaskGraphScheduleReceipt = { status: "accepted", revision: created.state.revision, nodes: created.created, readyTaskIds: created.readyTaskIds }
  await writePlanReceipt(client, { scope, state: created.state, snapshot, expectedRevision, now: new Date(), idempotencyKey: key, fingerprint, receipt })
  return receipt
}

async function readObjectiveTurn(client: Queryable, scope: TaskGraphReadScope, stepId?: string): Promise<Row | undefined> {
  const step = stepId ? `JOIN "agent_steps" AS step ON step."id" = $7 AND step."sessionId" = turn."sessionId"
    AND step."turnId" = turn."id" AND step."taskId" = $4 AND step."status" = 'streaming'` : ""
  const latest = stepId ? `AND NOT EXISTS (SELECT 1 FROM "agent_steps" AS newer WHERE newer."sessionId" = step."sessionId"
    AND newer."turnId" = step."turnId" AND newer."taskId" = step."taskId" AND newer."ordinal" > step."ordinal")` : ""
  const values = stepId ? [scope.turnId, scope.sessionId, scope.userId, scope.rootTaskId, scope.turnLeaseOwner, scope.turnLeaseVersion, stepId]
    : [scope.turnId, scope.sessionId, scope.userId, scope.rootTaskId, scope.turnLeaseOwner, scope.turnLeaseVersion]
  const result = await client.query(`SELECT turn."input", turn."source", turn."executionMode" FROM "agent_turns" AS turn
    JOIN "agent_sessions" AS session ON session."id" = turn."sessionId" AND session."userId" = turn."userId" ${step}
    WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND turn."rootTaskId" = $4
      AND turn."status" = 'in_progress' AND turn."source" = 'user' AND turn."executionMode" = 'canonical_task_graph'
      AND turn."leaseOwnerId" = $5 AND turn."leaseVersion" = $6 AND turn."leaseExpiresAt" > clock_timestamp() ${latest}`, values)
  return result.rows.length === 1 ? result.rows[0] as Row : undefined
}

function eligibleObjective(parent: GraphParent, input: unknown, mode: unknown): boolean {
  return mode === "canonical_task_graph" && isExactObjectiveTaskGraphIntent(input)
    && objectiveTailorWaveChildExecutionAllowed({ turnInput: input, executionMode: mode,
      rootBudgetSnapshot: parent.budgetSnapshot, rootAllowedActions: parent.allowedActions })
}
function validRoot(parent: GraphParent, scope: TaskGraphReadScope): boolean {
  return parent.id === scope.rootTaskId && parent.sessionId === scope.sessionId && parent.turnId === scope.turnId
    && parent.rootTaskId === scope.rootTaskId && parent.parentTaskId === null && parent.role === "orchestrator"
    && parent.taskType === "root" && parent.status === "running" && parent.leaseOwner === scope.parentLeaseOwner
    && Number(parent.attemptCount) === scope.parentAttemptCount && parent.interruptRequestedAt === null
}
function nextSlots(inventory: ObjectiveTailorWaveInventory, count: number): string[] | undefined {
  const first = inventory.occupiedSlots.length + 1
  return first + count - 1 <= 8 ? Array.from({ length: count }, (_, index) => `tailor-${first + index}`) : undefined
}
function createdWaveMatches(created: Awaited<ReturnType<typeof createGraphTasks>>, plan: ObjectiveTailorWaveCreatePlan, expectedRevision: number): boolean {
  const count = plan.proposal.nodes.length / 2, slots = plan.marker.slots.slice(-count)
  if (!Number.isInteger(count) || count < 1 || slots.length !== count || created.state.revision !== expectedRevision + 1
    || created.created.length !== count * 2 || created.readyTaskIds.length !== count) return false
  const ready: string[] = [], ids = new Set<string>()
  for (let index = 0; index < count; index++) {
    const slot = slots[index]!, writer = created.created[index * 2], reviewer = created.created[index * 2 + 1]
    if (!writer || !reviewer || writer.key !== slot.writerNodeKey || writer.status !== "queued"
      || reviewer.key !== slot.reviewerNodeKey || reviewer.status !== "waiting"
      || !writer.taskId || !reviewer.taskId || ids.has(writer.taskId) || ids.has(reviewer.taskId)) return false
    for (const [key, status, taskId] of [[writer.key, "queued", writer.taskId], [reviewer.key, "waiting", reviewer.taskId]] as const) {
      if (created.state.nodes.find(node => node.key === key)?.status !== status || created.taskIds.get(key) !== taskId
        || created.snapshot.nodes.find(node => node.key === key)?.taskId !== taskId) return false
    }
    ids.add(writer.taskId); ids.add(reviewer.taskId); ready.push(writer.taskId)
  }
  return ready.every((taskId, index) => created.readyTaskIds[index] === taskId)
}
function validInput(value: unknown): WaveInput | undefined {
  const row = exact(value, "candidateRefs,expectedRevision,scope"), refs = row && parseObjectiveTailorWaveCandidateRefs(row.candidateRefs)
  const scope = row && exact(row.scope, "parentAttemptCount,parentLeaseOwner,parentTaskId,rootTaskId,sessionId,stepId,turnId,turnLeaseOwner,turnLeaseVersion,userId")
  if (!row || !scope || !refs || !Number.isSafeInteger(row.expectedRevision) || Number(row.expectedRevision) < 1
    || Number(row.expectedRevision) >= MAX_REVISION) return undefined
  return { scope: scope as unknown as TaskGraphExecutionScope, expectedRevision: Number(row.expectedRevision), candidateRefs: refs }
}
function requestFingerprint(scope: TaskGraphExecutionScope, expectedRevision: number, candidateRefs: readonly string[]): string {
  return taskGraphFingerprint({ kind: "objective_tailor_candidate_wave", scope: {
    userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId,
  }, expectedRevision, candidateRefs })
}
async function findExactReplay(client: Queryable, input: WaveInput, loaded: LoadedGraph, key: string, fingerprint: string): Promise<TaskGraphScheduleReceipt | null> {
  const { scope, expectedRevision, candidateRefs } = input
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
  if (!payload || !item
    || payload.kind !== "proposal" || payload.fingerprint !== fingerprint || row.actor !== "orchestrator"
    || row.correlationId !== scope.turnId || !Number.isSafeInteger(Number(row.sequence)) || row.type !== "item.delta"
    || item.status !== "streaming" || item.phase !== null || item.completedAt !== null || item.stepId !== row.causationId) throw conflict()
  try { parsePersistedTaskGraphReceipt(row.type, payload, { id: loaded.item.id, revision: loaded.item.revision }, loaded.snapshot, scope,
    { itemId: row.itemId, taskId: row.taskId, idempotencyKey: row.idempotencyKey, type: row.type }) } catch { throw conflict() }
  const inventory = await readObjectiveTailorWaveInventory(client, scope, loaded)
  if (!inventory) throw conflict()
  const receipt = exact(payload.receipt, "nodes,readyTaskIds,revision,status"), slots = candidateRefs.map(ref => inventory.occupiedSlots.find(slot => slot.witness.candidateRef === ref))
  const expectedNodes = slots.flatMap(slot => slot ? [{ key: slot.witness.writerNodeKey, taskId: slot.writerTaskId, status: "queued" as const },
    { key: slot.witness.reviewerNodeKey, taskId: slot.reviewerTaskId, status: "waiting" as const }] : [])
  const ready = slots.map(slot => slot?.writerTaskId)
  if (!receipt || slots.some(slot => !slot || slot.witness.admittedRevision !== expectedRevision + 1)
    || payload.revision !== expectedRevision + 1 || receipt.revision !== expectedRevision + 1
    || receipt.status !== "accepted" || canonicalTaskGraphJson(receipt.nodes) !== canonicalTaskGraphJson(expectedNodes)
    || canonicalTaskGraphJson(receipt.readyTaskIds) !== canonicalTaskGraphJson(ready)) throw conflict()
  return { status: "duplicate", revision: expectedRevision + 1, nodes: expectedNodes, readyTaskIds: ready as string[] }
}
function record(value: unknown): Row | undefined {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return undefined } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  try { const row = parsed as Row; return (Object.getPrototypeOf(row) === Object.prototype || Object.getPrototypeOf(row) === null)
    && Reflect.ownKeys(row).every(key => typeof key === "string" && Object.getOwnPropertyDescriptor(row, key)?.enumerable
      && "value" in Object.getOwnPropertyDescriptor(row, key)!) ? row : undefined } catch { return undefined }
}
function exact(value: unknown, keys: string): Row | undefined {
  const row = record(value), expected = keys.split(",")
  return row && Reflect.ownKeys(row).length === expected.length && Reflect.ownKeys(row).every(key => typeof key === "string" && expected.includes(key)) ? row : undefined
}
function denied(): TaskGraphCommandError { return new TaskGraphCommandError("objective_tailor_wave_not_eligible", "Objective tailoring waves are unavailable for this Turn") }
function stale(): TaskGraphCommandError { return new TaskGraphCommandError("objective_tailor_wave_stale", "Candidate evidence is stale or unavailable") }
function conflict(): TaskGraphCommandError { return new TaskGraphCommandError("idempotency_conflict", "The TaskGraph proposal key was already used") }
