import type pg from "pg"
import { appendTaskGraphReceipt } from "../subagents/task-graph-pg-events.js"
import { readSteeringReconciliationState } from "../subagents/steering-reconciliation-read.js"
import { steeringReconciliationId, steeringReconciliationSequence, type SteeringReconciliationScope } from "../subagents/steering-reconciliation-contract.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { assertQuestionOwner, questionId, questionItemId } from "./turn-question-store-guards.js"
import {
  parseTurnQuestionPlanningReceipt, turnQuestionPlanningEventKey, TURN_QUESTION_PLANNING_EVENT_TYPE,
  TURN_QUESTION_PLANNING_SCHEMA_VERSION, type TurnQuestionPlanningReceipt,
} from "./turn-question-planning-contract.js"

type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
export type TurnQuestionPlanningObservationInput = Readonly<{
  owner: TurnExecutionOwnerFence
  stepId: string
  toolCallId: string
  waitId: string
  questionItemId: string
}>

function parseActions(value: unknown): string[] | null {
  let parsed = value
  if (typeof parsed === "string") { try { parsed = JSON.parse(parsed) as unknown } catch { return null } }
  return Array.isArray(parsed) && parsed.every(action => typeof action === "string") ? parsed as string[] : null
}
function consumedIds(value: unknown): string[] | null {
  let parsed = value
  if (typeof parsed === "string") { try { parsed = JSON.parse(parsed) as unknown } catch { return null } }
  if (!Array.isArray(parsed) || parsed.length > 256 || !parsed.every(steeringReconciliationId) || new Set(parsed).size !== parsed.length) return null
  return parsed as string[]
}

export async function prepareTurnQuestionPlanningObservation(client: Queryable, input: TurnQuestionPlanningObservationInput): Promise<TurnQuestionPlanningReceipt | null> {
  assertQuestionOwner(input.owner)
  if (!input.stepId.trim() || !input.toolCallId.trim() || input.waitId !== questionId(input.owner, input.stepId, input.toolCallId)
    || input.questionItemId !== questionItemId(input.waitId)) throw new Error("question_planning_wait_invalid")
  const rootResult = await client.query<Row>(`SELECT task."allowedActions", task."leaseOwner", task."attemptCount"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
      AND task."status" = 'running' AND task."leaseOwner" = $5 AND task."interruptRequestedAt" IS NULL
      AND session."userId" = $6`,
  [input.owner.rootTaskId, input.owner.sessionId, input.owner.turnId, input.owner.rootTaskId, input.owner.ownerId, input.owner.userId])
  const root = rootResult.rows[0]
  if (rootResult.rows.length !== 1 || !root || root.leaseOwner !== input.owner.ownerId) throw new Error("question_planning_root_fenced")
  const actions = parseActions(root.allowedActions)
  if (!actions) throw new Error("question_planning_root_policy_invalid")
  if (!actions.includes("agent.plan")) return null
  const attempt = Number(root.attemptCount)
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("question_planning_root_attempt_invalid")
  const scope: SteeringReconciliationScope = { userId: input.owner.userId, sessionId: input.owner.sessionId, turnId: input.owner.turnId,
    rootTaskId: input.owner.rootTaskId, parentTaskId: input.owner.taskId, stepId: input.stepId,
    turnLeaseOwner: input.owner.ownerId, turnLeaseVersion: input.owner.leaseVersion,
    parentLeaseOwner: input.owner.ownerId, parentAttemptCount: attempt }
  const state = await readSteeringReconciliationState(client, scope)
  if (state.decisionStepId !== input.stepId || state.decisionStepAttempt !== attempt || state.decisionInputThroughSequence === null) {
    throw new Error("question_planning_step_fenced")
  }
  const currentPolicyResult = await client.query<Row>(`SELECT task."allowedActions"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
      AND task."status" = 'running' AND task."leaseOwner" = $5 AND task."interruptRequestedAt" IS NULL
      AND session."userId" = $6`,
  [input.owner.rootTaskId, input.owner.sessionId, input.owner.turnId, input.owner.rootTaskId, input.owner.ownerId, input.owner.userId])
  const currentPolicy = currentPolicyResult.rows[0]
  if (currentPolicyResult.rows.length !== 1 || !currentPolicy) throw new Error("question_planning_root_fenced")
  const currentActions = parseActions(currentPolicy.allowedActions)
  if (!currentActions) throw new Error("question_planning_root_policy_invalid")
  if (!currentActions.includes("agent.plan")) return null
  const stepResult = await client.query<Row>(`SELECT "taskId", "attempt", "status", "inputThroughSequence", "consumedInputIds"
    FROM "agent_steps" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4 FOR UPDATE`,
  [input.stepId, input.owner.sessionId, input.owner.turnId, input.owner.taskId])
  const step = stepResult.rows[0]
  const cursor = steeringReconciliationSequence(step?.inputThroughSequence)
  const ids = consumedIds(step?.consumedInputIds)
  if (stepResult.rows.length !== 1 || !step || step.taskId !== input.owner.rootTaskId || step.status !== "streaming"
    || Number(step.attempt) !== attempt || cursor === null || cursor !== state.decisionInputThroughSequence || !ids) {
    throw new Error("question_planning_checkpoint_invalid")
  }
  const receipt = parseTurnQuestionPlanningReceipt({
    schemaVersion: TURN_QUESTION_PLANNING_SCHEMA_VERSION,
    sessionId: input.owner.sessionId, turnId: input.owner.turnId, rootTaskId: input.owner.rootTaskId,
    stepId: input.stepId, toolCallId: input.toolCallId, waitId: input.waitId, questionItemId: input.questionItemId,
    observedPlanRevision: state.agendaPlanRevision, graphRevisionAtAsk: state.currentRevision,
    pendingSteers: state.unresolvedInputs.map(row => ({ ...row, acceptedSequence: row.acceptedSequence.toString() })),
    inputCheckpoint: { throughSequence: cursor.toString(), consumedInputIds: ids },
  })
  if (!receipt) throw new Error("question_planning_observation_invalid")
  return receipt
}

export async function appendTurnQuestionPlanningObservation(client: Queryable, receipt: TurnQuestionPlanningReceipt, userId: string): Promise<void> {
  const parsed = parseTurnQuestionPlanningReceipt(receipt)
  if (!parsed || !steeringReconciliationId(userId)) throw new Error("question_planning_observation_invalid")
  await appendTaskGraphReceipt(client, {
    scope: { userId, sessionId: parsed.sessionId, turnId: parsed.turnId,
      rootTaskId: parsed.rootTaskId, parentTaskId: parsed.rootTaskId, stepId: parsed.stepId },
    itemId: null, type: TURN_QUESTION_PLANNING_EVENT_TYPE,
    idempotencyKey: turnQuestionPlanningEventKey(parsed.turnId, parsed.waitId), payload: parsed,
    actor: "orchestrator", taskId: parsed.rootTaskId, outbox: false,
  })
}
