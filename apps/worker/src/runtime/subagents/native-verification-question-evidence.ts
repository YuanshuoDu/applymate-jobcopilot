import type pg from "pg"
import { Buffer } from "node:buffer"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { recoverAnsweredQuestionLineage, type QuestionAnswerLineage } from "../question-answer-recovery-lineage.js"
import { TurnQuestionStoreError } from "../turns/turn-question-contract.js"
import { completedQuestionResult, persistedUsage, questionId, questionItemId,
  type CompletedQuestionResult, type TurnQuestionStepRow } from "../turns/turn-question-store-guards.js"
import { NATIVE_VERIFICATION_PACKET_V2_MAX_BYTES, NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND,
  NATIVE_VERIFICATION_USER_SELF_ATTESTATION_REFERENCE_PREFIX, canonicalNativeVerificationJson,
  digestNativeVerificationValue, isNativeVerificationUserSelfAttestationReference,
  type NativeVerificationEvidence } from "./native-verification-contract.js"
import type { NativeVerificationPacketContent } from "./native-verification-pg-evidence.js"
import type { TaskGraphReadScope } from "./task-graph-command-port.js"

type Row = Record<string, unknown>
type Client = Pick<pg.PoolClient, "query">
const MAX_QUESTION_ROWS = 64
const MAX_PACKET_EVIDENCE = 32
const ANSWER_MAX_CHARS = 20_000

function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Row : null
}
function exactKeys(value: Row, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
}
function revision(value: unknown): value is number | string {
  return (typeof value === "number" || typeof value === "string") && Number.isSafeInteger(Number(value)) && Number(value) >= 0
}
function sameCanonical(left: unknown, right: unknown): boolean {
  try { return canonicalNativeVerificationJson(left) === canonicalNativeVerificationJson(right) } catch { return false }
}
function malformed(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("question_recovery_")
}

async function ownerFence(client: Client, scope: TaskGraphReadScope): Promise<TurnExecutionOwnerFence | null> {
  const result = await client.query<Row>(`SELECT turn."leaseOwnerId", turn."leaseVersion", turn."leaseExpiresAt",
      turn."leaseExpiresAt" > CURRENT_TIMESTAMP AS "leaseLive"
    FROM "agent_turns" AS turn JOIN "agent_sessions" AS session
      ON session."id" = turn."sessionId" AND session."userId" = turn."userId"
    WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 FOR SHARE OF turn`,
  [scope.turnId, scope.sessionId, scope.userId])
  const row = result.rows[0]
  if (result.rows.length !== 1 || row?.leaseOwnerId !== scope.turnLeaseOwner
    || Number(row.leaseVersion) !== scope.turnLeaseVersion || row.leaseLive !== true
    || !(row.leaseExpiresAt instanceof Date) || !Number.isFinite(row.leaseExpiresAt.getTime())) return null
  return { kind: "turn", userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    taskId: scope.rootTaskId, rootTaskId: scope.rootTaskId, ownerId: scope.turnLeaseOwner,
    leaseVersion: scope.turnLeaseVersion, leaseExpiresAt: row.leaseExpiresAt }
}

async function answeredLineage(client: Client, scope: TaskGraphReadScope): Promise<QuestionAnswerLineage[] | null> {
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
  [scope.sessionId, scope.turnId, scope.userId, scope.rootTaskId, MAX_QUESTION_ROWS + 1])
  if (candidates.rows.length > MAX_QUESTION_ROWS) return null
  const callIds: string[] = []
  for (const candidate of candidates.rows) {
    if (typeof candidate.toolCallId !== "string" || !candidate.toolCallId.trim()) return null
    if (!callIds.includes(candidate.toolCallId)) callIds.push(candidate.toolCallId)
  }
  const calls = callIds.length ? await client.query<Row>(`SELECT "id", "stepId", "taskId", "type", "content" FROM "agent_items"
    WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "type" = 'tool_call'
      AND "content"->>'toolCallId' = ANY($4::text[]) ORDER BY "createdAt", "id" LIMIT $5`,
  [scope.sessionId, scope.turnId, scope.rootTaskId, callIds, MAX_QUESTION_ROWS + 1]) : { rows: [] as Row[] }
  if (calls.rows.length > MAX_QUESTION_ROWS) return null
  const stepIds = [...new Set(calls.rows.map(row => typeof row.stepId === "string" ? row.stepId : "").filter(Boolean))]
  const steps = stepIds.length ? await client.query<Row>(`SELECT "id", "taskId" FROM "agent_steps"
    WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "id" = ANY($4::text[])
    ORDER BY "ordinal", "attempt" LIMIT $5`,
  [scope.sessionId, scope.turnId, scope.rootTaskId, stepIds, MAX_QUESTION_ROWS + 1]) : { rows: [] as Row[] }
  if (steps.rows.length > MAX_QUESTION_ROWS) return null
  try {
    return await recoverAnsweredQuestionLineage(client, {
      lease: { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId },
      rootTaskId: scope.rootTaskId, steps: steps.rows, toolItems: calls.rows, existingHistory: [], maxQuestions: MAX_QUESTION_ROWS, rootOnly: true,
    })
  } catch (error) { if (malformed(error)) return null; throw error }
}

