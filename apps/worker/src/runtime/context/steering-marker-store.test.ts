import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import {
  appliedSteeringMarkerEntries,
  buildAppliedSteeringMarker,
  buildObservedSteeringMarker,
  persistObservedSteeringMarker,
  SteeringMarkerStoreError,
  type SteeringMarkerDatabaseScope,
} from "./steering-marker-store.js"
import { parseSteeringMarkerPayload } from "./steering-marker.js"

const scope: SteeringMarkerDatabaseScope = { userId: "user-a", sessionId: "session-a", turnId: "turn-a", taskId: "root-turn-a" }
const context = { sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.taskId, obligationId: "obligation-1", goalRevision: 2, planRevision: 3 }
const marker = buildObservedSteeringMarker({ sessionId: scope.sessionId, turnId: scope.turnId, stepId: "step-a", context, markerInput: { id: "input-1", acceptedSequence: 4n } })

function makeClient(existing: Record<string, unknown> | null = null, taskPresent = true) {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = []
  const client = {
    calls,
    query: vi.fn(async (sql: unknown, values: readonly unknown[] = []) => {
      const text = String(sql)
      calls.push({ sql: text, values })
      if (text.includes('FROM "sub_agent_tasks"')) return { rows: taskPresent ? [{ id: scope.taskId }] : [] }
      if (text.includes('FROM "agent_events"')) return { rows: existing ? [existing] : [] }
      if (text.startsWith("UPDATE \"agent_sessions\"")) return { rows: [{ eventSequence: "9" }] }
      if (text.startsWith('INSERT INTO "agent_events"')) return { rowCount: 1, rows: [] }
      if (text.startsWith('INSERT INTO "agent_outbox"')) return { rowCount: 1, rows: [] }
      throw new Error(`unexpected SQL ${text}`)
    }),
  }
  return client
}
function queryClient(client: ReturnType<typeof makeClient>): Pick<pg.PoolClient, "query"> {
  return client as unknown as Pick<pg.PoolClient, "query">
}

