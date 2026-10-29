import { describe, expect, it } from "vitest"

import type { ContextSeedBlock } from "../context/step-context-builder.js"
import type { TurnEngineToolExecutor } from "../turns/turn-engine-types.js"
import type { DurableWaitResume } from "./child-resume-observations.js"
import { childWaitReplayExecutionOptions, createChildDurableWaitReplay } from "./child-durable-wait-replay.js"
import type { SubagentLease } from "./types.js"

const now = new Date("2026-10-29T10:00:00.000Z")
const lease: SubagentLease = {
  id: "child-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "parent-1",
  path: "/root-1/parent-1/child-1", depth: 2, role: "scout", taskType: "research", status: "running", goal: "Inspect",
  constraints: [], successCriteria: [], allowedActions: ["wait_subagents"], context: {}, expectedOutputSchema: {}, result: null,
  failureReason: null, attemptCount: 2, maxAttempts: 3, leaseOwner: "worker-1", leaseExpiresAt: new Date(now.getTime() + 60_000),
  interruptRequestedAt: null, budgetSnapshot: {}, toolPolicySnapshot: {}, ownerId: "worker-1", signal: new AbortController().signal,
}

const input = { idempotencyKey: "wait-key", taskIds: ["child-a", "child-b"], mode: "all", timeoutMs: 5_000 } as const
const output = {
  waitId: "wait-1", status: "ready", taskIds: ["child-a", "child-b"], deadlineAt: "2026-10-29T10:00:05.000Z",
  matchedTaskIds: ["child-a", "child-b"],
  tasks: [
    { taskId: "child-a", status: "completed", role: "scout", result: { summary: "A" }, failureReason: null },
    { taskId: "child-b", status: "completed", role: "analyst", result: { summary: "B" }, failureReason: null },
  ],
} as const
const wait: DurableWaitResume = {
  waitId: "wait-1", stepId: "waiting-step", attempt: lease.attemptCount, ordinal: 4, toolCallId: "old-provider-call",
  sourceItemId: "old-result-item", input, output,
}
const observations: readonly ContextSeedBlock[] = [{
  id: "child-resume:old-result-item",
  content: { toolCallId: wait.toolCallId, toolName: "wait_subagents", input, status: "completed", output, errorCode: null },
}]

function replay(currentLease = lease, currentWait = wait, currentObservations = observations) {
  const value = createChildDurableWaitReplay(currentLease, currentWait, currentObservations)
  value.acknowledgeContinuation({ id: "continuation-step", ordinal: 9 })
  return value
}

function execute(value: ReturnType<typeof replay>, overrides: Parameters<typeof call>[0] = {}) {
  const request = call(overrides)
  const startKey = value.childWaitCallStartKey(request.stepId, {
    id: request.call.id, name: request.call.toolName, arguments: request.call.input,
  })
  if (startKey) value.childWaitCallStarted(request.stepId, {
    id: request.call.id, name: request.call.toolName, arguments: request.call.input,
  }, "persisted-start-event")
  return value.execute(request)
}

function call(overrides: {
  readonly id?: string
  readonly input?: unknown
  readonly taskId?: string
  readonly rootTaskId?: string
  readonly sessionId?: string
  readonly turnId?: string
  readonly stepId?: string
  readonly userId?: string
  readonly toolName?: string
  readonly toolVersion?: string
  readonly signal?: AbortSignal
} = {}): Parameters<TurnEngineToolExecutor>[0] {
  return {
    scope: { userId: overrides.userId ?? lease.userId }, sessionId: overrides.sessionId ?? lease.sessionId,
    turnId: overrides.turnId ?? lease.turnId!, stepId: overrides.stepId ?? "continuation-step",
    taskId: overrides.taskId ?? lease.id, rootTaskId: overrides.rootTaskId ?? lease.rootTaskId,
    signal: overrides.signal ?? new AbortController().signal,
    call: { id: overrides.id ?? "fresh-provider-call", toolName: overrides.toolName ?? "wait_subagents",
      toolVersion: overrides.toolVersion ?? "1", input: overrides.input ?? { ...input, taskIds: [...input.taskIds].reverse() } },
  }
}

