import type pg from "pg"
import { parseTurnQuestionGateChoiceBinding, parseTurnScheduledGateChoiceItemState,
  turnScheduledGateChoiceWaitId, type TurnQuestionGateChoiceBinding } from "../turns/turn-question-gate-choice-contract.js"
import type { ScheduledGateWaitScope } from "./scheduled-gate-wait-match.js"
import { matchScheduledGateWaitTarget } from "./scheduled-gate-wait-match.js"

type Row = Record<string, unknown>
type Queryable = Pick<pg.PoolClient, "query">
export type ScheduledGateResumeWaitSelection = Readonly<{ status: "initial" }>
  | Readonly<{ status: "resumed"; requestAttemptCount: number }>
  | Readonly<{ status: "invalid" }>
type ResumeWaitScope = Pick<ScheduledGateWaitScope, "userId" | "sessionId" | "turnId" | "rootTaskId" | "stepId" | "gateTaskId">

function record(value: unknown): Row | null {
  if (typeof value === "string") { try { value = JSON.parse(value) as unknown } catch { return null } }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Row : null
}
function validId(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 }
function sameOwner(left: TurnQuestionGateChoiceBinding["owner"], right: TurnQuestionGateChoiceBinding["owner"]): boolean {
  return left.userId === right.userId && left.sessionId === right.sessionId && left.turnId === right.turnId
    && left.rootTaskId === right.rootTaskId && left.rootAttemptCount === right.rootAttemptCount
    && left.executionId === right.executionId && left.executionAttemptCount === right.executionAttemptCount
}

/** Selects the exact latest answer handoff by lifecycle validity, never timestamps or attempt-number ordering. */
export async function selectScheduledGateResumeWaitAttempt(client: Queryable, input: ResumeWaitScope & {
  owner: TurnQuestionGateChoiceBinding["owner"]
}): Promise<ScheduledGateResumeWaitSelection> {
  if (![input.userId, input.sessionId, input.turnId, input.rootTaskId, input.stepId, input.gateTaskId].every(validId)
    || !input.owner || input.owner.userId !== input.userId || input.owner.sessionId !== input.sessionId
    || input.owner.turnId !== input.turnId || input.owner.rootTaskId !== input.rootTaskId) return { status: "invalid" }
  const rows = await client.query<Row>(`SELECT "id", "stepId", "taskId", "type", "status", "content" FROM "agent_items"
    WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "type" = 'question'
      AND "content"->>'stage' = 'scheduled_gate' AND "content"->'scheduledGateChoiceBinding'->>'gateTaskId' = $4 LIMIT 52`,
  [input.sessionId, input.turnId, input.rootTaskId, input.gateTaskId])
  if (rows.rows.length > 51) return { status: "invalid" }
  const acknowledged: number[] = []
  for (const row of rows.rows) {
    const content = record(row.content), binding = parseTurnQuestionGateChoiceBinding(content?.scheduledGateChoiceBinding)
    const waitId = turnScheduledGateChoiceWaitId(binding), state = binding && parseTurnScheduledGateChoiceItemState(content, row.status, binding)
    if (!binding || !waitId || row.id !== `agent-wait:question:${waitId}` || row.stepId === null || !validId(row.stepId)
      || row.taskId !== input.rootTaskId || row.type !== "question" || binding.gateTaskId !== input.gateTaskId
      || !sameOwner(binding.owner, input.owner) || state == null) return { status: "invalid" }
    if (state.answer === null) {
      if (row.status !== "started" || state.resumeAcknowledgement !== null) return { status: "invalid" }
      continue
    }
    if (row.status !== "completed") return { status: "invalid" }
    if (state.resumeAcknowledgement) acknowledged.push(binding.gateAttempt)
  }
  if (acknowledged.length === 0) return { status: "initial" }
  const valid: number[] = []
  for (const requestAttemptCount of new Set(acknowledged)) {
    const disposition = await matchScheduledGateWaitTarget(client, { ...input, requestAttemptCount })
    if (disposition === "matched" || disposition === "pending") valid.push(requestAttemptCount)
  }
  return valid.length === 1 ? { status: "resumed", requestAttemptCount: valid[0]! } : { status: "invalid" }
}
