import type {
  AgentProjection,
  AgentStore,
  RepositoryJsonValue,
  TenantScope,
} from './repository.js'

export interface RepositoryFixture {
  scope: TenantScope
  sessionId: string
  turnId: string
  itemId: string
  stepId: string
  eventId: string
  idempotencyKey: string
}

export interface RepositoryProjectionFingerprint {
  turn: Pick<AgentProjection['turn'], 'id' | 'sessionId' | 'userId' | 'status' | 'revision'>
  steps: Array<Pick<AgentProjection['steps'][number], 'id' | 'turnId' | 'ordinal' | 'attempt' | 'status' | 'inputThroughSequence' | 'consumedInputIds' | 'modelProfileSnapshot'>>
  items: Array<Pick<AgentProjection['items'][number], 'id' | 'sessionId' | 'turnId' | 'status' | 'phase' | 'revision' | 'content'>>
  events: Array<Pick<AgentProjection['events'][number], 'id' | 'sessionId' | 'turnId' | 'itemId' | 'sequence' | 'type' | 'actor' | 'correlationId' | 'causationId' | 'idempotencyKey' | 'payload'>>
}

function fingerprint(projection: AgentProjection): RepositoryProjectionFingerprint {
  return {
    turn: {
      id: projection.turn.id,
      sessionId: projection.turn.sessionId,
      userId: projection.turn.userId,
      status: projection.turn.status,
      revision: projection.turn.revision,
    },
    steps: projection.steps.map((step) => ({
      id: step.id,
      turnId: step.turnId,
      ordinal: step.ordinal,
      attempt: step.attempt,
      status: step.status,
      inputThroughSequence: step.inputThroughSequence,
      consumedInputIds: step.consumedInputIds,
      modelProfileSnapshot: step.modelProfileSnapshot,
    })),
    items: projection.items.map((item) => ({
      id: item.id,
      sessionId: item.sessionId,
      turnId: item.turnId,
      status: item.status,
      phase: item.phase,
      revision: item.revision,
      content: item.content,
    })),
    events: projection.events.map((event) => ({
      id: event.id,
      sessionId: event.sessionId,
      turnId: event.turnId,
      itemId: event.itemId,
      sequence: event.sequence,
      type: event.type,
      actor: event.actor,
      correlationId: event.correlationId,
      causationId: event.causationId,
      idempotencyKey: event.idempotencyKey,
      payload: event.payload,
    })),
  }
}

export async function runRepositoryFixture(
  store: AgentStore,
  fixture: RepositoryFixture,
): Promise<RepositoryProjectionFingerprint> {
  const result = await store.withUnitOfWork(async (uow) => {
    const turn = await uow.claimTurn({
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      expectedRevision: 0,
      expectedStatus: 'queued',
    })
    if (!turn) throw new Error('repository fixture could not claim turn')

    await uow.startStep({
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      stepId: fixture.stepId,
      expectedTurnRevision: turn.revision,
      ordinal: 0,
      attempt: 1,
      status: 'queued',
      inputThroughSequence: BigInt(0),
      consumedInputIds: [],
      modelProfileSnapshot: { provider: 'fixture', model: 'fixture-model' },
    })

    await uow.updateItem({
      sessionId: fixture.sessionId,
      itemId: fixture.itemId,
      expectedRevision: 0,
      status: 'streaming',
      phase: 'commentary',
      content: { text: 'fixture progress' },
      startedAt: '2026-08-31T00:00:00.000Z',
      completedAt: null,
    })

    await uow.appendEvent({
      id: fixture.eventId,
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      itemId: fixture.itemId,
      taskId: null,
      type: 'item.started',
      actor: 'orchestrator',
      correlationId: 'fixture-correlation',
      causationId: null,
      idempotencyKey: fixture.idempotencyKey,
      payload: { itemId: fixture.itemId },
      outboxTopic: 'agent.events',
    })

    return turn
  })

  const projection = await store.getProjection({ sessionId: fixture.sessionId, turnId: fixture.turnId })
  if (!projection) throw new Error('repository fixture projection is missing')
  if (result.revision !== 1 || projection.events[0]?.sequence !== BigInt(1)) {
    throw new Error('repository fixture sequence or turn revision is invalid')
  }
  return fingerprint(projection)
}

export function isRepositoryJsonValue(value: unknown): value is RepositoryJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isRepositoryJsonValue)
  if (typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(value).every(isRepositoryJsonValue)
}
