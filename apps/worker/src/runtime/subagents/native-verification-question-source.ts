import type pg from "pg"
import { Buffer } from "node:buffer"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { recoverAnsweredQuestionLineage, type QuestionAnswerLineage } from "../question-answer-recovery-lineage.js"
import { TurnQuestionStoreError } from "../turns/turn-question-contract.js"
import { completedQuestionResult, persistedUsage, questionId, questionItemId,
  type CompletedQuestionResult, type TurnQuestionReadIdentity, type TurnQuestionStepRow } from "../turns/turn-question-store-guards.js"
import { NATIVE_VERIFICATION_PACKET_V2_MAX_BYTES, NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND,
  NATIVE_VERIFICATION_USER_SELF_ATTESTATION_REFERENCE_PREFIX, canonicalNativeVerificationJson,
  digestNativeVerificationValue, type NativeVerificationEvidence } from "./native-verification-contract.js"
import type { TaskGraphReadScope } from "./task-graph-command-port.js"

type Row = Record<string, unknown>
type Client = Pick<pg.PoolClient, "query">
export type NativeVerificationQuestionIdentity = Readonly<{ userId: string; sessionId: string; turnId: string; rootTaskId: string }>
export type NativeVerificationLiveQuestionTurn = Readonly<{
  identity: NativeVerificationQuestionIdentity
  owner: TurnExecutionOwnerFence
  createdAt: Date
}>

