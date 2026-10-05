import type { TenantScope } from "@jobcopilot/agent-protocol"

import { parseSnapshotContent } from "./context-snapshot-canonical.js"
import { canonicalJson, sha256Hex, type CanonicalJsonValue } from "./context-compaction-canonical.js"
import type { CompactionAnswer, CompactionArtifact, CompactionFact, CompactionInputItem, CompactionOpenTask, CompactionSource, CompactionState } from "./context-compaction-types.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import type { TaskGraphCommandPort, TaskGraphCurrentState, TaskGraphReadScope } from "../subagents/task-graph-command-port.js"
import { createPgTaskGraphCommandPort } from "../subagents/pg-task-graph-command-port.js"
import { projectSelectedJobMemory, mergeSelectedJobMemories, parseSelectedJobMemories } from "./selected-job-memory.js"
import {
  assertCompactionScope, isRecord, latestCompactionSnapshot, withCompactionOwner,
  type CompactionPgClient, type CompactionPgPool, type CompactionPgRow,
} from "./context-compaction-pg-store.js"

export type CompactionSourcePort = {
  load(input: { readonly scope: TenantScope; readonly owner: TurnExecutionOwnerFence }): Promise<CompactionSource | null>
}

type StoredCompactionState = Partial<CompactionState> & { readonly throughSequence?: bigint | string }
type InputRow = { id: string; targetTurnId: string | null; acceptedSequence: bigint | string; content: unknown }