async function sourceRows(client: Client, scope: TaskGraphReadScope, lineage: QuestionAnswerLineage,
  owner: TurnExecutionOwnerFence): Promise<{ readonly step: TurnQuestionStepRow; readonly call: Row; readonly result: Row; readonly receipt: CompletedQuestionResult } | null> {
  const stepResult = await client.query<TurnQuestionStepRow>(`SELECT "id", "taskId", "status", "attempt", "finishReason", "errorCode",
      "inputTokens", "outputTokens", "estimatedCostUsd" FROM "agent_steps"
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4 FOR SHARE`,
  [lineage.stepId, scope.sessionId, scope.turnId, scope.rootTaskId])
  const step = stepResult.rows[0]
  if (stepResult.rows.length !== 1 || !step || step.id !== lineage.stepId || step.taskId !== scope.rootTaskId
    || step.status !== "waiting_for_user" || Number(step.attempt) !== 1 || step.errorCode !== null) return null
  try { persistedUsage(step, ["waiting_for_user"]) } catch { return null }
  const rows = await client.query<Row>(`SELECT "id", "revision", "sessionId", "turnId", "stepId", "taskId", "type", "status", "content"
    FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "stepId" = $3 AND "taskId" = $4
      AND "type" IN ('tool_call', 'tool_result') AND "content"->>'toolCallId' = $5
    ORDER BY "type", "id" LIMIT 3 FOR SHARE`,
  [scope.sessionId, scope.turnId, lineage.stepId, scope.rootTaskId, lineage.toolCallId])
  if (rows.rows.length !== 2) return null
  const call = rows.rows.find(row => row.type === "tool_call"), result = rows.rows.find(row => row.type === "tool_result")
  if (!call || !result || call.status !== "completed" || result.status !== "completed"
    || !revision(call.revision) || !revision(result.revision)) return null
  let receipt: CompletedQuestionResult
  try { receipt = await completedQuestionResult(client, owner, lineage.stepId, lineage.toolCallId) }
  catch (error) { if (error instanceof TurnQuestionStoreError) return null; throw error }
  if (receipt.callItemId !== call.id || receipt.resultItemId !== result.id) return null
  return { step, call, result, receipt }
}

function validQuestion(lineage: QuestionAnswerLineage, scope: TaskGraphReadScope, owner: TurnExecutionOwnerFence,
  intent: Awaited<ReturnType<typeof completedQuestionResult>>["intent"]): boolean {
  const content = lineage.content, item = lineage.item
  const keys = ["waitKind", "questionId", "toolCallId", "stage", "question", "options", "answer", "answerAvailable"]
  const withAnsweredAt = [...keys, "answeredAt"]
  if (!exactKeys(content, Object.hasOwn(content, "answeredAt") ? withAnsweredAt : keys)
    || item.taskId !== scope.rootTaskId || item.status !== "completed" || item.type !== "question"
    || item.id !== questionItemId(lineage.questionId) || !revision(item.revision) || Number(item.revision) < 1
    || lineage.questionId !== questionId(owner, lineage.stepId, lineage.toolCallId)
    || content.questionId !== lineage.questionId || content.toolCallId !== lineage.toolCallId
    || content.waitKind !== "question" || content.stage !== "user_input" || content.answerAvailable !== true
    || typeof content.question !== "string" || content.question !== intent.question
    || typeof content.answer !== "string" || !content.answer.trim() || content.answer.trim() !== content.answer
    || content.answer.length > ANSWER_MAX_CHARS || !sameCanonical(content.options, intent.options)) return false
  return !Object.hasOwn(content, "answeredAt") || typeof content.answeredAt === "string"
    && Number.isFinite(Date.parse(content.answeredAt)) && new Date(content.answeredAt).toISOString() === content.answeredAt
}