describe("child durable wait reissue", () => {
  it("adapts replay callbacks and an optional durable claim into loop options", () => {
    const replayState = replay()
    const options = childWaitReplayExecutionOptions(replayState, undefined)
    const callInfo = { id: "fresh-provider-call", name: "wait_subagents", arguments: { ...input } }
    expect(options.childWaitCallStartKey?.("continuation-step", callInfo)).toBe("child-wait-claim:2:continuation-step")
    options.childWaitCallStarted?.("continuation-step", callInfo, "persisted-start-event")
    expect(replayState.execute(call())).toMatchObject({ status: "completed", id: "fresh-provider-call" })

    const claim = { owner: lease, stepId: "continuation-step", call: { id: "claimed", name: "wait_subagents" as const, arguments: input },
      sourceWaitCallId: wait.toolCallId, sourceInput: input, callItem: { id: "item", revision: 1, status: "started" as const },
      callStartedEventId: "started", claimEventId: "claim", output }
    expect(childWaitReplayExecutionOptions(undefined, claim)).toEqual({ childWaitClaimRecovery: claim })
  })

  it("returns the validated outcome once under the fresh provider ID without a dispatcher", () => {
    const replayed = replay()

    expect(execute(replayed)).toEqual({
      id: "fresh-provider-call", toolName: "wait_subagents", toolVersion: "1", status: "completed", output, errorCode: null,
    })
    expect(execute(replayed, { id: "second-provider-call" })).toMatchObject({
      id: "second-provider-call", status: "failed", errorCode: "wait_conflict",
    })
  })

  it("reserves only one new provider ID under the stable continuation claim key", () => {
    const value = replay()
    const first = { id: "first-provider-call", name: "wait_subagents", arguments: { ...input } }
    const second = { id: "second-provider-call", name: "wait_subagents", arguments: { ...input } }

    expect(value.childWaitCallStartKey("continuation-step", first)).toBe("child-wait-claim:2:continuation-step")
    expect(value.childWaitCallStartKey("continuation-step", second)).toBeUndefined()
    value.childWaitCallStarted("continuation-step", first, "persisted-start-event")
    expect(value.execute(call({ id: first.id }))).toMatchObject({ status: "completed", id: first.id })
  })

  it("requires the owner-fenced started event before consuming the reserved call", () => {
    const value = replay()
    const fresh = { id: "fresh-provider-call", name: "wait_subagents", arguments: { ...input } }
    expect(value.childWaitCallStartKey("continuation-step", fresh)).toBe("child-wait-claim:2:continuation-step")
    expect(value.execute(call())).toMatchObject({ status: "failed", errorCode: "wait_conflict" })
    value.childWaitCallStarted("continuation-step", fresh, "persisted-start-event")
    expect(value.execute(call())).toMatchObject({ status: "failed", errorCode: "wait_conflict" })
  })

  it.each([
    ["key", { ...input, idempotencyKey: "other-key" }],
    ["target set", { ...input, taskIds: ["child-a"] }],
    ["mode", { ...input, mode: "any" }],
    ["timeout", { ...input, timeoutMs: 4_000 }],
    ["extra field", { ...input, extra: true }],
  ])("does not reuse a changed %s", (_name, changedInput) => {
    expect(execute(replay(), { input: changedInput })).toMatchObject({ status: "failed", errorCode: "wait_conflict" })
  })

  it.each([
    ["owner", { ...lease, ownerId: "worker-2" }],
    ["attempt", { ...lease, attemptCount: lease.attemptCount + 1 }],
    ["lease state", { ...lease, status: "queued" as const }],
    ["interrupted lease", { ...lease, interruptRequestedAt: now }],
  ])("does not reuse across a changed %s", (_name, changedLease) => {
    expect(execute(replay(changedLease))).toBeUndefined()
  })

  it("requires the exact acknowledged continuation step", () => {
    const wrongStep = createChildDurableWaitReplay(lease, wait, observations)
    wrongStep.acknowledgeContinuation({ id: "other-step", ordinal: 9 })
    expect(execute(wrongStep)).toBeUndefined()
  })

  it("uses the owner-fenced start event as the live lease check after heartbeat renewal", () => {
    const staleSnapshot = { ...lease, leaseExpiresAt: new Date(now.getTime() - 1) }
    const value = createChildDurableWaitReplay(staleSnapshot, wait, observations)
    value.acknowledgeContinuation({ id: "continuation-step", ordinal: 9 })
    const fresh = { id: "fresh-provider-call", name: "wait_subagents", arguments: { ...input } }
    expect(value.childWaitCallStartKey("continuation-step", fresh)).toBe("child-wait-claim:2:continuation-step")
    value.childWaitCallStarted("continuation-step", fresh, "owner-fenced-start-event")
    expect(value.execute(call())).toMatchObject({ status: "completed", id: "fresh-provider-call" })
  })

  it("fails closed when the restored receipt is missing, duplicated, or inconsistent", () => {
    expect(execute(replay(lease, wait, []))).toBeUndefined()
    expect(execute(replay(lease, wait, [...observations, observations[0]!]))).toBeUndefined()
    const inconsistent = [{ ...observations[0]!, content: { ...(observations[0]!.content as Record<string, unknown>), output: { ...output, waitId: "other-wait" } } }]
    expect(execute(replay(lease, wait, inconsistent))).toBeUndefined()
  })

  it("disables replay if two different continuation steps are acknowledged", () => {
    const value = createChildDurableWaitReplay(lease, wait, observations)
    value.acknowledgeContinuation({ id: "continuation-step", ordinal: 9 })
    value.acknowledgeContinuation({ id: "other-step", ordinal: 10 })
    expect(execute(value)).toMatchObject({ status: "failed", errorCode: "wait_conflict" })
  })

  it("requires the child scope and call version to match", () => {
    const value = replay()
    const conflict = { status: "failed", errorCode: "wait_conflict" }
    expect(execute(value, { taskId: "other-child" })).toMatchObject(conflict)
    expect(execute(value, { rootTaskId: "other-root" })).toMatchObject(conflict)
    expect(execute(value, { sessionId: "other-session" })).toMatchObject(conflict)
    expect(execute(value, { turnId: "other-turn" })).toMatchObject(conflict)
    expect(execute(value, { userId: "other-user" })).toMatchObject(conflict)
    expect(execute(value, { toolVersion: "2" })).toMatchObject(conflict)
    expect(execute(value, { signal: AbortSignal.abort() })).toMatchObject(conflict)
  })
})
