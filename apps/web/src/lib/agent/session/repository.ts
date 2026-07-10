import type {
  AgentSessionSource,
  AgentSessionStatus,
  QualityGateResult,
  SubAgentRole,
  SubAgentTaskStatus,
  TranscriptEventType,
} from "./types"

type JsonValue = unknown

interface CreateDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>
}

interface UpdateDelegate {
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>
}

export interface AgentSessionDb {
  agentSession: CreateDelegate & UpdateDelegate
  agentTranscriptEvent: CreateDelegate
  subAgentTask: CreateDelegate & UpdateDelegate
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
  role: SubAgentRole
  taskType: string
  goal: string
  constraints: string[]
  successCriteria: string[]
  allowedActions: string[]
  context: JsonValue
  expectedOutputSchema: JsonValue
}

export interface CompleteSubAgentTaskInput {
  taskId: string
  status: Extract<SubAgentTaskStatus, "passed" | "failed" | "waiting_for_user">
  result?: JsonValue | null
  confidence?: number | null
  failureReason?: string | null
  qualityGateResult?: QualityGateResult | null
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
  return db.agentTranscriptEvent.create({
    data: {
      sessionId: input.sessionId,
      taskId: input.taskId ?? null,
      type: input.type,
      speaker: input.speaker,
      title: input.title ?? null,
      body: input.body,
      data: input.data ?? null,
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
      role: input.role,
      taskType: input.taskType,
      status: "queued",
      goal: input.goal,
      constraints: input.constraints,
      successCriteria: input.successCriteria,
      allowedActions: input.allowedActions,
      context: input.context,
      expectedOutputSchema: input.expectedOutputSchema,
    },
  })
}

export async function completeSubAgentTask(db: AgentSessionDb, input: CompleteSubAgentTaskInput) {
  return db.subAgentTask.update({
    where: { id: input.taskId },
    data: {
      status: input.status,
      result: input.result ?? null,
      confidence: input.confidence ?? null,
      failureReason: input.failureReason ?? null,
      qualityGateResult: input.qualityGateResult ?? null,
    },
  })
}
