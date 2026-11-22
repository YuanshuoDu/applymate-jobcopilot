import type { PoolClient } from "pg"
import type { AgentArtifactTaskFence } from "./agent-artifact-repo-helpers.js"

type QueryClient = Pick<PoolClient, "query">
type ResumeInput = Readonly<{
  taskFence: AgentArtifactTaskFence
  jobId: string
  artifactId: string
  predecessorVersion: number
  predecessorContentHash: string
  sourceDigest: string
  liveHeadVersion: number
  liveHeadHash: string
}>
type Row = Record<string, unknown>

const EXACT_RECEIPT = `SELECT version_row."artifactId" AS "artifactId", version_row."version" AS "version",
    version_row."userId" AS "userId", version_row."sessionId" AS "sessionId", version_row."jobId" AS "jobId",
    version_row."artifactType" AS "artifactType", version_row."contentHash" AS "contentHash",
    version_row."sourceDigest" AS "sourceDigest", version_row."previousHash" AS "previousHash",
    version_row."baseId" AS "baseId", version_row."baseHash" AS "baseHash",
    version_row."taskId" AS "taskId", version_row."toolCallId" AS "toolCallId",
    session."userId" AS "sessionUserId", task."sessionId" AS "taskSessionId", task."turnId" AS "taskTurnId",
    task."rootTaskId" AS "taskRootTaskId", task."parentTaskId" AS "taskParentTaskId", task."role" AS "taskRole",
    task."taskType" AS "taskType", task."status" AS "taskStatus", task."leaseOwner" AS "taskLeaseOwner",
    task."attemptCount" AS "taskAttemptCount", task."interruptRequestedAt" AS "taskInterruptRequestedAt",
    task."leaseExpiresAt">clock_timestamp() AS "taskLeaseLive",
    draft."version" AS "headVersion", draft."hash" AS "headHash",
    call_step."id" AS "callStepId", call_step."attempt" AS "callAttempt",
    result_step."id" AS "resultStepId", result_step."attempt" AS "resultAttempt",
    call_item."id" AS "callItemId", call_item."revision" AS "callRevision", call_item."status" AS "callItemStatus",
    call_item."content"->>'toolCallId' AS "callToolCallId", call_item."content"->>'toolName' AS "callToolName",
    call_item."content"->>'status' AS "callStatus", call_item."content"->'errorCode' AS "callErrorCode",
    call_item."content" ? 'input' AS "callInputPresent",
    call_item."content"->'input'->>'baseArtifactId' AS "callBaseId",
    call_item."content"->'input'->>'baseHash' AS "callBaseHash",
    result_item."id" AS "resultItemId", result_item."revision" AS "resultRevision", result_item."status" AS "resultItemStatus",
    result_item."content"->>'toolCallId' AS "resultToolCallId", result_item."content" ? 'errorCode' AS "resultHasErrorCode",
    result_item."content"->'errorCode' AS "resultErrorCode",
    result_item."content"->'output'->'artifactRef' AS "resultArtifactRef"
  FROM "agent_artifact_version" AS version_row
  JOIN "agent_artifact" AS draft ON draft."id"=version_row."artifactId" AND draft."userId"=version_row."userId"
    AND draft."jobId"=version_row."jobId" AND draft."artifactType"=version_row."artifactType"
    AND draft."lifecycle"='draft' AND draft."version"=version_row."version" AND draft."hash"=version_row."contentHash"
  JOIN "agent_artifact_version" AS predecessor ON predecessor."artifactId"=version_row."artifactId"
    AND predecessor."userId"=version_row."userId" AND predecessor."sessionId"=version_row."sessionId"
    AND predecessor."jobId"=version_row."jobId" AND predecessor."artifactType"='cover_letter'
    AND predecessor."version"=$11 AND predecessor."contentHash"=$12 AND predecessor."sourceDigest"=$13
    AND predecessor."baseId"=version_row."baseId" AND predecessor."baseHash"=version_row."baseHash"
  JOIN "sub_agent_tasks" AS task ON task."id"=version_row."taskId" AND task."sessionId"=version_row."sessionId"
    AND task."turnId"=$4 AND task."rootTaskId"=$5 AND task."parentTaskId" IS NOT DISTINCT FROM $6
  JOIN "agent_sessions" AS session ON session."id"=task."sessionId" AND session."userId"=version_row."userId"
  JOIN "agent_turns" AS turn ON turn."id"=task."turnId" AND turn."sessionId"=task."sessionId" AND turn."userId"=session."userId"
  JOIN "sub_agent_tasks" AS root ON root."id"=task."rootTaskId" AND root."sessionId"=task."sessionId"
    AND root."turnId"=task."turnId" AND root."rootTaskId"=root."id"
  JOIN "agent_items" AS call_item ON call_item."sessionId"=task."sessionId" AND call_item."turnId"=task."turnId"
    AND call_item."taskId"=task."id" AND call_item."type"='tool_call'
    AND call_item."content"->>'toolCallId'=version_row."toolCallId"
  JOIN "agent_steps" AS call_step ON call_step."id"=call_item."stepId" AND call_step."sessionId"=task."sessionId"
    AND call_step."turnId"=task."turnId" AND call_step."taskId"=task."id"
    AND call_step."attempt">=1 AND call_step."attempt"<$8
  JOIN "agent_items" AS result_item ON result_item."sessionId"=task."sessionId" AND result_item."turnId"=task."turnId"
    AND result_item."taskId"=task."id" AND result_item."type"='tool_result'
    AND result_item."content"->>'toolCallId'=version_row."toolCallId"
  JOIN "agent_steps" AS result_step ON result_step."id"=result_item."stepId" AND result_step."sessionId"=task."sessionId"
    AND result_step."turnId"=task."turnId" AND result_step."taskId"=task."id" AND result_step."attempt"=call_step."attempt"
  WHERE version_row."taskId"=$1 AND version_row."userId"=$2 AND version_row."sessionId"=$3
    AND version_row."jobId"=$9 AND version_row."artifactId"=$10 AND version_row."version"=$11+1
    AND version_row."artifactType"='cover_letter' AND version_row."sourceDigest"=$13 AND version_row."previousHash"=$12
    AND task."role"='writer' AND task."taskType"='cover_letter_draft' AND task."status"='running'
    AND task."leaseOwner"=$7 AND task."attemptCount"=$8 AND task."interruptRequestedAt" IS NULL
    AND task."leaseExpiresAt">clock_timestamp() AND turn."status" NOT IN ('completed','failed','interrupted','cancelled')
    AND draft."version"=$14 AND draft."hash"=$15
  LIMIT 2`

