import { describe, expect, it } from "vitest"
import type {
  AgentEventRecord,
  AgentItemRecord,
  AgentProjection,
  AgentRepositoryUnitOfWork,
  AgentStepRecord,
  AgentStore,
  AgentTurnRecord,
} from "./repository.js"
import { runRepositoryFixture, type RepositoryFixture } from "./repository-contract.js"

function makeStore(fixture: RepositoryFixture): AgentStore {
  const turn: AgentTurnRecord = {
    id: fixture.turnId,
    sessionId: fixture.sessionId,
    userId: fixture.scope.userId,
    source: "user",
    status: "queued",
    revision: 0,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  }
  const stepRecords: AgentStepRecord[] = []
  const items: AgentItemRecord[] = [{
    id: fixture.itemId,
    sessionId: fixture.sessionId,
    turnId: fixture.turnId,
    stepId: null,
    taskId: null,
    type: "agent_message",
    status: "started",
    phase: "commentary",
    revision: 0,
    content: { text: "initial" },
    startedAt: null,
    completedAt: null,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  }]
  const events: AgentEventRecord[] = []

  const uow: AgentRepositoryUnitOfWork = {
    async claimTurn(input) {
      if (input.expectedRevision !== turn.revision || input.expectedStatus !== turn.status) return null
      turn.status = "in_progress"
      turn.revision += 1
      return { ...turn }
    },
    async startStep(input) {
      if (input.expectedTurnRevision !== turn.revision) throw new Error("stale turn")
      const step: AgentStepRecord = {
        id: input.stepId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        ordinal: input.ordinal,
        attempt: input.attempt,
        status: input.status,
        inputThroughSequence: input.inputThroughSequence,
        consumedInputIds: input.consumedInputIds,
        modelProfileSnapshot: input.modelProfileSnapshot,
        createdAt: "2026-08-31T00:00:00.000Z",
      }
      stepRecords.push(step)
      return step
    },
    async updateItem(input) {
      const item = items.find((entry) => entry.id === input.itemId)
      if (!item || item.revision !== input.expectedRevision) throw new Error("stale item")
      Object.assign(item, {
        status: input.status,
        phase: input.phase,
        content: input.content,
        revision: item.revision + 1,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
      })
      return { ...item }
    },
    async appendEvent(input) {
      const event: AgentEventRecord = {
        id: input.id,
        sessionId: input.sessionId,
        turnId: input.turnId,
        itemId: input.itemId,
        taskId: input.taskId,
        sequence: BigInt(events.length + 1),
        type: input.type,
        actor: input.actor,
        correlationId: input.correlationId,
        causationId: input.causationId,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload,
        createdAt: "2026-08-31T00:00:00.000Z",
      }
      events.push(event)
      return event
    },
  }

  return {
    async withUnitOfWork<T>(work: (unit: AgentRepositoryUnitOfWork) => Promise<T>): Promise<T> {
      return work(uow)
    },
    async getProjection(): Promise<AgentProjection> {
      return { turn: { ...turn }, steps: [...stepRecords], items: [...items], events: [...events] }
    },
  }
}

describe("shared repository fixture", () => {
  it("defines one deterministic projection for every store implementation", async () => {
    const fixture: RepositoryFixture = {
      scope: { userId: "user_fixture" },
      sessionId: "session_fixture",
      turnId: "turn_fixture",
      itemId: "item_fixture",
      stepId: "step_fixture",
      eventId: "event_fixture",
      idempotencyKey: "event_fixture_key",
    }

    await expect(runRepositoryFixture(makeStore(fixture), fixture)).resolves.toMatchObject({
      turn: { id: fixture.turnId, revision: 1, status: "in_progress" },
      steps: [{ id: fixture.stepId, inputThroughSequence: BigInt(0) }],
      items: [{ id: fixture.itemId, revision: 1, status: "streaming" }],
      events: [{ id: fixture.eventId, sequence: BigInt(1) }],
    })
  })
})
