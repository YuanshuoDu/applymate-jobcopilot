import { normalizeAgentLocationAllowlist } from "@jobcopilot/shared"
import type pg from "pg"
import type { TaskGraphExecutionScope } from "./task-graph-schedule-input.js"
import { isOrdinaryRegisteredScout } from "./task-graph-pending-scout-scope.js"
import type { TaskGraphConfirmedLocationSteerResult } from "./task-graph-confirmed-location-steer.js"
import { parseSteeringReconciliationReceipt, STEERING_RECONCILIATION_EVENT_TYPE,
  type SteeringReconciliationState } from "./steering-reconciliation-contract.js"
import { parsePersistedTaskGraphReceipt } from "./task-graph-pg-event-validation.js"
import type { LoadedGraph, GraphTaskRow } from "./task-graph-pg-state.js"
import { canonicalTaskGraphJson, taskGraphItemId, taskGraphProposalKey, type StoredTaskGraphNode } from "./task-graph-snapshot.js"
import { taskGraphScoutRetirementIdempotencyKey, type TaskGraphScoutRetirementInput,
  type TaskGraphSupersededScoutRetirementPlan } from "./task-graph-scout-retirement-contract.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type PlanInput = TaskGraphScoutRetirementInput & Readonly<{
  client: Client
  loaded: LoadedGraph
  reconciliation: SteeringReconciliationState
  confirmed: Extract<TaskGraphConfirmedLocationSteerResult, { kind: "confirmed" }>
}>
const MAX_SEQUENCE = (1n << 63n) - 1n
const REMOTE = new Set(["remote", "anywhere", "worldwide", "work from home", "wfh", "distributed"])

function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : null
}
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }
function sequence(value: unknown): bigint | null {
  try {
    const parsed = typeof value === "bigint" ? value : typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value) ? BigInt(value) : -1n
    return parsed >= 0n && parsed <= MAX_SEQUENCE ? parsed : null
  } catch { return null }
}
function locations(value: unknown): readonly string[] | null {
  const normalized = normalizeAgentLocationAllowlist(value)
  return normalized && Array.isArray(value) && canonicalTaskGraphJson(value) === canonicalTaskGraphJson(normalized)
    && !normalized.some(item => REMOTE.has(item) || /[*?]/u.test(item)) ? normalized : null
}
function location(node: StoredTaskGraphNode): readonly string[] | null {
  const criteria = node.verification?.criteria.filter(item => item.id === "candidate-location") ?? []
  const check = criteria.length === 1 ? criteria[0]?.check : undefined
  return check?.kind === "candidate_location_in" ? locations(check.locations) : null
}
function validGraph(input: PlanInput): boolean {
  const { loaded, scope, expectedRevision, reconciliation: state, confirmed } = input
  const revision = loaded.item?.revision, latest = state.latestUserRevision, accepted = confirmed.acceptedInputSequence
  return loaded.discoveryTurnEligibility === "ordinary" && loaded.rootTaskId === scope.rootTaskId
    && loaded.snapshot !== null && loaded.state !== null && loaded.item?.id === taskGraphItemId(scope.rootTaskId)
    && Number.isSafeInteger(revision) && revision === expectedRevision && loaded.state.revision === revision
    && loaded.snapshot.nodes.length > 0 && loaded.snapshot.nodes.length === loaded.state.nodes.length
    && loaded.tasks.size === loaded.snapshot.nodes.length && loaded.sourceInputCheckpointByNodeKey?.size === loaded.snapshot.nodes.length
    && state.currentRevision === revision && state.agendaPlanRevision === revision && state.decisionStepId === scope.stepId
    && state.decisionInputThroughSequence !== null && state.unresolvedInputs.length === 0
    && state.lastReconciledInputThroughSequence !== undefined && state.lastReconciledInputThroughSequence >= accepted
    && latest !== undefined && latest.resultingRevision <= Number(revision) && id(latest.stepId) && latest.soleSteerSequence === accepted
    && latest.inputThroughSequence <= state.decisionInputThroughSequence
    && loaded.currentInputCheckpoint?.inputThroughSequence === state.decisionInputThroughSequence
    && id(confirmed.acceptedInputId) && accepted > 0n && accepted <= MAX_SEQUENCE
}

