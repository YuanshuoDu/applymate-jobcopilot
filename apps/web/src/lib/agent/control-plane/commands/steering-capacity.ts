import { createHash } from "node:crypto"
import { Prisma } from "@prisma/client"
import { parseCognitiveAgendaReceipt } from "../../../../components/agent-workspace/v2/cognitive-agenda-view"
import { AgentCommandError } from "./errors"
import type { CommandTransaction } from "./transaction"
import {
  acceptedSource, exact, failClosed, graphItemId, id, object, parseReceipt, rootClientMessageId, sequence, stepFrom, validDate,
  MAX_UNRESOLVED_STEERING_INPUTS,
  type Candidate, type Cursor, type Row, type Step, type StoredReceipt, type Supersession,
} from "./steering-capacity-history-validation"
export { MAX_UNRESOLVED_STEERING_INPUTS } from "./steering-capacity-history-validation"
const PAGE_SIZE = MAX_UNRESOLVED_STEERING_INPUTS + 1
const INPUT_STATUSES = new Set(["accepted", "queued", "consumed", "cancelled", "rejected"])
function canonicalJson(value: unknown): string { if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]"; const row = object(value); return row ? "{" + Object.keys(row).sort().map(key => JSON.stringify(key) + ":" + canonicalJson(row[key])).join(",") + "}" : JSON.stringify(value) ?? "null" }
function normalizedProposalNode(value: unknown, key: string, rootTaskId: string): Row | null { const proposal = object(value), repair = object(proposal?.repairOf), base = ["dependsOn", "goal", "key", "successCriteria", "templateId"]; if (!proposal || proposal.key !== key || ![[...base], [...base, "verification"], ["dependsOn", "goal", "key", "repairOf", "successCriteria", "templateId", "verification"]].some(keys => exact(proposal, keys))) return null; if (!Object.hasOwn(proposal, "repairOf")) return proposal; if (!repair) return null; if (Object.hasOwn(repair, "graphRootTaskId")) return repair.graphRootTaskId === rootTaskId ? proposal : null; return { ...proposal, repairOf: { ...repair, graphRootTaskId: rootTaskId } } }
function proposalMatchesStored(value: unknown, key: string, stored: Row | undefined, rootTaskId: string): boolean { const proposal = normalizedProposalNode(value, key, rootTaskId), fields = ["dependsOn", "goal", "key", "repairOf", "successCriteria", "templateId", "verification"]; return Boolean(stored && proposal && fields.every(field => Object.hasOwn(proposal, field) === Object.hasOwn(stored, field)) && Object.keys(proposal).every(field => canonicalJson(proposal[field]) === canonicalJson(stored[field]))) }
function callMatches(row: Row, scope: { userId: string; sessionId: string; turnId: string; rootTaskId: string }, stored: StoredReceipt): boolean {
  const receipt = stored.receipt, relation = receipt.supersession, payload = object(row.payload), content = object(row.itemContent), input = object(content?.input), callId = row.correlationId, eventSequence = sequence(row.eventSequence)
  const toolName = receipt.decision === "keep" ? "agent.reconcile" : "agent.plan", inputKeys = receipt.decision === "keep" ? ["decision", "expectedRevision"] : ["expectedRevision", "nodes", ...(relation ? ["replaceUnstarted"] : [])]
  const identity = JSON.stringify([scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, receipt.stepId, callId]), receiptKey = `agent.plan.reconciliation:sha256:${createHash("sha256").update(identity, "utf8").digest("hex")}`
  const replace = object(input?.replaceUnstarted), normalizedNode = Array.isArray(input?.nodes) && input.nodes.length === 1 && relation ? normalizedProposalNode(input.nodes[0], relation.replacement.nodeKey, scope.rootTaskId) : null
  const replacementFingerprint = relation && input && normalizedNode && replace ? createHash("sha256").update(canonicalJson({ source: relation.source, expectedRevision: input.expectedRevision,
    replaceUnstarted: { nodeKey: replace.nodeKey }, nodes: [normalizedNode] }), "utf8").digest("hex") : null
  const replacementCall = Boolean(relation && input && Array.isArray(input.nodes) && input.nodes.length === 1 && replace && exact(replace, ["nodeKey"]) && replace.nodeKey === relation.source.nodeKey
    && proposalMatchesStored(input.nodes[0], relation.replacement.nodeKey, stored.finalReplacement, scope.rootTaskId) && relation.agentPlanCall.callId === callId && relation.agentPlanCall.stepId === row.stepId
    && relation.agentPlanCall.expectedRevision === input.expectedRevision && replacementFingerprint === relation.replacementFingerprint)
  return eventSequence !== null && eventSequence < stored.sequence && id(callId) && row.type === "tool_call.started" && row.actor === "orchestrator" && row.eventTaskId === scope.rootTaskId
    && row.eventItemId === row.callItemId && row.correlationId === callId && row.idempotencyKey === `turn:${scope.turnId}:event:tool-started:${callId}`
    && payload !== null && exact(payload, ["taskId", "toolCallId", "toolName"]) && payload.taskId === scope.rootTaskId && payload.toolCallId === callId && payload.toolName === toolName
    && row.stepId === receipt.stepId && row.itemTaskId === scope.rootTaskId && row.itemType === "tool_call" && content !== null && content.toolCallId === callId && content.toolName === toolName && content.toolVersion === "1"
    && input !== null && exact(input, inputKeys) && input.expectedRevision === receipt.observedRevision
    && (receipt.decision === "keep" ? input.decision === "keep" : relation ? replacementCall && eventSequence! < relation.cancellationEvent.sequence : Array.isArray(input.nodes) && input.nodes.length > 0)
    && stored.idempotencyKey === receiptKey && (!relation || relation.operationKey === stored.idempotencyKey)
}
function lifecycleKey(rootTaskId: string, nodeKey: string): string { return graphItemId(rootTaskId) + ":node:" + createHash("sha256").update(nodeKey).digest("hex").slice(0, 20) + ":0:task.cancelled" }
function graphNodes(value: unknown): Row[] | null {
  const graph = object(value), nodes = graph?.nodes, required = ["dependsOn", "depth", "goal", "key", "successCriteria", "taskId", "templateId"], allowed = [...required, "nativeDelegation", "registeredScoutEnvelope", "repairOf", "verification", "verificationDisposition"]
  if (!graph || !exact(graph, ["nodes", "schemaVersion"]) || graph.schemaVersion !== "agent-harness.v2.task-graph" || !Array.isArray(nodes) || nodes.length > 8) return null
  const parsed = nodes.map(object), keys = new Set<string>(), tasks = new Set<string>()
  for (const node of parsed) { if (!node || !required.every(key => Object.hasOwn(node, key)) || Object.keys(node).some(key => !allowed.includes(key)) || !id(node.key) || !id(node.taskId) || keys.has(node.key) || tasks.has(node.taskId)) return null; keys.add(node.key); tasks.add(node.taskId) }
  return parsed as Row[]
}
function sameNodeEnvelope(source: Row, replacement: Row): boolean { const stable = (node: Row) => Object.fromEntries(Object.entries(node).filter(([key]) => !["goal", "key", "successCriteria", "taskId"].includes(key))); return canonicalJson(stable(source)) === canonicalJson(stable(replacement)) }
function exactGraphTransition(beforeContent: unknown, afterContent: unknown, relation: Supersession): boolean {
  const before = graphNodes(beforeContent), after = graphNodes(afterContent); if (!before || !after) return false
  const source = before.find(node => node.key === relation.source.nodeKey && node.taskId === relation.source.taskId), replacement = after.find(node => node.key === relation.replacement.nodeKey && node.taskId === relation.replacement.taskId)
  const unchanged = before.filter(node => node !== source), unchangedAfter = after.filter(node => node !== replacement)
  return Boolean(source && replacement && before.length === after.length && unchanged.length === unchangedAfter.length && !before.some(node => node.key === relation.replacement.nodeKey || node.taskId === relation.replacement.taskId) && !after.some(node => node.key === relation.source.nodeKey || node.taskId === relation.source.taskId) && unchanged.every(oldNode => { const current = unchangedAfter.find(node => node.key === oldNode.key); return current && canonicalJson(current) === canonicalJson(oldNode) }) && sameNodeEnvelope(source, replacement))
}
function eventItem(value: unknown, scope: { sessionId: string; turnId: string; rootTaskId: string }, revision: number): boolean { const item = object(value), itemId = graphItemId(scope.rootTaskId); return Boolean(item && item.id === itemId && item.sessionId === scope.sessionId && item.turnId === scope.turnId && item.taskId === scope.rootTaskId && item.type === "task_graph" && item.revision === revision && graphNodes(item.content)) }
function supersessionEventsMatch(cancel: Row, plan: Row, stored: StoredReceipt, scope: { sessionId: string; turnId: string; rootTaskId: string }): boolean {
  const relation = stored.receipt.supersession!, cancelPayload = object(cancel.payload), cancelEvent = object(cancelPayload?.event), planPayload = object(plan.payload)
  const planReceipt = object(planPayload?.receipt), planItem = object(planPayload?.item), graphId = graphItemId(scope.rootTaskId)
  const proposalNodes = planReceipt?.nodes, created = Array.isArray(proposalNodes) && proposalNodes.length === 1 ? object(proposalNodes[0]) : null, readyTaskIds = planReceipt?.readyTaskIds, cancellationSequence = sequence(cancel.eventSequence), planSequence = sequence(plan.eventSequence)
  const valid = Boolean(cancel.hasOutbox === true && plan.hasOutbox === true && cancel.eventId === relation.cancellationEvent.id && cancellationSequence === relation.cancellationEvent.sequence
    && cancel.type === "item.delta" && cancel.actor === "system" && cancel.eventTaskId === relation.source.taskId && cancel.eventItemId === graphId && cancel.correlationId === scope.turnId
    && cancel.causationId === relation.agentPlanCall.stepId && cancel.idempotencyKey === lifecycleKey(scope.rootTaskId, relation.source.nodeKey) && cancelPayload !== null && exact(cancelPayload, ["kind", "event", "revision", "item"])
    && cancelPayload.kind === "lifecycle" && cancelPayload.revision === relation.cancellationRevision && cancelEvent !== null && exact(cancelEvent, ["expectedRevision", "idempotencyKey", "nodeKey", "type"])
    && cancelEvent.expectedRevision === relation.observedRevision && cancelEvent.idempotencyKey === cancel.idempotencyKey && cancelEvent.nodeKey === relation.source.nodeKey && cancelEvent.type === "task.cancelled" && eventItem(cancelPayload.item, scope, relation.cancellationRevision)
    && plan.eventId === relation.planEvent.id && planSequence === relation.planEvent.sequence && cancellationSequence < planSequence && planSequence < stored.sequence
    && plan.type === "item.delta" && plan.actor === "orchestrator" && plan.eventTaskId === scope.rootTaskId && plan.eventItemId === graphId && plan.correlationId === scope.turnId && plan.causationId === relation.agentPlanCall.stepId
    && plan.idempotencyKey === relation.planEvent.idempotencyKey && plan.idempotencyKey === graphId + ":supersession:" + relation.observedRevision && planPayload !== null && exact(planPayload, ["kind", "observedRevision", "operationKey", "fingerprint", "revision", "receipt", "item", "content"])
    && planPayload.kind === "proposal" && planPayload.observedRevision === relation.observedRevision && planPayload.operationKey === relation.operationKey && planPayload.fingerprint === relation.replacementFingerprint && planPayload.revision === relation.resultingRevision
    && planReceipt !== null && exact(planReceipt, ["status", "revision", "nodes", "readyTaskIds"]) && planReceipt.status === "accepted" && planReceipt.revision === relation.resultingRevision
    && created !== null && exact(created, ["key", "taskId", "status"]) && created.key === relation.replacement.nodeKey && created.taskId === relation.replacement.taskId && (created.status === "queued" ? Array.isArray(readyTaskIds) && readyTaskIds.length === 1 && readyTaskIds[0] === created.taskId : created.status === "waiting" && Array.isArray(readyTaskIds) && readyTaskIds.length === 0) && eventItem(planItem, scope, relation.resultingRevision)
     && canonicalJson(planPayload.content) === canonicalJson(planItem?.content) && exactGraphTransition(object(cancelPayload?.item)?.content, planItem?.content, relation))
  if (!valid) return false; stored.finalReplacement = graphNodes(planItem?.content)?.find(node => node.key === relation.replacement.nodeKey && node.taskId === relation.replacement.taskId); return Boolean(stored.finalReplacement)
}
/** Reads through the caller's Session-locked transaction; historic data is folded in bounded pages. */
export async function readUnresolvedSteeringCount(tx: CommandTransaction, scope: { sessionId: string; userId: string; turnId: string }): Promise<number> {
  const turns = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT "input", "rootTaskId" FROM "agent_turns" WHERE "id" = ${scope.turnId} AND "sessionId" = ${scope.sessionId} AND "userId" = ${scope.userId}`)
  if (turns.length !== 1) return failClosed()
  const turnInput = turns[0]?.input, rootTaskId = turns[0]?.rootTaskId
  if (rootTaskId !== null && !id(rootTaskId)) return failClosed()
  const rootId = typeof rootTaskId === "string" ? rootTaskId : null
  let rootAttemptCount = 0, graphRevision = 0
  if (rootId) {
    const roots = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT "id", "sessionId", "turnId", "attemptCount" FROM "sub_agent_tasks" WHERE "id" = ${rootId} AND "sessionId" = ${scope.sessionId} AND "turnId" = ${scope.turnId}`)
    if (roots.length !== 1 || roots[0]?.id !== rootId || !Number.isSafeInteger(roots[0]?.attemptCount) || Number(roots[0]?.attemptCount) < 0) return failClosed()
    rootAttemptCount = Number(roots[0]?.attemptCount)
    const graphId = `task-graph-${createHash("sha256").update(rootId).digest("hex")}`
    const graphs = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT "revision" FROM "agent_items" WHERE "id" = ${graphId} AND "sessionId" = ${scope.sessionId} AND "turnId" = ${scope.turnId} AND "taskId" = ${rootId} AND "type" = 'task_graph'`)
    if (graphs.length > 1) return failClosed()
    if (graphs.length) { graphRevision = Number(graphs[0]?.revision); if (!Number.isSafeInteger(graphRevision) || graphRevision < 0) return failClosed() }
  }
  const bound = rootClientMessageId(turnInput); if (bound === null) return failClosed()
  const pending: Candidate[] = [], seenInputIds = new Set<string>(), seenSequences = new Set<bigint>(), seenEventIds = new Set<string>(), seenItemIds = new Set<string>()
  let inputCursor: Cursor | null = null, inputsExhausted = false, rootMatches = 0
  async function fillInputs(through: bigint | null): Promise<void> {
    while (!inputsExhausted) {
      const rows = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT input."id", input."sessionId" AS "inputSessionId", input."targetTurnId" AS "inputTargetTurnId", input."userId" AS "inputUserId",
        input."content" AS "inputContent", input."clientMessageId", input."delivery", input."status", input."acceptedSequence", input."consumedByStepId", input."consumedAt", input."cancelledAt",
        event."id" AS "acceptedEventId", event."sessionId" AS "acceptedEventSessionId", event."turnId" AS "acceptedEventTurnId", event."type" AS "acceptedType", event."actor" AS "acceptedActor",
        event."taskId" AS "acceptedEventTaskId", event."correlationId" AS "acceptedEventCorrelationId", event."causationId" AS "acceptedEventCausationId", event."itemId" AS "acceptedItemId", event."sequence" AS "acceptedEventSequence", event."payload" AS "acceptedPayload",
        accepted_item."id" AS "acceptedItemRowId", accepted_item."sessionId" AS "acceptedItemSessionId", accepted_item."turnId" AS "acceptedItemTurnId", accepted_item."stepId" AS "acceptedItemStepId",
        accepted_item."type" AS "acceptedItemType", accepted_item."taskId" AS "acceptedItemTaskId", accepted_item."status" AS "acceptedItemStatus", accepted_item."content" AS "acceptedItemContent"
        FROM "agent_inputs" AS input LEFT JOIN "agent_events" AS event ON event."sessionId" = input."sessionId" AND event."turnId" = input."targetTurnId" AND event."sequence" = input."acceptedSequence"
        LEFT JOIN "agent_items" AS accepted_item ON accepted_item."id" = event."itemId" AND accepted_item."sessionId" = input."sessionId" AND accepted_item."turnId" = input."targetTurnId"
        WHERE input."sessionId" = ${scope.sessionId} AND input."targetTurnId" = ${scope.turnId} AND input."userId" = ${scope.userId}
        ${inputCursor ? Prisma.sql`AND (input."acceptedSequence" > ${inputCursor.sequence} OR (input."acceptedSequence" = ${inputCursor.sequence} AND input."id" > ${inputCursor.id}))` : Prisma.empty}
        ${through === null ? Prisma.empty : Prisma.sql`AND input."acceptedSequence" <= ${through}`}
        ORDER BY input."acceptedSequence", input."id" LIMIT ${PAGE_SIZE}`)
      if (!rows.length) { if (through === null) inputsExhausted = true; return }
      const pageCandidates: Candidate[] = []
      for (const row of rows) {
        const acceptedSequence = sequence(row.acceptedSequence)
        if (!id(row.id) || !id(row.clientMessageId) || acceptedSequence === null || !["steer", "follow_up"].includes(String(row.delivery)) || !INPUT_STATUSES.has(String(row.status))
          || !(row.consumedByStepId === null || id(row.consumedByStepId)) || !(row.consumedAt === null || validDate(row.consumedAt)) || !(row.cancelledAt === null || validDate(row.cancelledAt))
          || inputCursor && (acceptedSequence < inputCursor.sequence || acceptedSequence === inputCursor.sequence && row.id <= inputCursor.id)) return failClosed()
        inputCursor = { sequence: acceptedSequence, id: row.id }
        if (seenInputIds.has(row.id) || seenSequences.has(acceptedSequence) || !id(row.acceptedEventId) || seenEventIds.has(row.acceptedEventId)
          || !id(row.acceptedItemId) || seenItemIds.has(row.acceptedItemId)) return failClosed()
        seenInputIds.add(row.id); seenSequences.add(acceptedSequence); seenEventIds.add(row.acceptedEventId); seenItemIds.add(row.acceptedItemId)
        const source = acceptedSource(row, scope)
        if (!source || sequence(row.acceptedEventSequence) !== acceptedSequence) return failClosed()
        const isOriginal = bound !== undefined && row.clientMessageId === bound
        if (isOriginal && ++rootMatches > 1) return failClosed()
        if (isOriginal || row.delivery !== "steer" || !["accepted", "queued", "consumed"].includes(String(row.status))) continue
        if (row.status === "consumed") { if (!row.consumedByStepId || !validDate(row.consumedAt) || row.cancelledAt !== null) return failClosed() }
        else if (row.consumedByStepId !== null || row.consumedAt !== null || row.cancelledAt !== null) return failClosed()
        if (source === "user") {
          pending.push({ id: row.id, acceptedSequence, status: row.status as Candidate["status"], consumedByStepId: row.consumedByStepId as string | null, consumer: null }); pageCandidates.push(pending[pending.length - 1]!)
          if (pending.length > MAX_UNRESOLVED_STEERING_INPUTS) return failClosed()
        }
      }
      const consumerIds = [...new Set(pageCandidates.map(row => row.consumedByStepId).filter((value): value is string => value !== null))]
      if (consumerIds.length) {
        if (!rootId) return failClosed()
        const stepRows = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT "id", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds" FROM "agent_steps"
          WHERE "sessionId" = ${scope.sessionId} AND "turnId" = ${scope.turnId} AND "taskId" = ${rootId} AND "id" = ANY(${consumerIds}::text[])`)
        if (stepRows.length !== consumerIds.length) return failClosed()
        const consumers = new Map<string, Step>()
        for (const row of stepRows) { const step = stepFrom(row); if (!step || step.taskId !== rootId || step.attempt > rootAttemptCount || consumers.has(step.id)) return failClosed(); consumers.set(step.id, step) }
        for (const candidate of pageCandidates) if (candidate.consumedByStepId) {
          const consumer = consumers.get(candidate.consumedByStepId)
          if (!consumer || !consumer.ids.includes(candidate.id) || consumer.cursor < candidate.acceptedSequence) return failClosed()
          candidate.consumer = { ordinal: consumer.ordinal, attempt: consumer.attempt }
        }
      }
      if (rows.length < PAGE_SIZE) { if (through === null) inputsExhausted = true; return }
    }
  }
  let receiptCursor: Cursor | null = null, previousReceiptSequence = BigInt(-1), previousCheckpoint = BigInt(-1)
  while (true) {
    const receiptRows: Row[] = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT event."id", event."itemId", event."taskId", event."type", event."actor", event."correlationId", event."causationId", event."sequence", event."idempotencyKey", event."payload",
      EXISTS (SELECT 1 FROM "agent_outbox" AS outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id") AS "hasOutbox"
      FROM "agent_events" AS event WHERE event."sessionId" = ${scope.sessionId} AND event."turnId" = ${scope.turnId} AND event."type" = 'agent.plan.reconciliation'
      ${receiptCursor ? Prisma.sql`AND (event."sequence" > ${receiptCursor.sequence} OR (event."sequence" = ${receiptCursor.sequence} AND event."id" > ${receiptCursor.id}))` : Prisma.empty}
      ORDER BY event."sequence", event."id" LIMIT ${PAGE_SIZE}`)
    if (!receiptRows.length) break
    const receipts: StoredReceipt[] = []
    for (const row of receiptRows) {
      const receipt = rootId ? parseReceipt(row.payload, scope.sessionId, scope.turnId, rootId) : null
      const eventSequence = sequence(row.sequence)
      if (!receipt || !id(row.id) || row.itemId !== null || row.taskId !== rootId || row.type !== "agent.plan.reconciliation" || row.actor !== "orchestrator"
        || row.correlationId !== scope.turnId || row.causationId !== receipt.stepId || row.hasOutbox !== false
        || typeof row.idempotencyKey !== "string" || !/^agent\.plan\.reconciliation:sha256:[a-f0-9]{64}$/.test(row.idempotencyKey) || eventSequence === null || eventSequence <= previousReceiptSequence) return failClosed()
      previousReceiptSequence = eventSequence
      receiptCursor = { sequence: eventSequence, id: row.id }
      receipts.push({ receipt, sequence: eventSequence, idempotencyKey: row.idempotencyKey })
    }
    if (!rootId) return failClosed()
    const superseded = receipts.filter(stored => stored.receipt.supersession)
    if (superseded.length) {
      const eventIds = superseded.flatMap(stored => [stored.receipt.supersession!.cancellationEvent.id, stored.receipt.supersession!.planEvent.id])
      if (new Set(eventIds).size !== eventIds.length) return failClosed()
      const linkedRows = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT event."id" AS "eventId", event."sequence" AS "eventSequence", event."type", event."actor", event."taskId" AS "eventTaskId", event."itemId" AS "eventItemId", event."correlationId", event."causationId", event."idempotencyKey", event."payload", EXISTS (SELECT 1 FROM "agent_outbox" AS outbox WHERE outbox."idempotencyKey" = 'agent-event:' || event."id") AS "hasOutbox" FROM "agent_events" AS event WHERE event."sessionId" = ${scope.sessionId} AND event."turnId" = ${scope.turnId} AND event."id" = ANY(${eventIds}::text[]) ORDER BY event."sequence", event."id"`)
      const byId = new Map<string, Row>()
      for (const row of linkedRows) { if (!id(row.eventId) || byId.has(row.eventId)) return failClosed(); byId.set(row.eventId, row) }
      if (byId.size !== eventIds.length) return failClosed()
      for (const stored of superseded) { const relation = stored.receipt.supersession!, cancel = byId.get(relation.cancellationEvent.id), plan = byId.get(relation.planEvent.id); if (!cancel || !plan || relation.operationKey !== stored.idempotencyKey || !supersessionEventsMatch(cancel, plan, stored, { ...scope, rootTaskId: rootId })) return failClosed() }
    }
    const historyStepIds = [...new Set(receipts.map(entry => entry.receipt.stepId))]
    const historyRows = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT "id", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds" FROM "agent_steps"
      WHERE "sessionId" = ${scope.sessionId} AND "turnId" = ${scope.turnId} AND "taskId" = ${rootId} AND "id" = ANY(${historyStepIds}::text[])`)
    if (historyRows.length !== historyStepIds.length) return failClosed()
    const steps = new Map<string, Step>()
    for (const row of historyRows) { const step = stepFrom(row); if (!step || step.taskId !== rootId || step.attempt > rootAttemptCount || steps.has(step.id)) return failClosed(); steps.set(step.id, step) }
    const agendas = new Map<string, number>()
    let agendaCursor: Cursor | null = null
    while (true) {
      const agendaRows: Row[] = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT event."id", event."sequence", event."actor", event."itemId", event."taskId", event."correlationId", event."payload" FROM "agent_events" AS event
        WHERE event."sessionId" = ${scope.sessionId} AND event."turnId" = ${scope.turnId} AND event."type" = 'cognitive.agenda' AND event."taskId" = ${rootId}
          AND event."itemId" IS NULL AND event."correlationId" = ANY(${historyStepIds}::text[])
        ${agendaCursor ? Prisma.sql`AND (event."sequence" > ${agendaCursor.sequence} OR (event."sequence" = ${agendaCursor.sequence} AND event."id" > ${agendaCursor.id}))` : Prisma.empty}
        ORDER BY event."sequence", event."id" LIMIT ${PAGE_SIZE}`)
      if (!agendaRows.length) break
      for (const row of agendaRows) {
        const rowSequence = sequence(row.sequence), rowId = id(row.id) ? row.id : null, stepId = String(row.correlationId)
        const agenda = parseCognitiveAgendaReceipt(object(row.payload), { sessionId: scope.sessionId, turnId: scope.turnId, taskId: rootId, stepId })
        if (rowSequence === null || !rowId || !agenda || row.itemId !== null || row.taskId !== rootId || !["subagent", "orchestrator"].includes(String(row.actor)) || agendas.has(stepId)) return failClosed()
        agendaCursor = { sequence: rowSequence, id: rowId }; agendas.set(stepId, agenda.planRevision ?? -1)
      }
      if (agendaRows.length < PAGE_SIZE) break
    }
    if (agendas.size !== historyStepIds.length) return failClosed()
    const receiptsByStep = new Map<string, StoredReceipt[]>()
    for (const stored of receipts) { const list = receiptsByStep.get(stored.receipt.stepId) ?? []; list.push(stored); receiptsByStep.set(stored.receipt.stepId, list) }
    const matches = new Map<StoredReceipt, number>()
    let callCursor: Cursor | null = null
    while (true) {
      const callRows: Row[] = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT event."id" AS "eventId", event."sequence" AS "eventSequence", event."type", event."actor", event."taskId" AS "eventTaskId", event."itemId" AS "eventItemId", event."correlationId", event."idempotencyKey", event."payload",
        item."id" AS "callItemId", item."stepId", item."taskId" AS "itemTaskId", item."type" AS "itemType", item."content" AS "itemContent"
        FROM "agent_events" AS event JOIN "agent_items" AS item ON item."id" = event."itemId" AND item."sessionId" = event."sessionId" AND item."turnId" = event."turnId"
        WHERE event."sessionId" = ${scope.sessionId} AND event."turnId" = ${scope.turnId} AND event."type" = 'tool_call.started' AND event."taskId" = ${rootId}
          AND item."taskId" = ${rootId} AND item."type" = 'tool_call' AND item."stepId" = ANY(${historyStepIds}::text[])
        ${callCursor ? Prisma.sql`AND (event."sequence" > ${callCursor.sequence} OR (event."sequence" = ${callCursor.sequence} AND event."id" > ${callCursor.id}))` : Prisma.empty}
        ORDER BY event."sequence", event."id" LIMIT ${PAGE_SIZE}`)
      if (!callRows.length) break
      for (const row of callRows) {
        const rowSequence = sequence(row.eventSequence), rowId = id(row.eventId) ? row.eventId : null
        if (rowSequence === null || !rowId) return failClosed()
        callCursor = { sequence: rowSequence, id: rowId }
        for (const stored of receiptsByStep.get(String(row.stepId)) ?? []) if (callMatches(row, { ...scope, rootTaskId: rootId }, stored)) {
          const count = (matches.get(stored) ?? 0) + 1
          if (count > 1) return failClosed()
          matches.set(stored, count)
        }
      }
      if (callRows.length < PAGE_SIZE) break
    }
    for (const stored of receipts) if (matches.get(stored) !== 1) return failClosed()
    for (const stored of receipts) {
      const { receipt } = stored, step = steps.get(receipt.stepId)
      if (!step || agendas.get(step.id) !== receipt.observedRevision || step.cursor !== receipt.through || receipt.resultingRevision > graphRevision || receipt.through <= previousCheckpoint) return failClosed()
      previousCheckpoint = receipt.through
      await fillInputs(receipt.through)
      const expected = pending.filter(input => input.acceptedSequence <= receipt.through)
      if (expected.some(input => !input.consumer || input.consumer.ordinal > step.ordinal || input.consumer.ordinal === step.ordinal && input.consumer.attempt > step.attempt)
        || expected.map(input => input.id).sort().join("\0") !== receipt.steerInputIds.join("\0")) return failClosed()
      const resolvedIds = new Set(expected.map(input => input.id))
      for (let index = pending.length - 1; index >= 0; index--) if (resolvedIds.has(pending[index]!.id)) pending.splice(index, 1)
    }
    if (receiptRows.length < PAGE_SIZE) break
  }
  await fillInputs(null)
  if (bound !== undefined && rootMatches !== 1 || pending.length > MAX_UNRESOLVED_STEERING_INPUTS) return failClosed()
  return pending.length
}
export async function assertSteeringCapacity(tx: CommandTransaction, scope: { sessionId: string; userId: string; turnId: string }): Promise<void> {
  const unresolvedCount = await readUnresolvedSteeringCount(tx, scope)
  if (unresolvedCount >= MAX_UNRESOLVED_STEERING_INPUTS) {
    throw new AgentCommandError("invalid_command", "This Turn has reached its steering capacity", 409,
      { capacity: MAX_UNRESOLVED_STEERING_INPUTS, unresolvedCount })
  }
}