/** Proves a current head is the exact committed successor of this resumed Writer's earlier draft call. */
export async function hasExactCorrectionDraftResumeReceiptWithClient(client: QueryClient, input: ResumeInput): Promise<boolean> {
  const fence = input.taskFence
  if (![fence.taskId, fence.userId, fence.sessionId, fence.turnId, fence.rootTaskId, fence.leaseOwner,
    input.jobId, input.artifactId, input.predecessorContentHash, input.sourceDigest, input.liveHeadHash]
    .every(value => typeof value === "string" && value.trim().length > 0)
    || !Number.isSafeInteger(fence.attemptCount) || fence.attemptCount < 2
    || !Number.isSafeInteger(input.predecessorVersion) || input.predecessorVersion < 1
    || input.liveHeadVersion !== input.predecessorVersion + 1) return false
  const result = await client.query<Row>(EXACT_RECEIPT, [fence.taskId, fence.userId, fence.sessionId, fence.turnId,
    fence.rootTaskId, fence.parentTaskId, fence.leaseOwner, fence.attemptCount, input.jobId, input.artifactId,
    input.predecessorVersion, input.predecessorContentHash, input.sourceDigest, input.liveHeadVersion, input.liveHeadHash])
  return result.rows.length === 1 && exactRow(result.rows[0], input)
}

function exactRow(value: Row | undefined, input: ResumeInput): boolean {
  if (!value) return false
  const fence = input.taskFence
  if (value.artifactId !== input.artifactId || value.version !== input.liveHeadVersion || value.userId !== fence.userId
    || value.sessionId !== fence.sessionId || value.jobId !== input.jobId || value.artifactType !== "cover_letter"
    || value.contentHash !== input.liveHeadHash || value.sourceDigest !== input.sourceDigest || value.previousHash !== input.predecessorContentHash
    || value.taskId !== fence.taskId || value.headVersion !== input.liveHeadVersion || value.headHash !== input.liveHeadHash
    || value.sessionUserId !== fence.userId || value.taskSessionId !== fence.sessionId || value.taskTurnId !== fence.turnId
    || value.taskRootTaskId !== fence.rootTaskId || value.taskParentTaskId !== fence.parentTaskId || value.taskRole !== "writer"
    || value.taskType !== "cover_letter_draft" || value.taskStatus !== "running" || value.taskLeaseOwner !== fence.leaseOwner
    || value.taskAttemptCount !== fence.attemptCount || value.taskInterruptRequestedAt !== null || value.taskLeaseLive !== true
    || !validText(value.toolCallId) || !validText(value.baseId) || !validText(value.baseHash)
    || !validText(value.callStepId) || !validText(value.callItemId) || !validText(value.resultItemId)
    || value.callStepId !== value.resultStepId
    || !Number.isSafeInteger(value.callAttempt) || value.callAttempt !== value.resultAttempt
    || Number(value.callAttempt) < 1 || Number(value.callAttempt) >= fence.attemptCount || value.callItemId === value.resultItemId
    || !validRevision(value.callRevision) || !validRevision(value.resultRevision)
    || value.callItemStatus !== "completed" || value.callToolCallId !== value.toolCallId || value.callToolName !== "cover_letter.draft"
    || value.callStatus !== "completed" || value.callErrorCode !== null || value.callInputPresent !== true
    || value.callBaseId !== value.baseId || value.callBaseHash !== value.baseHash
    || value.resultItemStatus !== "completed" || value.resultToolCallId !== value.toolCallId
    || value.resultHasErrorCode !== true || value.resultErrorCode !== null) return false
  return exactArtifactReference(value.resultArtifactRef, input)
}

function exactArtifactReference(value: unknown, input: ResumeInput): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const ref = value as Record<string, unknown>
  return Object.keys(ref).sort().join(",") === "artifactId,contentHash,sourceDigest,version"
    && ref.artifactId === input.artifactId && ref.version === input.liveHeadVersion
    && ref.contentHash === input.liveHeadHash && ref.sourceDigest === input.sourceDigest
}

function validRevision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function validText(value: unknown): value is string { return typeof value === "string" && value.length <= 256 && value.trim().length > 0 }
