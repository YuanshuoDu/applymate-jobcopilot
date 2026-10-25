import { createHash } from "node:crypto"
import type pg from "pg"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { parseTurnQuestionGateChoiceBinding, parseTurnScheduledGateChoiceItemState, turnScheduledGateChoiceWaitId } from "../turns/turn-question-gate-choice-contract.js"
import { scheduledAuditWaitKey } from "./scheduled-audit-resume.js"
import { classifyScheduledPipelineRecoveryGraphItem } from "./scheduled-pipeline-recovery-graph-item.js"
import { taskGraphItemId } from "./task-graph-snapshot.js"
import { validateScheduledPipelineRecoverySteps, type ScheduledPipelineRecoveryOwner, type ScheduledPipelineRecoverySource,
  type ScheduledPipelineRecoveryStepEvidence, type ScheduledPipelineRecoveryTail } from "./scheduled-pipeline-recovery-step.js"

type Row = Record<string, unknown>
type QueryClient = Pick<pg.PoolClient, "query">

/** Reads only durable recovery lifecycle evidence; live Audit/Gate proof remains in completion. */
export async function readScheduledPipelineRecoveryEvidence(client: QueryClient, owner: TurnExecutionOwnerFence,
  source: ScheduledPipelineRecoverySource): Promise<ScheduledPipelineRecoveryTail | null | false> {
  const steps = await client.query<Row>(`SELECT "id", "taskId", "ordinal", "attempt", "status", "errorCode", "inputThroughSequence", "consumedInputIds",
      "modelProfileSnapshot", "inputTokens", "outputTokens", "estimatedCostUsd" FROM "agent_steps"
    WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "ordinal" > $4 ORDER BY "ordinal" ASC`,
  [owner.sessionId, owner.turnId, owner.rootTaskId, source.sourceStepOrdinal])
  if (!steps.rows.length) return null
  const ids = steps.rows.map(step => String(step.id))
  const events = await client.query<Row>(`SELECT "id", "sessionId", "turnId", "taskId", "itemId", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload"
    FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND ("correlationId" = ANY($4::text[]) OR ("itemId" = $5 AND "type" = 'item.delta' AND "actor" = 'orchestrator' AND "correlationId" = $6 AND "causationId" = ANY($4::text[])))`,
  [owner.sessionId, owner.turnId, owner.rootTaskId, ids, taskGraphItemId(owner.rootTaskId), owner.turnId])
  const items = await client.query<Row>(`SELECT "id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content"
    FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "stepId" = ANY($4::text[])`,
  [owner.sessionId, owner.turnId, owner.rootTaskId, ids])
  const waits = await client.query<Row>(`SELECT "id", "userId", "sessionId", "turnId", "parentTaskId", "stepId", "idempotencyKey",
      "targetTaskIds", "mode", "status", "matchedTaskIds", "result" FROM "agent_wait_conditions"
    WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3 AND "stepId" = ANY($4::text[])`,
  [owner.sessionId, owner.turnId, owner.rootTaskId, ids])
  const evidence: ScheduledPipelineRecoveryStepEvidence[] = []
  for (const step of steps.rows) {
    const id = String(step.id), ownEvents = events.rows.filter(event => event.correlationId === id || event.causationId === id)
    const starts = ownEvents.filter(event => event.type === "step.started"), completes = ownEvents.filter(event => event.type === "step.completed")
    const ownItems = items.rows.filter(item => item.stepId === id), ownWaits = waits.rows.filter(wait => wait.stepId === id)
    const graphItem = classifyScheduledPipelineRecoveryGraphItem({ owner: source.owner, stepId: id, items: ownItems, events: ownEvents })
    const recoveryItems = graphItem === "verified_plan" ? ownItems.filter(item => item.id !== taskGraphItemId(owner.rootTaskId)) : ownItems
    const consumedInputIds = idsFrom(step.consumedInputIds)
    const completion = completes.length === 1 ? object(completes[0]?.payload) : null
    const completionWaitId = typeof completion?.waitId === "string" ? completion.waitId : null
    const receipt = consumedInputIds && graphItem !== "invalid" ? await recoveryReceipt(client, owner, source, step, recoveryItems, ownWaits,
      completionWaitId) : "invalid"
    const waitId = receipt === "scheduled_wait" ? completionWaitId : null
    evidence.push({ id, taskId: typeof step.taskId === "string" ? step.taskId : null, ordinal: Number(step.ordinal),
      attempt: Number(step.attempt), status: String(step.status), errorCode: typeof step.errorCode === "string" ? step.errorCode : null,
      inputThroughSequence: String(step.inputThroughSequence), inputTokens: Number(step.inputTokens), outputTokens: Number(step.outputTokens),
      estimatedCostUsd: Number(step.estimatedCostUsd), consumedInputIds: consumedInputIds ?? [],
      modelProfileSnapshot: step.modelProfileSnapshot as ScheduledPipelineRecoveryStepEvidence["modelProfileSnapshot"],
      startedEvents: starts, completedEvents: completes, waitId,
      hasModelActivity: ownEvents.some(event => String(event.type).startsWith("model.")) || recoveryItems.some(item => item.type !== "question"),
      hasToolActivity: ownEvents.some(event => String(event.type).startsWith("tool_call."))
        || recoveryItems.some(item => item.type === "tool_call" || item.type === "tool_result"),
      hasFinalRejection: ownEvents.some(event => event.type === "final.rejected"), receipt })
  }
  return validateScheduledPipelineRecoverySteps(source, evidence) ?? false
}