export async function buildTaskGraphSupersededScoutRetirementPlan(input: PlanInput): Promise<TaskGraphSupersededScoutRetirementPlan | null> {
  try {
    if (!input || !taskGraphScoutRetirementIdempotencyKey(input) || !validGraph(input)
      || input.confirmed.kind !== "confirmed" || !locations(input.confirmed.locations)) return null
    const { loaded, scope, taskId, confirmed, reconciliation } = input
    const nodeKey = loaded.snapshot?.nodes.find(node => node.taskId === input.taskId)?.key
    if (!nodeKey || loaded.snapshot?.nodes.filter(node => node.taskId === input.taskId).length !== 1) return null
    const latest = reconciliation.latestUserRevision
    if (!latest) return null
    const accepted = confirmed.acceptedInputSequence, currentLocations = locations(confirmed.locations)!
    const snapshot = loaded.snapshot!, item = loaded.item!, revision = item.revision
    const nodes = new Map(snapshot.nodes.map(node => [node.key, node] as const))
    const taskIds = new Set(snapshot.nodes.map(node => node.taskId))
    if (taskIds.size !== snapshot.nodes.length) return null
    const target = nodes.get(nodeKey), targetTask = target && loaded.tasks.get(target.taskId)
    const oldSource = loaded.sourceInputCheckpointByNodeKey?.get(nodeKey)?.inputThroughSequence
    if (!target || target.taskId !== taskId || !targetTask || !isOrdinaryRegisteredScout(target, targetTask)
      || targetTask.status !== "running" || Number(targetTask.attemptCount) < 1 || oldSource === undefined || oldSource === null
      || oldSource >= accepted || target.dependsOn.length || snapshot.nodes.some(node => node.key !== nodeKey
        && (node.repairOf?.nodeKey === nodeKey || dependsOn(node, nodeKey, nodes)))) return null
    const oldLocations = location(target)
    if (!oldLocations || oldLocations.some(value => currentLocations.includes(value))) return null
    const plan = await acceptedPlan(input.client, loaded, scope, latest.resultingRevision, reconciliation)
    const reconciliationEvent = await acceptedReconciliation(input.client, scope, latest.resultingRevision, latest.stepId,
      reconciliation, accepted, confirmed.acceptedInputId)
    if (!plan || !reconciliationEvent || plan.sequence >= reconciliationEvent.sequence) return null
    const created = plan.receiptNodes.filter(entry => {
      const node = nodes.get(entry.key), task = node && loaded.tasks.get(node.taskId)
      const source = loaded.sourceInputCheckpointByNodeKey?.get(entry.key)?.inputThroughSequence
      return node && node.taskId === entry.taskId && entry.key !== nodeKey && entry.taskId !== taskId
        && isOrdinaryRegisteredScout(node, task!) && ["queued", "running", "retrying", "waiting", "waiting_for_user", "completed"].includes(task!.status)
        && source !== undefined && source !== null && source >= accepted
        && canonicalTaskGraphJson(location(node)) === canonicalTaskGraphJson(currentLocations)
    })
    if (created.length !== 1) return null
    const replacement = created[0]!, source = loaded.sourceInputCheckpointByNodeKey!.get(replacement.key)!.inputThroughSequence
    return {
      schemaVersion: "agent-harness.v2.task-graph.superseded-scout-retirement.v1", sessionId: scope.sessionId,
      turnId: scope.turnId, rootTaskId: scope.rootTaskId, nodeKey, taskId, graphRevision: revision,
      acceptedPlanRevision: latest.resultingRevision,
      acceptedSteerSequence: accepted.toString(), reconciliationStepId: reconciliationEvent.receipt.stepId,
      reconciliationThroughSequence: reconciliationEvent.receipt.inputCheckpoint.throughSequence,
      reconciliationEventId: reconciliationEvent.id, reconciliationEventSequence: reconciliationEvent.sequence.toString(),
      reconciliationIdempotencyKey: reconciliationEvent.idempotencyKey, planEventId: plan.id,
      planEventSequence: plan.sequence.toString(), planIdempotencyKey: plan.idempotencyKey,
      replacementNodeKey: replacement.key, replacementTaskId: replacement.taskId, replacementSourceSequence: source.toString(),
    }
  } catch { return null }
}

function dependsOn(node: StoredTaskGraphNode, targetKey: string, nodes: ReadonlyMap<string, StoredTaskGraphNode>): boolean {
  const seen = new Set<string>(), stack = [...node.dependsOn]
  while (stack.length) {
    const key = stack.pop()!
    if (key === targetKey) return true
    if (seen.has(key)) continue
    seen.add(key)
    const dependency = nodes.get(key)
    if (!dependency) return true
    stack.push(...dependency.dependsOn)
  }
  return false
}

