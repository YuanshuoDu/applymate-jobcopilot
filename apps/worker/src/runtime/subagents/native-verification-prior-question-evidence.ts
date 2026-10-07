import type pg from "pg"
import { Buffer } from "node:buffer"
import { NATIVE_VERIFICATION_PACKET_V2_MAX_BYTES, canonicalNativeVerificationJson,
  type NativeVerificationEvidence } from "./native-verification-contract.js"
import { readNativeVerificationQuestionSource, type NativeVerificationLiveQuestionTurn } from "./native-verification-question-source.js"
import type { NativeVerificationPacketContent } from "./native-verification-pg-evidence.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
const MAX_PRIOR_TURNS = 64
const MAX_PRIOR_ROOTS = 8
const MAX_QUESTIONS_PER_ROOT = 16
const MAX_PRIOR_PAIRS = 16
const MAX_PRIOR_BYTES = 64 * 1024
const MAX_PACKET_EVIDENCE = 32

function validDate(value: unknown): value is Date { return value instanceof Date && Number.isFinite(value.getTime()) }
function validId(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 }

/** Adds bounded, DB-rederived prior root answers after protected current evidence. */
export async function appendNativePriorQuestionSelfAttestations(
  client: Client, current: NativeVerificationLiveQuestionTurn, content: NativeVerificationPacketContent,
): Promise<NativeVerificationPacketContent | null> {
  if (content.target.kind !== "root_goal") return content
  try { if (Buffer.byteLength(canonicalNativeVerificationJson(content), "utf8") > NATIVE_VERIFICATION_PACKET_V2_MAX_BYTES) return null }
  catch { return null }
  if (content.evidence.length >= MAX_PACKET_EVIDENCE) return content
  const turns = await client.query<Row>(`WITH prior_window AS (
      SELECT turn."id", turn."sessionId", turn."rootTaskId", turn."createdAt"
      FROM "agent_turns" AS turn JOIN "agent_sessions" AS session
        ON session."id" = turn."sessionId" AND session."userId" = turn."userId"
      WHERE turn."userId" = $2 AND turn."sessionId" = $1 AND turn."id" <> $3 AND turn."createdAt" < $4
        AND turn."status" = 'completed' AND turn."completedAt" IS NOT NULL
        AND turn."leaseOwnerId" IS NULL AND turn."leaseStartedAt" IS NULL AND turn."leaseExpiresAt" IS NULL
      ORDER BY turn."createdAt" DESC, turn."id" DESC LIMIT $5
    )
    SELECT prior."id", prior."createdAt", root."id" AS "rootTaskId"
    FROM prior_window AS prior
    JOIN "sub_agent_tasks" AS root ON root."id" = prior."rootTaskId" AND root."sessionId" = prior."sessionId"
      AND root."turnId" = prior."id" AND root."rootTaskId" = root."id" AND root."parentTaskId" IS NULL
    WHERE EXISTS (SELECT 1 FROM "agent_items" AS question
      WHERE question."sessionId" = prior."sessionId" AND question."turnId" = prior."id"
        AND question."taskId" = root."id" AND question."type" = 'question' AND question."content"->>'stage' = 'user_input'
        AND (question."status" = 'completed' OR question."content"->>'answerAvailable' = 'true'
          OR question."content"->>'answer' IS NOT NULL OR EXISTS (SELECT 1 FROM "agent_events" AS answered
            WHERE answered."sessionId" = question."sessionId" AND answered."turnId" = question."turnId"
              AND answered."itemId" = question."id" AND answered."type" = 'question.answered'
              AND (answered."taskId" IS NULL OR answered."taskId" = root."id"))
        ) AND EXISTS (SELECT 1 FROM "agent_items" AS ask_call
          WHERE ask_call."sessionId" = question."sessionId" AND ask_call."turnId" = question."turnId"
            AND ask_call."taskId" = root."id" AND ask_call."type" = 'tool_call' AND ask_call."status" = 'completed'
            AND ask_call."content"->>'toolName' = 'agent.ask_user' AND ask_call."content"->>'toolVersion' = '1'
            AND ask_call."content"->>'status' = 'completed' AND ask_call."content"->'errorCode' = 'null'::jsonb
            AND ask_call."content"->>'toolCallId' = question."content"->>'toolCallId'))
    ORDER BY prior."createdAt" DESC, prior."id" DESC LIMIT $6`,
  [current.identity.sessionId, current.identity.userId, current.identity.turnId, current.createdAt, MAX_PRIOR_TURNS, MAX_PRIOR_ROOTS])
  const selected: NativeVerificationEvidence[] = []
  let evidenceBytes = 0
  for (const row of turns.rows.slice(0, MAX_PRIOR_ROOTS)) {
    if (selected.length >= MAX_PRIOR_PAIRS) break
    if (!validId(row.id) || !validId(row.rootTaskId) || !validDate(row.createdAt) || row.createdAt >= current.createdAt) continue
    const source = await readNativeVerificationQuestionSource(client, {
      userId: current.identity.userId, sessionId: current.identity.sessionId, turnId: row.id, rootTaskId: row.rootTaskId,
    }, MAX_QUESTIONS_PER_ROOT)
    if (!source || source.length === 0) continue
    for (const pair of [...source].reverse()) {
      if (selected.length >= MAX_PRIOR_PAIRS || content.evidence.length + selected.length >= MAX_PACKET_EVIDENCE) break
      let pairBytes: number
      try { pairBytes = Buffer.byteLength(canonicalNativeVerificationJson(pair), "utf8") }
      catch { return null }
      let candidateBytes: number
      try {
        candidateBytes = Buffer.byteLength(canonicalNativeVerificationJson({ ...content, evidence: [...content.evidence, ...selected, pair] }), "utf8")
      } catch (error) {
        if (error instanceof TypeError && error.message === "native_verification_value_too_large") continue
        return null
      }
      if (evidenceBytes + pairBytes > MAX_PRIOR_BYTES || candidateBytes > NATIVE_VERIFICATION_PACKET_V2_MAX_BYTES) continue
      selected.push(pair)
      evidenceBytes += pairBytes
    }
  }
  return selected.length === 0 ? content : { ...content, evidence: [...content.evidence, ...selected] }
}