async function recoveryReceipt(client: QueryClient, owner: TurnExecutionOwnerFence, source: ScheduledPipelineRecoverySource,
  step: Row, items: Row[], waits: Row[], completionWaitId: string | null): Promise<ScheduledPipelineRecoveryStepEvidence["receipt"]> {
  const status = String(step.status), stepId = String(step.id), errorCode = step.errorCode ?? null
  const validWaits = await Promise.all(waits.map(wait => validScheduledWait(client, owner, stepId, wait)))
  if (validWaits.some(valid => !valid)) return "invalid"
  if (["streaming", "interrupted", "completed"].includes(status)) return items.length ? "invalid" : "none"
  if (status === "waiting_for_user") {
    if (items.length !== 1) return "invalid"
    const item = items[0]!, content = object(item.content), binding = parseTurnQuestionGateChoiceBinding(content?.scheduledGateChoiceBinding)
    const waitId = turnScheduledGateChoiceWaitId(binding), state = binding && parseTurnScheduledGateChoiceItemState(content, item.status, binding)
    const choiceOwner = object(binding?.owner)
    if (!binding || !waitId || !choiceOwner || !state || item.id !== `agent-wait:question:${waitId}` || item.type !== "question"
      || item.stepId !== stepId || item.taskId !== owner.rootTaskId || !sameOwner(choiceOwner, source.owner, source.rootAttemptCount)
      || binding.gateTaskId !== (await fixedWaitTarget(client, owner, binding.gateTaskId, "gate"))?.id
      || state.answer === null && item.status !== "started" || state.answer !== null && item.status !== "completed") return "invalid"
    return "scheduled_gate_choice"
  }
  if (status !== "waiting_for_tool") return "invalid"
  if (!items.length && errorCode === "scheduled_audit_completion_unverified") {
    return completionWaitId === null && waits.every(wait => wait.status === "ready") ? "scheduled_blocker" : "invalid"
  }
  if (errorCode !== null || items.length || !validText(completionWaitId)) return "invalid"
  return waits.filter(wait => wait.id === completionWaitId).length === 1 ? "scheduled_wait" : "invalid"
}

async function validScheduledWait(client: QueryClient, owner: TurnExecutionOwnerFence, stepId: string, wait: Row): Promise<boolean> {
  const targets = idsFrom(wait.targetTaskIds), result = object(wait.result), request = object(result?.request)
  if (!targets || targets.length !== 1 || !request) return false
  const targetId = targets[0]!, hasGate = Object.hasOwn(request, "scheduledGate"), gate = object(request.scheduledGate)
  if (hasGate) return !!gate && Object.keys(gate).sort().join(",") === "gateTaskId,requestAttemptCount" && gate.gateTaskId === targetId
    && Number.isSafeInteger(gate.requestAttemptCount) && Number(gate.requestAttemptCount) >= 0
    && !!await fixedWaitTarget(client, owner, targetId, "gate")
    && waitMatches(wait, owner, stepId, targetId, "any", gateKey(targetId, stepId, Number(gate.requestAttemptCount)),
      { gateTaskId: targetId, requestAttemptCount: Number(gate.requestAttemptCount) })
  const audit = await fixedWaitTarget(client, owner, targetId, "audit")
  if (audit && Number.isSafeInteger(audit.maxAttempts) && Number(audit.maxAttempts) > 0 && Number(audit.maxAttempts) <= 32) {
    for (let attempt = 1; attempt <= Number(audit.maxAttempts); attempt += 1) {
      if (waitMatches(wait, owner, stepId, targetId, "all", scheduledAuditWaitKey(targetId, stepId, attempt))) return true
    }
  }
  const prepare = await fixedWaitTarget(client, owner, targetId, "prepare")
  return !!prepare && waitMatches(wait, owner, stepId, targetId, "all", String(wait.idempotencyKey))
    && typeof wait.idempotencyKey === "string" && /^scheduled-prepare-dependency:[a-f0-9]{64}$/.test(wait.idempotencyKey)
}

