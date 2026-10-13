import { describe, expect, it, vi } from "vitest"
import { createNativeSemanticProgressTracker } from "./native-semantic-progress.js"
import { configureNativeSemanticProgress, observeNativeSemanticRejection, resolveNativeSemanticProgressMode } from "./canonical-turn-native-semantic-rejection.js"
import { digestNativeVerificationValue } from "./subagents/native-verification-contract.js"
import type { NativeVerificationPort } from "./subagents/native-verification-port.js"
import type { TaskGraphExecutionScope } from "./subagents/task-graph-command-port.js"
import type { ExecutionOwnerFence } from "./execution-owner.js"
import { TurnEngineError } from "./turns/turn-engine-types.js"

const owner: ExecutionOwnerFence = { kind: "turn", taskId: "root-1", rootTaskId: "root-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", ownerId: "worker-1", leaseVersion: 2, leaseExpiresAt: new Date(1) }
const scope: TaskGraphExecutionScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "step-3", turnLeaseOwner: "worker-1", turnLeaseVersion: 2, parentLeaseOwner: "worker-1", parentAttemptCount: 1 }
const candidateText = "The current answer"
const identity = { candidateDigest: digestNativeVerificationValue(candidateText), controlTaskId: "control-1", controlOperationId: "operation-1",
  controlAttempt: 2, controlReportDigest: "b".repeat(64) }

describe("native semantic rejection runtime", () => {
  it("keeps custom legacy stores compatible and requires storage when durable mode is requested", async () => {
    expect(await resolveNativeSemanticProgressMode({ store: {}, owner, requestedEnabled: false, now: new Date(0) })).toBe("legacy_v1")
    await expect(resolveNativeSemanticProgressMode({ store: {}, owner, requestedEnabled: true, now: new Date(0) }))
      .rejects.toMatchObject({ code: "persistence_conflict" })
  })

  it("uses the persisted mode when the initialization flag is off", async () => {
    const resolver = vi.fn(async () => "durable_v1" as const)
    await expect(resolveNativeSemanticProgressMode({ store: { resolveNativeSemanticProgressMode: resolver }, owner,
      requestedEnabled: false, now: new Date(1) })).resolves.toBe("durable_v1")
    expect(resolver).toHaveBeenCalledWith({ owner, requestedEnabled: false, now: new Date(1) })
  })

  it("resolves and configures semantic mode for the current root before execution", async () => {
    const now = new Date(2)
    const lease = { turnId: owner.turnId, sessionId: owner.sessionId, ownerId: owner.ownerId, userId: owner.userId,
      leaseVersion: owner.leaseVersion, leaseStartedAt: new Date(0), leaseExpiresAt: owner.leaseExpiresAt }
    const expectedOwner = { ...owner, taskId: "root-2", rootTaskId: "root-2" }
    const resolver = vi.fn(async () => "durable_v1" as const)
    const store = { resolveNativeSemanticProgressMode: resolver }
    const configureSemanticProgress = vi.fn()
    const nativeVerification = { configureSemanticProgress }
    const result = await configureNativeSemanticProgress({ taskId: "root-2", lease, store, nativeVerification,
      featureEnabled: true, taskGraphPlanningEnabled: false, now })
    expect(resolver).toHaveBeenCalledWith({ owner: expectedOwner, requestedEnabled: false, now })
    expect(configureSemanticProgress).toHaveBeenCalledWith({ mode: "durable_v1", store, owner: expectedOwner })
    expect(result).toEqual({ owner: expectedOwner, mode: "durable_v1" })
  })

  it("enables the pinned mode only when both the feature and TaskGraph gates are on", async () => {
    const now = new Date(3)
    const lease = { turnId: owner.turnId, sessionId: owner.sessionId, ownerId: owner.ownerId, userId: owner.userId,
      leaseVersion: owner.leaseVersion, leaseStartedAt: new Date(0), leaseExpiresAt: owner.leaseExpiresAt }
    const expectedOwner = { ...owner, taskId: "root-3", rootTaskId: "root-3" }
    const resolver = vi.fn(async () => "durable_v1" as const)
    const store = { resolveNativeSemanticProgressMode: resolver }
    const configureSemanticProgress = vi.fn()
    const result = await configureNativeSemanticProgress({ taskId: "root-3", lease, store,
      nativeVerification: { configureSemanticProgress }, featureEnabled: true, taskGraphPlanningEnabled: true, now })
    expect(resolver).toHaveBeenCalledWith({ owner: expectedOwner, requestedEnabled: true, now })
    expect(configureSemanticProgress).toHaveBeenCalledWith({ mode: "durable_v1", store, owner: expectedOwner })
    expect(result).toEqual({ owner: expectedOwner, mode: "durable_v1" })
  })

  it("keeps legacy observation in memory and returns only a strict durable identity", async () => {
    const tracker = createNativeSemanticProgressTracker()
    const port = { readFailedRootSemanticRejection: vi.fn(async () => identity) } as unknown as NativeVerificationPort
    const store = { readNativeSemanticRejections: vi.fn(async () => ({ inputThroughSequence: 4n, stepIds: [] })) } as never
    expect(await observeNativeSemanticRejection({ mode: "legacy_v1", tracker, port, scope, stepId: "step-1", candidateText, controlTaskId: "control-1" })).toBe(false)
    await expect(observeNativeSemanticRejection({ mode: "durable_v1", tracker, port, store, owner, scope, stepId: "step-2", candidateText, controlTaskId: "control-1" })).resolves.toEqual(identity)
    expect(port.readFailedRootSemanticRejection).toHaveBeenCalledOnce()
  })

  it("omits stale proof identities and fails closed on malformed or foreign durable state", async () => {
    const tracker = createNativeSemanticProgressTracker()
    const read = vi.fn(async () => null)
    const port = { readFailedRootSemanticRejection: read } as unknown as NativeVerificationPort
    const store = { readNativeSemanticRejections: vi.fn(async () => ({ inputThroughSequence: 4n, stepIds: [] })) } as never
    const observe = (candidate = candidateText, control = "control-1") => observeNativeSemanticRejection({ mode: "durable_v1", tracker, port, store, owner, scope,
      stepId: "step-2", candidateText: candidate, controlTaskId: control })
    await expect(observe()).resolves.toBe(false)
    read.mockResolvedValueOnce({ ...identity, controlTaskId: "foreign-control" } as never)
    await expect(observe()).rejects.toMatchObject({ code: "persistence_conflict" })
    read.mockResolvedValueOnce(identity as never)
    await expect(observe("Changed candidate")).rejects.toMatchObject({ code: "persistence_conflict" })
    const missing = { mode: "durable_v1", tracker, port: {} as NativeVerificationPort, store, owner, scope, stepId: "step-2", candidateText, controlTaskId: "control-1" } as const
    await expect(observeNativeSemanticRejection(missing)).rejects.toBeInstanceOf(TurnEngineError)
  })
})
