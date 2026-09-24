import type { Actor } from './common.js'
import type { AgentMessagePhase, ItemStatus } from './item.js'
import type { AgentEventType } from './event.js'
import type { StepStatus } from './step.js'
import type { TurnSource, TurnStatus } from './turn.js'

export type RepositoryJsonValue =
  | null
  | boolean
  | number
  | string
  | RepositoryJsonValue[]
  | { readonly [key: string]: RepositoryJsonValue }

export interface TenantScope {
  readonly userId: string
}

export interface AgentTurnRecord {
  id: string
  sessionId: string
  userId: string
  source: TurnSource
  status: TurnStatus
  revision: number
  createdAt: string
  updatedAt: string
}

export interface AgentStepRecord {
  id: string
  sessionId: string
  turnId: string
  ordinal: number
  attempt: number
  status: StepStatus
  inputThroughSequence: bigint
  consumedInputIds: string[]
  modelProfileSnapshot: RepositoryJsonValue
  createdAt: string
}

export interface AgentItemRecord {
  id: string
  sessionId: string
  turnId: string
  stepId: string | null
  taskId: string | null
  type: string
  status: ItemStatus
  phase: AgentMessagePhase | null
  revision: number
  content: RepositoryJsonValue
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface AgentEventRecord<TPayload extends RepositoryJsonValue = RepositoryJsonValue> {
  id: string
  sessionId: string
  turnId: string
  itemId: string | null
  taskId: string | null
  sequence: bigint
  type: string
  actor: Actor
  correlationId: string
  causationId: string | null
  idempotencyKey: string | null
  payload: TPayload
  createdAt: string
}

export interface AgentProjection {
  turn: AgentTurnRecord
  steps: AgentStepRecord[]
  items: AgentItemRecord[]
  events: AgentEventRecord[]
}

export interface ClaimTurnInput {
  sessionId: string
  turnId: string
  expectedRevision: number
  expectedStatus: Extract<TurnStatus, 'queued' | 'waiting_for_dependency' | 'waiting_for_approval' | 'waiting_for_user'>
}

export interface StartStepInput {
  sessionId: string
  turnId: string
  stepId: string
  expectedTurnRevision: number
  ordinal: number
  attempt: number
  status: StepStatus
  inputThroughSequence: bigint
  consumedInputIds: string[]
  modelProfileSnapshot: RepositoryJsonValue
}

export interface UpdateItemInput {
  sessionId: string
  itemId: string
  expectedRevision: number
  status: ItemStatus
  phase: AgentMessagePhase | null
  content: RepositoryJsonValue
  startedAt: string | null
  completedAt: string | null
}

export interface AppendEventInput<TPayload extends RepositoryJsonValue = RepositoryJsonValue> {
  id: string
  sessionId: string
  turnId: string
  itemId: string | null
  taskId: string | null
  type: AgentEventType | string
  actor: Actor
  correlationId: string
  causationId: string | null
  idempotencyKey: string | null
  payload: TPayload
  outboxTopic: string
}

export interface AgentRepositoryUnitOfWork {
  claimTurn(input: ClaimTurnInput): Promise<AgentTurnRecord | null>
  startStep(input: StartStepInput): Promise<AgentStepRecord>
  updateItem(input: UpdateItemInput): Promise<AgentItemRecord>
  appendEvent(input: AppendEventInput): Promise<AgentEventRecord>
}

export interface AgentStore {
  withUnitOfWork<T>(work: (uow: AgentRepositoryUnitOfWork) => Promise<T>): Promise<T>
  getProjection(input: { sessionId: string; turnId: string }): Promise<AgentProjection | null>
}
