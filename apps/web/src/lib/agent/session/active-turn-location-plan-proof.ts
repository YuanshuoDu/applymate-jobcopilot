import { createHash } from "node:crypto"
import { Prisma } from "@prisma/client"
import { parseCognitiveAgendaReceipt } from "../../../components/agent-workspace/v2/cognitive-agenda-view"
import { normalizeAgentLocationAllowlist } from "@jobcopilot/shared"
import { exact, graphItemId, id, object, parseReceipt, sequence, stepFrom, type Row } from "../control-plane/commands/steering-capacity-history-validation"
import type { CommandTransaction } from "../control-plane/commands/transaction"
import type { ActiveTurnLocationAcceptance, ActiveTurnLocationScope } from "./active-turn-location-acceptance"

export type ActiveTurnLocationPlanProof = "revise" | "keep"
type Reconcile = Readonly<{ event: Row; receipt: NonNullable<ReturnType<typeof parseReceipt>>; sequence: bigint }>
const EVENT = "agent.plan.reconciliation"

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const row = object(value)
  return row ? `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}` : JSON.stringify(value) ?? "null"
}
function snapshot(value: unknown): Row | null {
  const row = object(value)
  if (!row || !["nodes,schemaVersion", "nodes,rootSuccessCriteria,schemaVersion"].includes(Object.keys(row).sort().join(","))
    || row.schemaVersion !== "agent-harness.v2.task-graph" || !Array.isArray(row.nodes) || row.nodes.length > 11) return null
  if (row.rootSuccessCriteria !== undefined && (!Array.isArray(row.rootSuccessCriteria) || row.rootSuccessCriteria.length > 8
    || !row.rootSuccessCriteria.every(value => typeof value === "string" && value.trim() && value.length <= 320))) return null
  const keys = new Set<string>(), tasks = new Set<string>(), required = ["dependsOn", "depth", "goal", "key", "successCriteria", "taskId", "templateId"]
  const allowed = [...required, "nativeDelegation", "packageRefs", "registeredScoutEnvelope", "repairOf", "verification", "verificationDisposition"]
  for (const value of row.nodes) {
    const node = object(value)
    if (!node || required.some(key => !Object.hasOwn(node, key)) || Object.keys(node).some(key => !allowed.includes(key))
      || ![node.key, node.taskId, node.templateId, node.goal].every(value => id(value) && value.length <= 4_000)
      || !Number.isSafeInteger(node.depth) || Number(node.depth) < 1 || Number(node.depth) > 8
      || !Array.isArray(node.dependsOn) || node.dependsOn.length > 8 || !node.dependsOn.every(id)
      || !Array.isArray(node.successCriteria) || node.successCriteria.length > 32
      || !node.successCriteria.every(value => typeof value === "string" && value.length <= 1_000)
      || keys.has(node.key as string) || tasks.has(node.taskId as string)) return null
    keys.add(node.key as string); tasks.add(node.taskId as string)
  }
  return row
}
function scoutScope(nodeValue: unknown, locations: readonly string[]): boolean {
  const node = object(nodeValue), verification = object(node?.verification), criteria = verification?.criteria
  if (!node || node.templateId !== "scout" || node.verificationDisposition !== "typed" || !verification
    || !exact(verification, ["criteria", "role", "schemaVersion"])
    || verification.schemaVersion !== "agent-harness.v2.task-graph-verification.v1" && verification.schemaVersion !== "agent-harness.v2.task-graph-verification.v2"
    || verification.role !== "scout" || !Array.isArray(criteria) || criteria.length < 1 || criteria.length > 8) return false
  const ids = new Set<string>(), entries: Row[] = []
  for (const value of criteria) {
    const entry = object(value)
    if (!entry || !exact(entry, ["check", "id"]) || typeof entry.id !== "string"
      || !/^[a-z][a-z0-9._-]{0,63}$/.test(entry.id) || ids.has(entry.id) || !object(entry.check)) return false
    ids.add(entry.id); entries.push(entry)
  }
  const locationCriteria = entries.filter(entry => object(entry?.check)?.kind === "candidate_location_in")
  const check = object(locationCriteria[0]?.check), raw = check?.locations
  const normalized = normalizeAgentLocationAllowlist(raw)
  return locationCriteria.length === 1 && exact(check!, ["kind", "locations"]) && canonical(raw) === canonical(locations)
    && normalized?.length === locations.length && normalized.every((item, index) => item === locations[index])
}
export function graphMatchesActiveLocationScope(value: unknown, scouts: readonly Row[], locations: readonly string[]): boolean {
  const graph = snapshot(value)
  if (!graph) return false
  const nodes = graph.nodes as unknown[]
  return scouts.length > 0 && scouts.every(scout => nodes.some(node => {
    const row = object(node)
    return row !== null && row.key === scout.key && row.taskId === scout.taskId && scoutScope(row, locations)
  }))
}
export function registeredScoutsFromPlan(content: unknown, registeredValues: unknown): Row[] | null {
  const graph = snapshot(content)
  if (!graph || !Array.isArray(registeredValues) || registeredValues.length > 8) return null
  const registered: Row[] = []
  for (const value of registeredValues) {
    const row = object(value)
    if (!row || !exact(row, ["key", "taskId", "status"]) || !id(row.key) || !id(row.taskId)
      || row.status !== "queued" && row.status !== "waiting" || registered.some(item => item.key === row.key || item.taskId === row.taskId)) return null
    registered.push(row)
  }
  return registered.flatMap(entry => {
    const matches = (graph.nodes as unknown[]).map(object).filter((node): node is Row => node !== null && node.key === entry.key && node.taskId === entry.taskId)
    return matches.length === 1 && matches[0]!.templateId === "scout" ? [entry] : []
  })
}
function acceptedProposal(reconcile: Reconcile, planEvent: Row, scope: ActiveTurnLocationScope,
  tasks: readonly Row[], locations: readonly string[]): boolean {
  const payload = object(planEvent.payload), accepted = object(payload?.receipt), item = object(payload?.item)
  const proposalNodes = accepted?.nodes
  if (!payload || !accepted || !item || !Array.isArray(proposalNodes) || accepted.status !== "accepted"
    || accepted.revision !== reconcile.receipt.resultingRevision || payload.kind !== "proposal" || payload.revision !== accepted.revision
    || item.id !== graphItemId(scope.rootTaskId) || item.sessionId !== scope.sessionId || item.turnId !== scope.turnId
    || item.stepId !== reconcile.receipt.stepId || item.taskId !== scope.rootTaskId || item.type !== "task_graph" || item.revision !== accepted.revision
    || !snapshot(item.content) || payload.content !== undefined && canonical(payload.content) !== canonical(item.content)
    || planEvent.type !== (reconcile.receipt.observedRevision === 0 ? "item.started" : "item.delta")) return false
  const created: Row[] = []
  for (const value of proposalNodes) {
    const row = object(value)
    if (!row || !exact(row, ["key", "taskId", "status"]) || !id(row.key) || !id(row.taskId)
      || row.status !== "queued" && row.status !== "waiting") return false
    if (snapshot(item.content)?.nodes && (snapshot(item.content)!.nodes as unknown[]).some(node => {
      const candidate = object(node)
      return candidate !== null && candidate.key === row.key && candidate.taskId === row.taskId && candidate.templateId === "scout"
    })) created.push(row)
  }
  if (!created.length || !graphMatchesActiveLocationScope(item.content, created, locations)) return false
  const taskIds = created.map(node => node.taskId)
  return new Set(taskIds).size === taskIds.length && created.every(node => tasks.some(task => task.id === node.taskId
    && task.sessionId === scope.sessionId && task.turnId === scope.turnId && task.rootTaskId === scope.rootTaskId
    && task.parentTaskId === scope.rootTaskId && task.role === "scout"))
}
function matchingCall(rows: readonly Row[], reconciliation: Reconcile, scope: ActiveTurnLocationScope): Row | null {
  const receipt = reconciliation.receipt
  const matches = rows.filter(row => {
    const payload = object(row.payload), content = object(row.itemContent), input = object(content?.input)
    const callId = payload?.toolCallId, expectedTool = receipt.decision === "keep" ? "agent.reconcile" : "agent.plan"
    return row.stepId === receipt.stepId && row.taskId === scope.rootTaskId && row.itemTaskId === scope.rootTaskId
      && row.itemType === "tool_call" && row.eventType === "tool_call.started" && row.actor === "orchestrator"
      && row.eventTaskId === scope.rootTaskId && row.correlationId === callId && id(callId)
      && row.idempotencyKey === `turn:${scope.turnId}:event:tool-started:${callId}`
      && payload !== null && exact(payload, ["taskId", "toolCallId", "toolName"])
      && payload.taskId === scope.rootTaskId && payload.toolName === expectedTool && content?.toolCallId === callId
      && content.toolName === expectedTool && content.toolVersion === "1" && input !== null
      && input.expectedRevision === receipt.observedRevision
      && (receipt.decision === "keep" ? exact(input, ["decision", "expectedRevision"]) && input.decision === "keep"
        : Object.hasOwn(input, "nodes") && Array.isArray(input.nodes) && Object.hasOwn(input, "expectedRevision")
          && Object.keys(input).every(key => ["expectedRevision", "nodes", "replaceUnstarted", "rootSuccessCriteria"].includes(key)))
  })
  return matches.length === 1 ? matches[0]! : null
}