describe("steering marker transaction store", () => {
  it("constructs a server-shaped marker without retaining input text", () => {
    expect(parseSteeringMarkerPayload(marker)).toEqual(marker)
    expect(JSON.stringify(marker)).not.toContain("Dublin")
    expect(marker.idempotencyKey).toContain("session-a:turn-a:input-1")
  })

  it("persists event and outbox on the supplied transaction client in order", async () => {
    const client = makeClient()
    await persistObservedSteeringMarker(queryClient(client), { ...scope, lease: { ownerId: "worker-a", now: new Date("2026-09-15T00:00:00.000Z") } }, {
      sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.taskId, stepId: "step-a", payload: marker,
    })
    const sql = client.calls.map(call => call.sql)
    expect(sql[0]).toContain('FROM "sub_agent_tasks"')
    expect(sql[1]).toContain('FROM "agent_events"')
    expect(sql[2]).toContain('UPDATE "agent_sessions"')
    expect(sql[3]).toContain('INSERT INTO "agent_events"')
    expect(sql[4]).toContain('INSERT INTO "agent_outbox"')
    expect(sql.every(text => !text.includes(scope.sessionId))).toBe(true)
    expect(sql.every(text => !text.includes(scope.taskId))).toBe(true)
  })

  it("accepts an exact idempotent replay and revalidates persisted payload", async () => {
    const client = makeClient({ id: `steering-marker-event:${marker.idempotencyKey}`, turnId: scope.turnId, taskId: scope.taskId, type: "agent.steering.marker", actor: "system", correlationId: scope.turnId, payload: { ...marker }, sequence: "9" })
    await persistObservedSteeringMarker(queryClient(client), scope, { sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.taskId, stepId: "step-a", payload: marker })
    expect(client.calls.filter(call => call.sql.startsWith('INSERT INTO "agent_events"')).length).toBe(0)
    expect(client.calls.filter(call => call.sql.startsWith('INSERT INTO "agent_outbox"')).length).toBe(1)
    const reordered = Object.fromEntries([["status", marker.status], ["kind", marker.kind], ...Object.entries(marker).filter(([key]) => key !== "status" && key !== "kind")])
    const reorderedClient = makeClient({ id: `steering-marker-event:${marker.idempotencyKey}`, turnId: scope.turnId, taskId: scope.taskId, type: "agent.steering.marker", actor: "system", correlationId: scope.turnId, payload: reordered, sequence: "9" })
    await persistObservedSteeringMarker(queryClient(reorderedClient), scope, { sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.taskId, stepId: "step-a", payload: marker })
  })

  it("rejects wrong task and conflicting payload before writing", async () => {
    const client = makeClient(null, false)
    await expect(persistObservedSteeringMarker(queryClient(client), scope, { sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.taskId, stepId: "step-a", payload: marker })).rejects.toMatchObject({ code: "scope_conflict" })
    expect(client.calls.some(call => call.sql.startsWith('INSERT INTO "agent_events"'))).toBe(false)
    const conflictClient = makeClient({ id: `steering-marker-event:${marker.idempotencyKey}`, turnId: scope.turnId, taskId: scope.taskId, type: "agent.steering.marker", actor: "system", correlationId: scope.turnId, payload: { ...marker, stepId: "other-step" }, sequence: "9" })
    await expect(persistObservedSteeringMarker(queryClient(conflictClient), scope, { sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.taskId, stepId: "step-a", payload: marker })).rejects.toBeInstanceOf(SteeringMarkerStoreError)
  })

  it("builds an applied marker without copying input content", () => {
    const applied = buildAppliedSteeringMarker({ marker, stepId: "step-b" })
    expect(applied).toMatchObject({ kind: "applied", status: "applied", stepId: "step-b", inputId: marker.inputId, obligationId: marker.obligationId })
    expect(applied.idempotencyKey).toBe(marker.idempotencyKey)
    expect(JSON.stringify(applied)).not.toContain("Dublin")
  })

  it("selects matching active markers in stable order and excludes another obligation", () => {
    const second = buildObservedSteeringMarker({ sessionId: scope.sessionId, turnId: scope.turnId, stepId: "step-a", context, markerInput: { id: "input-0", acceptedSequence: 3n } })
    const other = buildObservedSteeringMarker({ sessionId: scope.sessionId, turnId: scope.turnId, stepId: "step-a", context: { ...context, obligationId: "other" }, markerInput: { id: "input-x", acceptedSequence: 2n } })
    const entries = appliedSteeringMarkerEntries({ markers: [marker, other, second], context, stepId: "step-b" })
    expect(entries.map(entry => entry.payload.inputId)).toEqual(["input-0", "input-1"])
    expect(entries.every(entry => entry.key.startsWith("steering-marker-applied:"))).toBe(true)
  })

  it("rejects an active marker from another session or Turn", () => {
    const foreignSession = buildObservedSteeringMarker({ sessionId: "session-b", turnId: scope.turnId, stepId: "step-a", context: { ...context, sessionId: "session-b" }, markerInput: { id: "input-foreign-session", acceptedSequence: 5n } })
    const foreignTurn = buildObservedSteeringMarker({ sessionId: scope.sessionId, turnId: "turn-b", stepId: "step-a", context: { ...context, turnId: "turn-b" }, markerInput: { id: "input-foreign-turn", acceptedSequence: 6n } })
    expect(appliedSteeringMarkerEntries({ markers: [foreignSession, foreignTurn], context, stepId: "step-b" })).toEqual([])
  })

  it("fails closed when the application context omits session or Turn scope", () => {
    expect(() => appliedSteeringMarkerEntries({ markers: [marker], context: { ...context, sessionId: undefined } as never, stepId: "step-b" })).toThrow(/session and Turn scope/)
    expect(() => appliedSteeringMarkerEntries({ markers: [marker], context: { ...context, turnId: undefined } as never, stepId: "step-b" })).toThrow(/session and Turn scope/)
  })

  it("fails closed when applied markers exceed the byte bound", () => {
    const markers = Array.from({ length: 128 }, (_, index) => buildObservedSteeringMarker({
      sessionId: scope.sessionId, turnId: scope.turnId, stepId: "step-a", context,
      markerInput: { id: `input-${index}-${"x".repeat(80)}`, acceptedSequence: BigInt(index + 1) },
    }))
    expect(() => appliedSteeringMarkerEntries({ markers, context, stepId: "step-b" })).toThrow(/byte bound/)
  })
})