function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Row : null
}
function exactKeys(value: Row, keys: readonly string[]): boolean { return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0") }
function revision(value: unknown): value is number | string {
  return (typeof value === "number" || typeof value === "string") && Number.isSafeInteger(Number(value)) && Number(value) >= 0
}
function sameCanonical(left: unknown, right: unknown): boolean {
  try { return canonicalNativeVerificationJson(left) === canonicalNativeVerificationJson(right) } catch { return false }
}
const RECOVERY_ERRORS = new Set([
  "question_recovery_sequence_invalid", "question_recovery_item_scope_invalid", "question_recovery_tool_lineage_invalid",
  "question_recovery_step_invalid", "question_recovery_step_missing", "question_recovery_history_duplicate",
  "question_recovery_history_collision", "question_recovery_history_order_invalid", "question_recovery_history_pair_incomplete",
  "question_recovery_start_lineage_invalid", "question_recovery_answer_lineage_invalid", "question_recovery_history_limit",
  "question_recovery_item_id_invalid", "question_recovery_event_history_limit", "question_recovery_item_malformed",
  "question_recovery_answer_event_ambiguous", "question_recovery_start_event_ambiguous", "question_recovery_event_scope_invalid",
])
function malformed(error: unknown): boolean {
  return error instanceof Error && RECOVERY_ERRORS.has(error.message)
    && !("code" in error) && !("severity" in error) && !("detail" in error)
}

export async function readNativeVerificationLiveQuestionTurn(client: Client, scope: TaskGraphReadScope): Promise<NativeVerificationLiveQuestionTurn | null> {
  if (scope.parentTaskId !== scope.rootTaskId) return null
  const result = await client.query<Row>(`SELECT turn."leaseOwnerId", turn."leaseVersion", turn."leaseExpiresAt", turn."createdAt",
      turn."leaseExpiresAt" > CURRENT_TIMESTAMP AS "leaseLive"
    FROM "agent_turns" AS turn JOIN "agent_sessions" AS session
      ON session."id" = turn."sessionId" AND session."userId" = turn."userId"
    WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND turn."rootTaskId" = $4
      AND turn."status" = 'in_progress' FOR SHARE OF turn`,
  [scope.turnId, scope.sessionId, scope.userId, scope.rootTaskId])
  const row = result.rows[0], createdAt = row?.createdAt
  if (result.rows.length !== 1 || row?.leaseOwnerId !== scope.turnLeaseOwner
    || Number(row.leaseVersion) !== scope.turnLeaseVersion || row.leaseLive !== true
    || !(row.leaseExpiresAt instanceof Date) || !Number.isFinite(row.leaseExpiresAt.getTime())
    || !(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime())) return null
  const identity = { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId }
  const owner: TurnExecutionOwnerFence = { kind: "turn", userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    taskId: scope.rootTaskId, rootTaskId: scope.rootTaskId, ownerId: scope.turnLeaseOwner,
    leaseVersion: scope.turnLeaseVersion, leaseExpiresAt: row.leaseExpiresAt }
  return { identity, owner, createdAt }
}

async function answeredLineage(client: Client, identity: NativeVerificationQuestionIdentity, maxQuestions: number): Promise<QuestionAnswerLineage[] | null> {
  const limit = maxQuestions + 1
  const candidates = await client.query<Row>(`SELECT item."id", item."content"->>'toolCallId' AS "toolCallId"
    FROM "agent_items" AS item JOIN "agent_sessions" AS session
      ON session."id" = item."sessionId" AND session."userId" = $3
    JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId" AND turn."userId" = $3
    WHERE item."sessionId" = $1 AND item."turnId" = $2 AND item."taskId" = $4 AND item."type" = 'question'
      AND (item."status" = 'completed' OR item."content"->>'answerAvailable' = 'true' OR item."content"->>'answer' IS NOT NULL
        OR EXISTS (SELECT 1 FROM "agent_events" AS answer_event WHERE answer_event."sessionId" = item."sessionId"
          AND answer_event."turnId" = item."turnId" AND answer_event."itemId" = item."id"
          AND answer_event."type" = 'question.answered' AND (answer_event."taskId" IS NULL OR answer_event."taskId" = item."taskId")))
      AND (item."content"->>'stage' = 'user_input' OR EXISTS (SELECT 1 FROM "agent_items" AS ask_call WHERE ask_call."sessionId" = item."sessionId"
        AND ask_call."turnId" = item."turnId" AND ask_call."taskId" = item."taskId" AND ask_call."type" = 'tool_call'
        AND ask_call."content"->>'toolName' = 'agent.ask_user' AND ask_call."content"->>'toolCallId' = item."content"->>'toolCallId'))
    ORDER BY item."createdAt", item."id" LIMIT $5`,
  [identity.sessionId, identity.turnId, identity.userId, identity.rootTaskId, limit])
  if (candidates.rows.length > maxQuestions) return null
  const callIds: string[] = []
  for (const row of candidates.rows) {
    if (typeof row.toolCallId !== "string" || !row.toolCallId.trim()) return null
    if (!callIds.includes(row.toolCallId)) callIds.push(row.toolCallId)
  }
  const calls = callIds.length ? await client.query<Row>(`SELECT "id", "stepId", "taskId", "type", "content" FROM "agent_items"
    WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "type" = 'tool_call'
      AND "content"->>'toolCallId' = ANY($4::text[]) ORDER BY "createdAt", "id" LIMIT $5`,
  [identity.sessionId, identity.turnId, identity.rootTaskId, callIds, limit]) : { rows: [] as Row[] }
  if (calls.rows.length > maxQuestions) return null
  const stepIds = [...new Set(calls.rows.map(row => typeof row.stepId === "string" ? row.stepId : "").filter(Boolean))]
  const steps = stepIds.length ? await client.query<Row>(`SELECT "id", "taskId" FROM "agent_steps"
    WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "id" = ANY($4::text[])
    ORDER BY "ordinal", "attempt" LIMIT $5`, [identity.sessionId, identity.turnId, identity.rootTaskId, stepIds, limit]) : { rows: [] as Row[] }
  if (steps.rows.length > maxQuestions) return null
  try {
    return await recoverAnsweredQuestionLineage(client, { lease: identity, rootTaskId: identity.rootTaskId,
      steps: steps.rows, toolItems: calls.rows, existingHistory: [], maxQuestions, rootOnly: true })
  } catch (error) { if (malformed(error)) return null; throw error }
}

async function sourceRows(client: Client, identity: NativeVerificationQuestionIdentity, lineage: QuestionAnswerLineage): Promise<{
  step: TurnQuestionStepRow; call: Row; result: Row; receipt: CompletedQuestionResult
} | null> {
  const stepResult = await client.query<TurnQuestionStepRow>(`SELECT "id", "taskId", "status", "attempt", "finishReason", "errorCode",
      "inputTokens", "outputTokens", "estimatedCostUsd" FROM "agent_steps"
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4 FOR SHARE`,
  [lineage.stepId, identity.sessionId, identity.turnId, identity.rootTaskId])
  const step = stepResult.rows[0]
  if (stepResult.rows.length !== 1 || !step || step.id !== lineage.stepId || step.taskId !== identity.rootTaskId
    || step.status !== "waiting_for_user" || Number(step.attempt) !== 1 || step.errorCode !== null) return null
  try { persistedUsage(step, ["waiting_for_user"]) } catch { return null }
  const rows = await client.query<Row>(`SELECT "id", "revision", "sessionId", "turnId", "stepId", "taskId", "type", "status", "content"
    FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "stepId" = $3 AND "taskId" = $4
      AND "type" IN ('tool_call', 'tool_result') AND "content"->>'toolCallId' = $5
    ORDER BY "type", "id" LIMIT 3 FOR SHARE`,
  [identity.sessionId, identity.turnId, lineage.stepId, identity.rootTaskId, lineage.toolCallId])
  if (rows.rows.length !== 2) return null
  const call = rows.rows.find(row => row.type === "tool_call"), result = rows.rows.find(row => row.type === "tool_result")
  if (!call || !result || call.status !== "completed" || result.status !== "completed"
    || !revision(call.revision) || !revision(result.revision)) return null
  const readIdentity: TurnQuestionReadIdentity = { sessionId: identity.sessionId, turnId: identity.turnId, taskId: identity.rootTaskId }
  let receipt: CompletedQuestionResult
  try { receipt = await completedQuestionResult(client, readIdentity, lineage.stepId, lineage.toolCallId) }
  catch (error) { if (error instanceof TurnQuestionStoreError) return null; throw error }
  if (receipt.callItemId !== call.id || receipt.resultItemId !== result.id) return null
  return { step, call, result, receipt }
}

function validQuestion(lineage: QuestionAnswerLineage, identity: NativeVerificationQuestionIdentity,
  intent: CompletedQuestionResult["intent"]): boolean {
  const content = lineage.content, item = lineage.item
  const keys = ["waitKind", "questionId", "toolCallId", "stage", "question", "options", "answer", "answerAvailable"]
  const withAnsweredAt = [...keys, "answeredAt"]
  if (!exactKeys(content, Object.hasOwn(content, "answeredAt") ? withAnsweredAt : keys)
    || item.taskId !== identity.rootTaskId || item.status !== "completed" || item.type !== "question"
    || item.id !== questionItemId(lineage.questionId) || !revision(item.revision) || Number(item.revision) < 1
    || lineage.questionId !== questionId(identity, lineage.stepId, lineage.toolCallId)
    || content.questionId !== lineage.questionId || content.toolCallId !== lineage.toolCallId
    || content.waitKind !== "question" || content.stage !== "user_input" || content.answerAvailable !== true
    || typeof content.question !== "string" || content.question !== intent.question
    || typeof content.answer !== "string" || !content.answer.trim() || content.answer.trim() !== content.answer
    || content.answer.length > 20_000 || !sameCanonical(content.options, intent.options)) return false
  return !Object.hasOwn(content, "answeredAt") || typeof content.answeredAt === "string"
    && Number.isFinite(Date.parse(content.answeredAt)) && new Date(content.answeredAt).toISOString() === content.answeredAt
}

function validEvents(lineage: QuestionAnswerLineage, identity: NativeVerificationQuestionIdentity): boolean {
  const start = lineage.startedEvent, answer = lineage.answeredEvent
  const startPayload = record(start.payload), answerPayload = record(answer.payload)
  return typeof start.id === "string" && start.id.length > 0 && typeof answer.id === "string" && answer.id.length > 0
    && start.taskId === identity.rootTaskId && answer.taskId === null
    && start.idempotencyKey === `agent-wait:${lineage.item.id}:started`
    && typeof answer.idempotencyKey === "string" && answer.idempotencyKey.length > 0
    && !!startPayload && exactKeys(startPayload, ["itemId", "waitKind", "questionId", "toolCallId"])
    && startPayload.itemId === lineage.item.id && startPayload.waitKind === "question"
    && startPayload.questionId === lineage.questionId && startPayload.toolCallId === lineage.toolCallId
    && !!answerPayload && exactKeys(answerPayload, ["waitKind", "waitId", "itemId", "turnId", "toolCallId", "status", "nextTurnRevision", "answerAvailable"])
    && answerPayload.waitKind === "question" && answerPayload.waitId === lineage.questionId && answerPayload.itemId === lineage.item.id
    && answerPayload.turnId === identity.turnId && answerPayload.toolCallId === lineage.toolCallId
    && answerPayload.status === "answered" && answerPayload.answerAvailable === true
    && Number.isSafeInteger(answerPayload.nextTurnRevision) && Number(answerPayload.nextTurnRevision) > 0
}

export async function readNativeVerificationQuestionSource(
  client: Client, identity: NativeVerificationQuestionIdentity, maxQuestions: number,
  context?: { readonly turnRelation: "earlier_turn" },
): Promise<readonly NativeVerificationEvidence[] | null> {
  if (!Number.isSafeInteger(maxQuestions) || maxQuestions < 1 || maxQuestions > 64) return null
  const lineages = await answeredLineage(client, identity, maxQuestions)
  if (!lineages) return null
  const evidence: NativeVerificationEvidence[] = []
  for (const lineage of lineages) {
    if (!validEvents(lineage, identity)) return null
    const source = await sourceRows(client, identity, lineage)
    if (!source || !validQuestion(lineage, identity, source.receipt.intent)) return null
    try {
      const binding = { owner: { userId: lineage.item.userId, sessionId: lineage.item.sessionId,
        turnId: lineage.item.turnId, taskId: lineage.item.taskId },
        item: { id: lineage.item.id, revision: lineage.item.revision, status: lineage.item.status, content: lineage.item.content },
        step: source.step, startedEvent: lineage.startedEvent, answeredEvent: lineage.answeredEvent, call: source.call, result: source.result,
        ...(context ? { context: { statementSource: "user_statement", turnRelation: context.turnRelation } } : {}) }
      const referenceId = NATIVE_VERIFICATION_USER_SELF_ATTESTATION_REFERENCE_PREFIX + digestNativeVerificationValue(binding)
      const summary = canonicalNativeVerificationJson({ kind: NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND,
        ...(context ? { statementSource: "user_statement", turnRelation: context.turnRelation } : {}), stage: "user_input",
        question: lineage.content.question, options: lineage.content.options, answer: lineage.content.answer })
      if (Buffer.byteLength(summary, "utf8") > NATIVE_VERIFICATION_PACKET_V2_MAX_BYTES) return null
      evidence.push({ referenceId, kind: NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND, summary })
    } catch { return null }
  }
  return evidence
}
