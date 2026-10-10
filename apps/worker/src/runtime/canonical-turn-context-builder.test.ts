import type pg from "pg"
import { describe, expect, it } from "vitest"
import type { TenantScope } from "@jobcopilot/agent-protocol"
import type { InputClaimStore, InputClaimTransaction } from "./context/input-claim-store.js"
import { createCanonicalTurnContextBuilder } from "./canonical-turn-context-builder.js"
import type { TurnLease } from "./turns/lease.js"

const scope: TenantScope = { userId: "user-a" }
const now = new Date("2026-10-07T12:00:00.000Z")

function transaction(calls: unknown[]): InputClaimTransaction {
  return {
    getCheckpoint: async () => ({ inputThroughSequence: 0n, consumedInputIds: [] }),
    claimInputs: async () => ({ inputs: [], newlyClaimedInputIds: [] }),
    loadUnresolvedSteeringInputs: async input => { calls.push(input); return [] },
    persistCheckpoint: async () => undefined,
  }
}

function store(calls: unknown[]): InputClaimStore {
  return { scope, withTransaction: work => work(transaction(calls)) }
}

const lease: TurnLease = {
  userId: "user-a", sessionId: "session-a", turnId: "turn-a", ownerId: "worker-a", leaseVersion: 3,
  leaseStartedAt: now, leaseExpiresAt: new Date(now.getTime() + 60_000),
}

describe("canonical Turn context builder", () => {
  it("injects only server-owned native-root scope into the same-client historical steering reader", async () => {
    const calls: unknown[] = []
    const builder = createCanonicalTurnContextBuilder({
      pool: { connect: async () => { throw new Error("context without attachments must not acquire another client") } } as unknown as Pick<pg.Pool, "connect">,
      store: store(calls), scope, lease, rootTaskId: "root-a", rootAttemptCount: 2, rootInputId: "original-input-a",
      planningEnabled: true, selectedJobMode: false,
    })

    const context = await builder.build({
      scope, sessionId: lease.sessionId, turnId: lease.turnId, stepId: "step-a",
      snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
      mode: "rebuild", lease: { ownerId: lease.ownerId, leaseVersion: lease.leaseVersion, now },
    })

    expect(calls).toEqual([{
      userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "root-a", parentTaskId: "root-a",
      turnLeaseOwner: "worker-a", turnLeaseVersion: 3, parentLeaseOwner: "worker-a", parentAttemptCount: 2,
      rootInputId: "original-input-a", lease: { ownerId: "worker-a", leaseVersion: 3, now },
    }])
    expect(calls[0]).not.toHaveProperty("stepId")
    expect(context.consumedInputIds).toEqual([])
    expect(context.taskGraphRevision).toBeUndefined()
  })

  it("does not request native steering hydration when canonical root planning is disabled", async () => {
    const calls: unknown[] = []
    const builder = createCanonicalTurnContextBuilder({
      pool: { connect: async () => { throw new Error("unexpected connection") } } as unknown as Pick<pg.Pool, "connect">,
      store: store(calls), scope, lease, rootTaskId: "root-a", rootAttemptCount: 2, planningEnabled: false, selectedJobMode: false,
    })

    await builder.build({
      scope, sessionId: lease.sessionId, turnId: lease.turnId, stepId: "step-a",
      snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
    })

    expect(calls).toEqual([])
  })
})