function validEvents(lineage: QuestionAnswerLineage, scope: TaskGraphReadScope): boolean {
  const start = lineage.startedEvent, answer = lineage.answeredEvent
  const startPayload = record(start.payload), answerPayload = record(answer.payload)
  return typeof start.id === "string" && start.id.length > 0 && typeof answer.id === "string" && answer.id.length > 0
    && start.taskId === scope.rootTaskId && answer.taskId === null
    && start.idempotencyKey === `agent-wait:${lineage.item.id}:started`
    && typeof answer.idempotencyKey === "string" && answer.idempotencyKey.length > 0
    && !!startPayload && exactKeys(startPayload, ["itemId", "waitKind", "questionId", "toolCallId"])
    && startPayload.itemId === lineage.item.id && startPayload.waitKind === "question"
    && startPayload.questionId === lineage.questionId && startPayload.toolCallId === lineage.toolCallId
    && !!answerPayload && exactKeys(answerPayload, ["waitKind", "waitId", "itemId", "turnId", "toolCallId", "status", "nextTurnRevision", "answerAvailable"])
    && answerPayload.waitKind === "question" && answerPayload.waitId === lineage.questionId && answerPayload.itemId === lineage.item.id
    && answerPayload.turnId === scope.turnId && answerPayload.toolCallId === lineage.toolCallId
    && answerPayload.status === "answered" && answerPayload.answerAvailable === true
    && Number.isSafeInteger(answerPayload.nextTurnRevision) && Number(answerPayload.nextTurnRevision) > 0
}

function evidenceFor(lineage: QuestionAnswerLineage, source: { readonly step: TurnQuestionStepRow; readonly call: Row; readonly result: Row }): NativeVerificationEvidence | null {
  try {
    const binding = {
      owner: { userId: lineage.item.userId, sessionId: lineage.item.sessionId, turnId: lineage.item.turnId, taskId: lineage.item.taskId },
      item: { id: lineage.item.id, revision: lineage.item.revision, status: lineage.item.status, content: lineage.item.content },
      step: source.step,
      startedEvent: lineage.startedEvent,
      answeredEvent: lineage.answeredEvent,
      call: source.call,
      result: source.result,
    }
    const referenceId = NATIVE_VERIFICATION_USER_SELF_ATTESTATION_REFERENCE_PREFIX + digestNativeVerificationValue(binding)
    const summary = canonicalNativeVerificationJson({ kind: NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND, stage: "user_input",
      question: lineage.content.question, options: lineage.content.options, answer: lineage.content.answer })
    if (Buffer.byteLength(summary, "utf8") > NATIVE_VERIFICATION_PACKET_V2_MAX_BYTES) return null
    return { referenceId, kind: NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND, summary }
  } catch { return null }
}

/** Appends only complete, server-rederived root user-input answers; never clips an answer. */
export async function appendNativeQuestionSelfAttestations(
  client: Client, scope: TaskGraphReadScope, content: NativeVerificationPacketContent,
): Promise<NativeVerificationPacketContent | null> {
  if (content.target.kind !== "root_goal" || scope.parentTaskId !== scope.rootTaskId
    || content.evidence.some(item => item.kind === NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND
      || isNativeVerificationUserSelfAttestationReference(item.referenceId))) return null
  const lineages = await answeredLineage(client, scope)
  if (!lineages) return null
  const selected = lineages
  if (selected.length === 0) return content
  if (selected.length > MAX_PACKET_EVIDENCE - content.evidence.length) return null
  const owner = await ownerFence(client, scope)
  if (!owner) return null
  const additions: NativeVerificationEvidence[] = []
  for (const lineage of selected) {
    if (!validEvents(lineage, scope)) return null
    const source = await sourceRows(client, scope, lineage, owner)
    if (!source || !validQuestion(lineage, scope, owner, source.receipt.intent)) return null
    const evidence = evidenceFor(lineage, source)
    if (!evidence) return null
    additions.push(evidence)
  }
  const result = { ...content, evidence: [...content.evidence, ...additions] }
  try { if (Buffer.byteLength(canonicalNativeVerificationJson(result), "utf8") > NATIVE_VERIFICATION_PACKET_V2_MAX_BYTES) return null }
  catch { return null }
  return result
}
