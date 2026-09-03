import type {
  AgentSessionSource,
  AgentSessionStatus,
  QualityGateResult,
  SubAgentRole,
  SubAgentTaskStatus,
  TranscriptEventType,
} from "./types"
import { toDurableSubAgentTaskStatus } from "./types"
import { redactAgentEvent } from "@jobcopilot/shared"

type JsonValue = unknown

interface CreateDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>
}

interface UpdateDelegate {
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>
}

interface UpdateManyDelegate {
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>
}

export interface AgentSessionDb {
  agentSession: CreateDelegate & UpdateDelegate
  agentTranscriptEvent: CreateDelegate
  subAgentTask: CreateDelegate & UpdateDelegate
  agentMailboxMessage?: CreateDelegate & UpdateManyDelegate
}

export interface CreateAgentSessionInput {
  userId: string
  goal: string
  source: AgentSessionSource
  status?: AgentSessionStatus
  memorySummary?: string
}

export interface AppendTranscriptEventInput {
  sessionId: string
  taskId?: string | null
  type: TranscriptEventType
  speaker: string
  title?: string | null
  body: string
  data?: JsonValue | null
  durationMs?: number | null
}

export interface CreateSubAgentTaskInput {
  sessionId: string
  turnId?: string | null
  rootTaskId?: string | null
  parentTaskId?: string | null
  path?: string
  depth?: number
  role: SubAgentRole
  taskType: string
  goal: string
  constraints: string[]
  successCriteria: string[]
  allowedActions: string[]
  context: JsonValue
  expectedOutputSchema: JsonValue
  contextSnapshotId?: string | null
  modelProfileSnapshot?: JsonValue
  toolPolicySnapshot?: JsonValue
  budgetSnapshot?: JsonValue
  attemptCount?: number
  maxAttempts?: number
}

export interface CompleteSubAgentTaskInput {
  taskId: string
  status: Extract<SubAgentTaskStatus, "passed" | "completed" | "failed" | "waiting" | "waiting_for_user" | "interrupted" | "cancelled" | "closed">
  result?: JsonValue | null
  confidence?: number | null
  failureReason?: string | null
  qualityGateResult?: QualityGateResult | null
}

export interface CreateAgentMailboxMessageInput {
  sessionId: string
  turnId: string
  fromTaskId?: string | null
  toTaskId?: string | null
  kind: string
  payload: JsonValue
  idempotencyKey: string
}

export interface ConsumeAgentMailboxMessageInput {
  messageId: string
  sessionId: string
  toTaskId?: string | null
  consumedAt?: Date
}

export interface UpdateAgentSessionInput {
  sessionId: string
  status?: AgentSessionStatus
  memorySummary?: string
  qualityScore?: number | null
  currentTaskId?: string | null
  completedAt?: Date | null
}

export async function createAgentSession(db: AgentSessionDb, input: CreateAgentSessionInput) {
  return db.agentSession.create({
    data: {
      userId: input.userId,
      goal: input.goal,
      source: input.source,
      status: input.status ?? "running",
      memorySummary: input.memorySummary ?? "",
    },
  })
}

export async function appendTranscriptEvent(db: AgentSessionDb, input: AppendTranscriptEventInput) {
  const safe = redactAgentEvent(input)
  return db.agentTranscriptEvent.create({
    data: {
      sessionId: input.sessionId,
      taskId: input.taskId ?? null,
      type: input.type,
      speaker: input.speaker,
      title: input.title ?? null,
      body: safe.body,
      data: safe.data,
      durationMs: input.durationMs ?? null,
    },
  })
}

export async function updateAgentSession(db: AgentSessionDb, input: UpdateAgentSessionInput) {
  const data: Record<string, unknown> = {}
  if (input.status !== undefined) data.status = input.status
  if (input.memorySummary !== undefined) data.memorySummary = input.memorySummary
  if (input.qualityScore !== undefined) data.qualityScore = input.qualityScore
  if (input.currentTaskId !== undefined) data.currentTaskId = input.currentTaskId
  if (input.completedAt !== undefined) data.completedAt = input.completedAt

  return db.agentSession.update({
    where: { id: input.sessionId },
    data,
  })
}

export async function createSubAgentTask(db: AgentSessionDb, input: CreateSubAgentTaskInput) {
  return db.subAgentTask.create({
    data: {
      sessionId: input.sessionId,
      turnId: input.turnId ?? null,
      rootTaskId: input.rootTaskId ?? null,
      parentTaskId: input.parentTaskId ?? null,
      path: input.path ?? "/",
      depth: input.depth ?? 0,
      role: input.role,
      taskType: input.taskType,
      status: "queued",
      goal: input.goal,
      constraints: input.constraints,
      successCriteria: input.successCriteria,
      allowedActions: input.allowedActions,
      context: input.context,
      expectedOutputSchema: input.expectedOutputSchema,
      contextSnapshotId: input.contextSnapshotId ?? null,
      modelProfileSnapshot: input.modelProfileSnapshot ?? {},
      toolPolicySnapshot: input.toolPolicySnapshot ?? {},
      budgetSnapshot: input.budgetSnapshot ?? {},
      attemptCount: input.attemptCount ?? 0,
      maxAttempts: input.maxAttempts ?? 1,
      outputArtifactIds: [],
    },
  })
}

export async function completeSubAgentTask(db: AgentSessionDb, input: CompleteSubAgentTaskInput) {
  return db.subAgentTask.update({
    where: { id: input.taskId },
    data: {
      status: toDurableSubAgentTaskStatus(input.status),
      result: input.result ?? null,
      confidence: input.confidence ?? null,
      failureReason: input.failureReason ?? null,
      qualityGateResult: input.qualityGateResult ?? null,
    },
  })
}

function mailboxDelegate(db: AgentSessionDb) {
  if (!db.agentMailboxMessage) throw new Error("Agent mailbox persistence is unavailable")
  return db.agentMailboxMessage
}

export async function createAgentMailboxMessage(db: AgentSessionDb, input: CreateAgentMailboxMessageInput) {
  return mailboxDelegate(db).create({
    data: {
      sessionId: input.sessionId,
      turnId: input.turnId,
      fromTaskId: input.fromTaskId ?? null,
      toTaskId: input.toTaskId ?? null,
      kind: input.kind,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
    },
  })
}

/** Atomically consumes a message; only the winner of the null consumedAt race gets true. */
export async function consumeAgentMailboxMessage(db: AgentSessionDb, input: ConsumeAgentMailboxMessageInput) {
  const result = await mailboxDelegate(db).updateMany({
    where: {
      id: input.messageId,
      sessionId: input.sessionId,
      ...(input.toTaskId === undefined ? {} : { toTaskId: input.toTaskId }),
      consumedAt: null,
    },
    data: { consumedAt: input.consumedAt ?? new Date() },
  })
  return result.count === 1
}