function text(value: unknown, fallback: string): string { return typeof value === "string" && value.trim() ? value : fallback }
function sequence(value: unknown): bigint {
  try { const result = BigInt(value as string | number | bigint); return result >= 0n ? result : 0n } catch { return 0n }
}
function previousState(content: unknown): StoredCompactionState | null {
  if (!isRecord(content) || !isRecord(content.compaction) || !isRecord(content.compaction.state)) return null
  const value = content.compaction.state
  return { ...value, throughSequence: sequence(value.throughSequence) } as StoredCompactionState
}
function previousNarrativeSummary(content: unknown): string | null {
  if (!isRecord(content) || !isRecord(content.compaction)) return null
  const summary = content.compaction.narrativeSummary
  return typeof summary === "string" && summary.trim() ? summary.trim() : null
}
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [] }
function records<T>(value: unknown): T[] { return Array.isArray(value) ? value.filter(isRecord) as T[] : [] }
function selectedJobId(value: unknown): string | undefined {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!isRecord(parsed) || !isRecord(parsed.selectedJobPreparation)) return undefined
  const selection = parsed.selectedJobPreparation
  return Object.keys(selection).length === 1 && typeof selection.jobId === "string" && selection.jobId.trim() === selection.jobId
    && selection.jobId.length > 0 && selection.jobId.length <= 256 ? selection.jobId : undefined
}
function answerValue(input: InputRow): CompactionAnswer {
  const value = input.content
  const answer = typeof value === "string" ? value : isRecord(value) && typeof value.answer === "string" ? value.answer
    : isRecord(value) && typeof value.text === "string" ? value.text : canonicalJson(value as CanonicalJsonValue)
  return { id: `input:${input.id}`, question: "User input", answer, answerHash: sha256Hex(value) }
}
function mergeById<T extends { readonly id: string }>(previous: readonly T[], current: readonly T[]): T[] {
  const result = new Map(previous.map(value => [value.id, value]))
  for (const value of current) result.set(value.id, value)
  return [...result.values()].sort((left, right) => left.id.localeCompare(right.id))
}
function stateFrom(input: {
  readonly userId: string; readonly sessionId: string; readonly goal: string; readonly cursor: bigint; readonly previous: StoredCompactionState | null
  readonly snapshotContent: unknown; readonly approvals: readonly CompactionPgRow[]; readonly artifacts: readonly CompactionPgRow[]
  readonly tasks: readonly CompactionPgRow[]; readonly inputs: readonly InputRow[]; readonly selectedJobMemories: readonly import("./selected-job-memory.js").SelectedJobMemoryRecord[]
}): CompactionState {
  const content = isRecord(input.snapshotContent) ? input.snapshotContent : {}
  const oldFacts = records<CompactionFact>(content.facts)
  const approvals = input.approvals.map(row => ({ id: String(row.id), status: String(row.status), ...(row.scopeHash ? { scopeHash: String(row.scopeHash) } : {}), ...(row.answersHash ? { answersHash: String(row.answersHash) } : {}) }))
  const oldApprovals = records<CompactionState["approvals"][number]>(input.previous?.approvals)
  const answers = new Map<string, CompactionAnswer>(records<CompactionAnswer>(input.previous?.answers).map(value => [value.id, value]))
  for (const row of input.inputs) answers.set(`input:${row.id}`, answerValue(row))
  const artifacts: CompactionArtifact[] = input.artifacts.map(row => ({ id: String(row.id), type: String(row.type), hash: String(row.hash) }))
  const oldArtifacts = records<CompactionArtifact>(input.previous?.artifacts)
  const tasks: CompactionOpenTask[] = input.tasks.map(row => ({ taskId: String(row.id), status: String(row.status), blocker: typeof row.failureReason === "string" ? row.failureReason : null }))
  const facts = mergeById(oldFacts.map(value => ({ ...value, id: value.factId })), records<CompactionFact>(input.previous?.facts).map(value => ({ ...value, id: value.factId }))).map(({ id: _id, ...value }) => value)
  const mergedApprovals = new Map(oldApprovals.map(value => [value.id, value])); for (const approval of approvals) mergedApprovals.set(approval.id, approval)
  const mergedArtifacts = mergeById(oldArtifacts, artifacts)
  const failedAttempts = records<{ readonly doNotRepeat?: unknown }>(content.failedAttempts).flatMap(value => strings(value.doNotRepeat))
  return {
    ownerId: input.userId, sessionId: input.sessionId, throughSequence: input.cursor, goal: input.goal,
    userConstraints: strings(content.userConstraints), approvals: [...mergedApprovals.values()].sort((a, b) => a.id.localeCompare(b.id)), answers: [...answers.values()].sort((a, b) => a.id.localeCompare(b.id)),
    artifacts: mergedArtifacts, openTasks: tasks.sort((a, b) => a.taskId.localeCompare(b.taskId)),
    doNotRepeat: [...new Set([...strings(input.previous?.doNotRepeat), ...failedAttempts])].sort(), facts,
    selectedJobMemories: [...input.selectedJobMemories],
  }
}
async function currentSelectedJobMemory(client: CompactionPgClient, owner: TurnExecutionOwnerFence, turn: CompactionPgRow,
  commandPort: TaskGraphCommandPort | undefined, throughSequence: bigint): Promise<import("./selected-job-memory.js").SelectedJobMemoryRecord | undefined> {
  const jobId = selectedJobId(turn.input)
  if (!jobId || !commandPort?.readCurrentWithClient || turn.rootTaskId !== owner.rootTaskId || owner.rootTaskId !== owner.taskId) return undefined
  const parent = await client.query<{ attemptCount: number | string }>(`SELECT task."attemptCount" FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $1
      AND task."status" = 'running' AND task."leaseOwner" = $4 AND task."interruptRequestedAt" IS NULL
      AND session."userId" = $5 FOR UPDATE OF task`, [owner.rootTaskId, owner.sessionId, owner.turnId, owner.ownerId, owner.userId])
  const attemptCount = Number(parent.rows[0]?.attemptCount)
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 1) return undefined
  const scope: TaskGraphReadScope = {
    userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId, parentTaskId: owner.rootTaskId,
    turnLeaseOwner: owner.ownerId, turnLeaseVersion: owner.leaseVersion, parentLeaseOwner: owner.ownerId, parentAttemptCount: attemptCount,
  }
  let graph: TaskGraphCurrentState
  try { graph = await commandPort.readCurrentWithClient(client as unknown as import("pg").PoolClient, scope) } catch { return undefined }
  return projectSelectedJobMemory({ jobId, sourceTurnId: owner.turnId, sourceRootTaskId: owner.rootTaskId, throughSequence: throughSequence.toString(), graph }) ?? undefined
}
async function readState(client: CompactionPgClient, owner: TurnExecutionOwnerFence, turn: CompactionPgRow, commandPort?: TaskGraphCommandPort) {
  const session = await client.query<CompactionPgRow>(`SELECT "goal" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2`, [owner.sessionId, owner.userId])
  if (!session.rows[0]) return null
  const latest = await latestCompactionSnapshot(client, owner.sessionId)
  const content = latest?.content == null ? null : parseSnapshotContent(latest.content)
  const prior = previousState(content)
  const cursor = sequence(latest?.throughSequence ?? prior?.throughSequence ?? 0n)
  const [approvalRows, artifactRows, taskRows, inputRows] = await Promise.all([
    client.query<CompactionPgRow>(`SELECT "id", "status", "scopeHash", "answersHash" FROM "agent_approvals" WHERE "sessionId" = $1 AND "userId" = $2 ORDER BY "id"`, [owner.sessionId, owner.userId]),
    client.query<CompactionPgRow>(`SELECT "id", "artifactType" AS "type", "contentHash" AS "hash"
      FROM "agent_artifact_version" WHERE "sessionId" = $1 AND "userId" = $2 ORDER BY "createdAt", "id"`, [owner.sessionId, owner.userId]),
    client.query<CompactionPgRow>(`SELECT "id", "status", "failureReason" FROM "sub_agent_tasks" WHERE "sessionId" = $1
      AND "status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed') ORDER BY "id"`, [owner.sessionId]),
    client.query<InputRow>(`SELECT "id", "targetTurnId", "acceptedSequence", "content" FROM "agent_inputs" WHERE "sessionId" = $1 AND "userId" = $2
      AND "consumedByStepId" IS NOT NULL AND "cancelledAt" IS NULL ORDER BY "acceptedSequence", "id"`, [owner.sessionId, owner.userId]),
  ])
  const itemRows = await client.query<CompactionPgRow>(`SELECT item."id", item."sessionId", item."turnId", item."type", item."status", item."content", tail."sequence"
    FROM "agent_items" AS item JOIN LATERAL (
      SELECT MAX(event."sequence") AS "sequence" FROM "agent_events" AS event WHERE event."sessionId" = item."sessionId" AND event."itemId" = item."id"
        AND event."type" IN ('item.completed', 'item.failed', 'item.interrupted')) AS tail ON tail."sequence" IS NOT NULL
    WHERE item."sessionId" = $1 AND item."type" IN ('agent_message', 'reasoning_summary', 'tool_result', 'error', 'question')
      AND item."status" IN ('completed', 'failed', 'interrupted') AND (item."taskId" IS NULL OR item."taskId" = $3)
      AND tail."sequence" > $2 ORDER BY tail."sequence", item."id"`, [owner.sessionId, cursor.toString(), owner.taskId])
  const oldSummary = previousNarrativeSummary(content)
  const items: CompactionInputItem[] = [
    ...(oldSummary && latest ? [{ id: `context-compaction-summary:${latest.id}`, sessionId: owner.sessionId, turnId: owner.turnId, sequence: cursor, type: "compaction_summary", status: "completed", content: oldSummary }] : []),
    ...itemRows.rows.map(row => ({ id: String(row.id), sessionId: String(row.sessionId), turnId: String(row.turnId), sequence: sequence(row.sequence), type: String(row.type), status: String(row.status), content: row.content })),
    ...inputRows.rows.filter(row => sequence(row.acceptedSequence) > cursor).map(row => ({ id: `input:${row.id}`, sessionId: owner.sessionId, turnId: row.targetTurnId ?? owner.turnId, sequence: sequence(row.acceptedSequence), type: "user_input", status: "completed", content: row.content })),
  ].sort((left, right) => left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : left.id.localeCompare(right.id))
  const throughSequence = items.reduce((max, item) => item.sequence > max ? item.sequence : max, cursor)
  const currentMemory = await currentSelectedJobMemory(client, owner, turn, commandPort, throughSequence)
  const priorMemories = parseSelectedJobMemories(prior?.selectedJobMemories, true) ?? []
  const selectedJobMemories = mergeSelectedJobMemories(priorMemories, currentMemory ? [currentMemory] : [])
  const state = stateFrom({ userId: owner.userId, sessionId: owner.sessionId, goal: String(session.rows[0].goal), cursor: throughSequence, previous: prior, snapshotContent: content,
    approvals: approvalRows.rows, artifacts: artifactRows.rows, tasks: taskRows.rows, inputs: inputRows.rows, selectedJobMemories })
  return { state, items }
}

export function createPgCompactionSource(pool: CompactionPgPool, taskGraphCommandPort?: TaskGraphCommandPort): CompactionSourcePort {
  const currentTaskGraph = taskGraphCommandPort ?? createPgTaskGraphCommandPort(pool)
  return { async load(input): Promise<CompactionSource | null> {
    assertCompactionScope(input.scope, input.owner, input.owner.sessionId, input.owner.turnId)
    return withCompactionOwner(pool, input.scope, input.owner, (client, turn) =>
      turn.contextSnapshotId === null ? readState(client, input.owner, turn, currentTaskGraph) : Promise.resolve(null))
  } }
}