/** Returns only a durable confirmed/applied location summary; all provenance remains private. */
export async function readActiveTurnLocationPlanProofs(tx: CommandTransaction, scope: ActiveTurnLocationScope,
  acceptances: readonly ActiveTurnLocationAcceptance[]): Promise<ReadonlyMap<string, ActiveTurnLocationPlanProof>> {
  const proofs = new Map<string, ActiveTurnLocationPlanProof>()
  if (!acceptances.length) return proofs
  const inputIds = acceptances.map(row => row.inputId), graphId = graphItemId(scope.rootTaskId)
  const receiptRows = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT event."id", event."sessionId", event."turnId", event."taskId", event."itemId", event."type", event."actor",
      event."correlationId", event."causationId", event."idempotencyKey", event."sequence", event."payload",
      EXISTS (SELECT 1 FROM "agent_outbox" outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id") AS "hasOutbox"
    FROM "agent_events" event JOIN "agent_turns" turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
    JOIN "agent_sessions" session ON session."id" = event."sessionId" AND session."userId" = turn."userId"
    WHERE event."sessionId" = ${scope.sessionId} AND event."turnId" = ${scope.turnId} AND event."taskId" = ${scope.rootTaskId}
      AND event."type" = ${EVENT} AND turn."userId" = ${scope.userId} AND session."userId" = ${scope.userId}
      AND turn."rootTaskId" = ${scope.rootTaskId} AND turn."source" = 'user' AND turn."executionMode" = 'canonical_task_graph'
      AND event."payload" -> 'steerInputIds' ?| ${inputIds}::text[] ORDER BY event."sequence" ASC LIMIT 129`)
  const currentRows = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT item."revision", item."content"
    FROM "agent_items" item JOIN "agent_turns" turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
    JOIN "agent_sessions" session ON session."id" = item."sessionId" AND session."userId" = turn."userId"
    WHERE item."id" = ${graphId} AND item."sessionId" = ${scope.sessionId} AND item."turnId" = ${scope.turnId}
      AND item."taskId" = ${scope.rootTaskId} AND item."type" = 'task_graph' AND turn."rootTaskId" = ${scope.rootTaskId}
      AND turn."userId" = ${scope.userId} AND session."userId" = ${scope.userId}`)
  const current = currentRows.length === 1 ? currentRows[0]! : null, parsedEvents: Reconcile[] = []
  if (!current || receiptRows.length > 128 || !snapshot(current.content) || !Number.isSafeInteger(current.revision)) return proofs
  for (const event of receiptRows) {
    const receipt = parseReceipt(event.payload, scope.sessionId, scope.turnId, scope.rootTaskId), seq = sequence(event.sequence)
    if (receipt && seq !== null && id(event.id) && event.itemId === null && event.taskId === scope.rootTaskId && event.type === EVENT
      && event.actor === "orchestrator" && event.correlationId === scope.turnId && event.causationId === receipt.stepId
      && event.hasOutbox === false && /^agent\.plan\.reconciliation:sha256:[a-f0-9]{64}$/.test(String(event.idempotencyKey))) parsedEvents.push({ event, receipt, sequence: seq })
  }
  if (parsedEvents.length !== receiptRows.length) return proofs
  const stepIds = [...new Set(parsedEvents.map(row => row.receipt.stepId))]
  const [steps, agendas, calls, plans] = stepIds.length ? await Promise.all([
    tx.$queryRaw<Row[]>(Prisma.sql`SELECT step."id", step."taskId", step."ordinal", step."attempt", step."status", step."inputThroughSequence", step."consumedInputIds",
        root."attemptCount" AS "rootAttemptCount"
      FROM "agent_steps" step JOIN "sub_agent_tasks" root ON root."id" = ${scope.rootTaskId} AND root."sessionId" = step."sessionId" AND root."turnId" = step."turnId"
      JOIN "agent_turns" turn ON turn."id" = step."turnId" AND turn."rootTaskId" = root."id" AND turn."sessionId" = step."sessionId"
      JOIN "agent_sessions" session ON session."id" = step."sessionId" AND session."userId" = turn."userId"
      WHERE step."id" = ANY(${stepIds}::text[]) AND step."sessionId" = ${scope.sessionId} AND step."turnId" = ${scope.turnId}
        AND step."taskId" = ${scope.rootTaskId} AND turn."userId" = ${scope.userId} AND session."userId" = ${scope.userId}`),
    tx.$queryRaw<Row[]>(Prisma.sql`SELECT event."id", event."taskId", event."itemId", event."actor", event."correlationId", event."payload"
    FROM "agent_events" event JOIN "agent_turns" turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
      AND turn."userId" = ${scope.userId} JOIN "agent_sessions" session ON session."id" = event."sessionId" AND session."userId" = ${scope.userId}
    WHERE event."sessionId" = ${scope.sessionId} AND event."turnId" = ${scope.turnId}
        AND event."type" = 'cognitive.agenda' AND event."taskId" = ${scope.rootTaskId} AND event."itemId" IS NULL
        AND turn."rootTaskId" = ${scope.rootTaskId} AND turn."source" = 'user' AND turn."executionMode" = 'canonical_task_graph'
        AND event."correlationId" = ANY(${stepIds}::text[])`),
    tx.$queryRaw<Row[]>(Prisma.sql`SELECT event."id" AS "eventId", event."sequence" AS "eventSequence", event."type" AS "eventType", event."actor",
        event."taskId" AS "eventTaskId", event."correlationId", event."idempotencyKey", event."payload", item."stepId", item."taskId" AS "itemTaskId",
        item."type" AS "itemType", item."content" AS "itemContent"
      FROM "agent_events" event JOIN "agent_turns" turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
        AND turn."userId" = ${scope.userId} JOIN "agent_sessions" session ON session."id" = event."sessionId" AND session."userId" = ${scope.userId}
      JOIN "agent_items" item ON item."id" = event."itemId" AND item."sessionId" = event."sessionId" AND item."turnId" = event."turnId"
      WHERE event."sessionId" = ${scope.sessionId} AND event."turnId" = ${scope.turnId} AND event."type" = 'tool_call.started'
        AND event."taskId" = ${scope.rootTaskId} AND item."taskId" = ${scope.rootTaskId} AND item."type" = 'tool_call'
        AND turn."rootTaskId" = ${scope.rootTaskId} AND turn."source" = 'user' AND turn."executionMode" = 'canonical_task_graph'
        AND item."stepId" = ANY(${stepIds}::text[]) LIMIT 256`),
    tx.$queryRaw<Row[]>(Prisma.sql`SELECT event."id", event."sequence", event."sessionId", event."turnId", event."taskId", event."itemId", event."type",
        event."actor", event."correlationId", event."causationId", event."idempotencyKey", event."payload",
        EXISTS (SELECT 1 FROM "agent_outbox" outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id") AS "hasOutbox"
      FROM "agent_events" event JOIN "agent_turns" turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
        AND turn."userId" = ${scope.userId} JOIN "agent_sessions" session ON session."id" = event."sessionId" AND session."userId" = ${scope.userId}
      WHERE event."sessionId" = ${scope.sessionId} AND event."turnId" = ${scope.turnId}
        AND event."taskId" = ${scope.rootTaskId} AND event."itemId" = ${graphId} AND event."type" IN ('item.started', 'item.delta')
        AND turn."rootTaskId" = ${scope.rootTaskId} AND turn."source" = 'user' AND turn."executionMode" = 'canonical_task_graph'
        AND event."causationId" = ANY(${stepIds}::text[]) AND event."payload" ->> 'kind' = 'proposal' LIMIT 256`),
  ]) : [[], [], [], []]
  if (calls.length >= 256 || plans.length >= 256) return proofs
  const taskIds = plans.flatMap(event => {
    const receipt = object(object(event.payload)?.receipt), nodes = Array.isArray(receipt?.nodes) ? receipt.nodes : []
    return nodes.map(object).filter((node): node is Row => node?.status === "queued" || node?.status === "waiting").map(node => node.taskId).filter(id)
  })
  const taskRows = taskIds.length ? await tx.$queryRaw<Row[]>(Prisma.sql`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", task."role"
    FROM "sub_agent_tasks" task JOIN "agent_turns" turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
      AND turn."userId" = ${scope.userId} JOIN "agent_sessions" session ON session."id" = task."sessionId" AND session."userId" = ${scope.userId}
    WHERE task."id" = ANY(${[...new Set(taskIds)]}::text[]) AND task."sessionId" = ${scope.sessionId}
      AND task."turnId" = ${scope.turnId} AND task."rootTaskId" = ${scope.rootTaskId} AND task."parentTaskId" = ${scope.rootTaskId} AND task."role" = 'scout'
      AND turn."rootTaskId" = ${scope.rootTaskId} AND turn."source" = 'user' AND turn."executionMode" = 'canonical_task_graph'`) : []
  for (const acceptance of acceptances) {
    const rows = parsedEvents.filter(row => row.receipt.steerInputIds.includes(acceptance.inputId)
      && row.receipt.stepId === acceptance.consumedByStepId && acceptance.consumed
      && row.sequence > acceptance.receiptSequence && row.receipt.through >= acceptance.acceptedInputSequence)
    const reconciliation = rows.length === 1 ? rows[0]! : null
    if (!reconciliation) continue
    const stepRow = steps.find(row => row.id === reconciliation.receipt.stepId), step = stepRow ? stepFrom(stepRow) : null
    const agendaRows = agendas.filter(row => row.correlationId === reconciliation.receipt.stepId), agenda = agendaRows.length === 1
      ? parseCognitiveAgendaReceipt(object(agendaRows[0]?.payload), { sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId, stepId: reconciliation.receipt.stepId }) : null
    const call = matchingCall(calls, reconciliation, scope)
    const identity = JSON.stringify([scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, reconciliation.receipt.stepId, object(call?.payload)?.toolCallId])
    const expectedKey = call ? `agent.plan.reconciliation:sha256:${createHash("sha256").update(identity, "utf8").digest("hex")}` : ""
    if (!step || stepRow?.rootAttemptCount === undefined || !Number.isSafeInteger(stepRow.rootAttemptCount)
      || step.attempt > Number(stepRow.rootAttemptCount) || step.taskId !== scope.rootTaskId || step.cursor !== reconciliation.receipt.through
      || !step.ids.includes(acceptance.inputId) || reconciliation.receipt.steerInputIds.some(id => !step.ids.includes(id))
      || !agenda || agenda.planRevision !== reconciliation.receipt.observedRevision || !call
      || sequence(call.eventSequence) === null || sequence(call.eventSequence)! >= reconciliation.sequence
      || reconciliation.event.idempotencyKey !== expectedKey) continue
    if (reconciliation.receipt.decision === "keep") {
      if (Number(current.revision) >= reconciliation.receipt.resultingRevision) proofs.set(acceptance.inputId, "keep")
      continue
    }
    const suffix = reconciliation.receipt.observedRevision
    const proposalKey = `${graphId}:proposal:${suffix}`, replacementKey = `${graphId}:supersession:${suffix}`
    const candidates = plans.filter(row => row.sessionId === scope.sessionId && row.turnId === scope.turnId && row.taskId === scope.rootTaskId
      && row.itemId === graphId && row.type === (reconciliation.receipt.observedRevision === 0 ? "item.started" : "item.delta") && row.causationId === reconciliation.receipt.stepId
      && (row.idempotencyKey === proposalKey || row.idempotencyKey === replacementKey)
      && sequence(row.sequence) !== null && sequence(row.sequence)! < reconciliation.sequence
      && sequence(row.sequence)! > acceptance.receiptSequence && row.actor === "orchestrator" && row.correlationId === scope.turnId && row.hasOutbox === true)
    if (candidates.length !== 1) continue
    const plan = candidates[0]!, payload = object(plan.payload), receipt = object(payload?.receipt), item = object(payload?.item)
    if (reconciliation.receipt.supersession && (plan.id !== reconciliation.receipt.supersession.planEvent.id
      || sequence(plan.sequence) !== reconciliation.receipt.supersession.planEvent.sequence
      || plan.idempotencyKey !== reconciliation.receipt.supersession.planEvent.idempotencyKey)) continue
    const proposalNodes = receipt?.nodes
    const newScouts = registeredScoutsFromPlan(item?.content, proposalNodes)
    const validProposal = acceptedProposal(reconciliation, plan, scope, taskRows, acceptance.locations)
      && item && newScouts !== null && newScouts.length > 0
      && graphMatchesActiveLocationScope(item.content, newScouts, acceptance.locations)
      && graphMatchesActiveLocationScope(current.content, newScouts, acceptance.locations)
    if (!validProposal) continue
    if (Number(current.revision) < reconciliation.receipt.resultingRevision) continue
    proofs.set(acceptance.inputId, "revise")
  }
  return proofs
}