async function fixedWaitTarget(client: QueryClient, owner: TurnExecutionOwnerFence, id: string,
  kind: "audit" | "prepare" | "gate"): Promise<Row | null> {
  const row = (await client.query<Row>(`SELECT task."id", task."parentTaskId", task."rootTaskId", task."sessionId", task."turnId",
      task."depth", task."role", task."taskType", task."maxAttempts", session."userId"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
      AND task."parentTaskId" = $4 AND session."userId" = $5`,
  [id, owner.sessionId, owner.turnId, owner.rootTaskId, owner.userId])).rows[0]
  const expected = kind === "audit" ? ["auditor", "scheduled_taskgraph_audit"]
    : kind === "gate" ? ["prepare", "scheduled_taskgraph_gate"] : ["prepare", "scheduled_application_prepare"]
  return row && row.id === id && row.parentTaskId === owner.rootTaskId && row.rootTaskId === owner.rootTaskId
    && row.sessionId === owner.sessionId && row.turnId === owner.turnId && row.userId === owner.userId && Number(row.depth) === 1
    && row.role === expected[0] && row.taskType === expected[1] ? row : null
}

function waitMatches(row: Row, owner: TurnExecutionOwnerFence, stepId: string, target: string, mode: "all" | "any",
  key: string, gate?: { gateTaskId: string; requestAttemptCount: number }): boolean {
  const targets = idsFrom(row.targetTaskIds), matched = idsFrom(row.matchedTaskIds), result = object(row.result), request = object(result?.request)
  const outer = Object.keys(result ?? {}).sort().join(","), waiting = row.status === "waiting" && matched?.length === 0
  const ready = row.status === "ready" && same(matched, [target])
  const keys = gate ? ["mode", "scheduledGate", "targetTaskIds", "timeoutMs"] : ["mode", "targetTaskIds", "timeoutMs"]
  return validText(row.id) && row.userId === owner.userId && row.sessionId === owner.sessionId && row.turnId === owner.turnId
    && row.parentTaskId === owner.rootTaskId && row.stepId === stepId && row.idempotencyKey === key && (waiting || ready)
    && row.mode === mode && same(targets, [target]) && (outer === "request" || outer === "outcome,request") && !!request
    && Object.keys(request).sort().join(",") === keys.sort().join(",") && request.mode === mode
    && request.timeoutMs === 86_400_000 && same(request.targetTaskIds, [target]) && (!gate || same(request.scheduledGate, gate))
}

function sameOwner(left: Row, right: ScheduledPipelineRecoveryOwner, attempt: number): boolean {
  return left.userId === right.userId && left.sessionId === right.sessionId && left.turnId === right.turnId
    && left.rootTaskId === right.rootTaskId && Number(left.rootAttemptCount) === attempt
}
function object(value: unknown): Row | null {
  value = parse(value)
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null
}
function parse(value: unknown): unknown { if (typeof value !== "string") return value; try { return JSON.parse(value) as unknown } catch { return null } }
function idsFrom(value: unknown): string[] | null {
  const row = parse(value)
  return Array.isArray(row) && row.every(validText) && new Set(row).size === row.length ? row : null
}
function validText(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 }
function same(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => same(value, right[index]))
  const a = object(left), b = object(right)
  if (!a || !b) return false
  const keys = Object.keys(a).sort(), otherKeys = Object.keys(b).sort()
  return keys.length === otherKeys.length && keys.every((key, index) => key === otherKeys[index] && same(a[key], b[key]))
}
function gateKey(taskId: string, stepId: string, attempt: number): string {
  return `scheduled-gate-wait:${createHash("sha256").update(JSON.stringify([taskId, stepId, attempt]), "utf8").digest("hex")}`
}