async function acceptedPlan(client: Client, loaded: LoadedGraph, scope: TaskGraphExecutionScope, planRevision: number,
  state: SteeringReconciliationState): Promise<Readonly<{ id: string; sequence: bigint; idempotencyKey: string; receiptNodes: readonly { key: string; taskId: string }[] }> | null> {
  const result = await client.query<Row>(`SELECT "id", "sequence", "type", "actor", "itemId", "taskId", "correlationId", "causationId", "idempotencyKey", "payload"
    FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "itemId" = $3 AND "idempotencyKey" = $4 LIMIT 2`,
  [scope.sessionId, scope.turnId, taskGraphItemId(scope.rootTaskId), taskGraphProposalKey(scope.rootTaskId, planRevision - 1)])
  if (result.rows.length !== 1) return null
  const row = result.rows[0]!, payload = object(row.payload), receipt = object(payload?.receipt), seq = sequence(row.sequence)
  if (!payload || !receipt || !Array.isArray(receipt.nodes) || !id(row.id) || seq === null || row.type !== "item.delta"
    || row.actor !== "orchestrator" || row.itemId !== taskGraphItemId(scope.rootTaskId) || row.taskId !== scope.rootTaskId
    || row.correlationId !== scope.turnId || row.causationId !== state.latestUserRevision?.stepId
    || row.idempotencyKey !== taskGraphProposalKey(scope.rootTaskId, planRevision - 1)
    || payload.kind !== "proposal" || payload.revision !== planRevision || receipt.revision !== planRevision || receipt.status !== "accepted"
    || object(payload.item)?.stepId !== state.latestUserRevision?.stepId) return null
  parsePersistedTaskGraphReceipt(row.type, payload, { id: loaded.item!.id, revision: loaded.item!.revision }, loaded.snapshot!, scope, {
    type: row.type, itemId: row.itemId, taskId: row.taskId, idempotencyKey: row.idempotencyKey,
  })
  const receiptNodes: Array<{ key: string; taskId: string }> = []
  for (const value of receipt.nodes) {
    const entry = object(value)
    if (!entry || !id(entry.key) || !id(entry.taskId)) return null
    receiptNodes.push({ key: entry.key, taskId: entry.taskId })
  }
  return { id: row.id, sequence: seq, idempotencyKey: row.idempotencyKey as string, receiptNodes }
}

async function acceptedReconciliation(client: Client, scope: TaskGraphExecutionScope, planRevision: number, planStepId: string,
  state: SteeringReconciliationState, accepted: bigint, acceptedInputId: string): Promise<Readonly<{ receipt: NonNullable<ReturnType<typeof parseSteeringReconciliationReceipt>>; id: string; sequence: bigint; idempotencyKey: string }> | null> {
  const result = await client.query<Row>(`SELECT event."id", event."sequence", event."type", event."actor", event."itemId", event."taskId",
      event."correlationId", event."causationId", event."idempotencyKey", event."payload",
      EXISTS (SELECT 1 FROM "agent_outbox" AS outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id") AS "hasOutbox"
    FROM "agent_events" AS event WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = $3
      AND event."payload"->>'resultingRevision' = $4 AND event."payload"->>'stepId' = $5 LIMIT 2`,
  [scope.sessionId, scope.turnId, STEERING_RECONCILIATION_EVENT_TYPE, String(planRevision), planStepId])
  if (result.rows.length !== 1) return null
  const row = result.rows[0]!, seq = sequence(row.sequence), receipt = parseSteeringReconciliationReceipt(row.payload, { ...scope, stepId: planStepId })
  if (!receipt || seq === null || row.type !== STEERING_RECONCILIATION_EVENT_TYPE || row.actor !== "orchestrator"
    || row.itemId !== null || row.taskId !== scope.rootTaskId || row.correlationId !== scope.turnId
    || row.causationId !== planStepId || row.hasOutbox !== false || !id(row.id)
    || typeof row.idempotencyKey !== "string" || receipt.schemaVersion !== "agent-harness.v2.plan-reconciliation.v1"
    || receipt.decision !== "revise" || receipt.observedRevision !== planRevision - 1 || receipt.resultingRevision !== planRevision
    || receipt.steerInputIds.length !== 1 || receipt.steerInputIds[0] !== acceptedInputId || receipt.stepId !== state.latestUserRevision?.stepId
    || receipt.inputCheckpoint.throughSequence !== state.latestUserRevision?.inputThroughSequence.toString()
    || state.latestUserRevision?.soleSteerSequence !== accepted) return null
  return { receipt, id: row.id, sequence: seq, idempotencyKey: row.idempotencyKey }
}
