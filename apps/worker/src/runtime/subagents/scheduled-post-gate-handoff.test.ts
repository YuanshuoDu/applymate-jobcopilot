import { describe, expect, it, vi } from "vitest"
import { SCHEDULED_GATE_COMPLETION_PROOF_SCHEMA } from "./scheduled-gate-contract.js"
import { parseScheduledPostGateHandoff, scheduledPostGateDigest, SCHEDULED_POST_GATE_HANDOFF_SCHEMA } from "./scheduled-post-gate-contract.js"
import { resumeScheduledPostGate } from "./scheduled-post-gate-handoff.js"

const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  parentAttemptCount: 2, parentLeaseOwner: "root-lease-owner", turnLeaseOwner: "lease-owner", turnLeaseVersion: 4 }
const owner = { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
  rootAttemptCount: 2, turnLeaseOwnerId: scope.turnLeaseOwner, turnLeaseVersion: scope.turnLeaseVersion,
  executionId: "execution-1", executionAttemptCount: 1 }
const snapshotDigest = `sha256:${"a".repeat(64)}`
const continuationKey = `scheduled-taskgraph:sha256:${"b".repeat(64)}`
const gateResultDigest = `sha256:${"c".repeat(64)}`
const gateProof = { schemaVersion: SCHEDULED_GATE_COMPLETION_PROOF_SCHEMA, graphRevision: 8,
  prepareProof: { receipt: { owner, snapshotDigest, continuationKey,
    checkpointDigest: `sha256:${"d".repeat(64)}`, evidenceDigest: `sha256:${"e".repeat(64)}`, analyzeGraphRevision: 7 } },
  gate: { taskId: "gate-task", attemptCount: 1, resultDigest: gateResultDigest, completedEventRevision: 8 } }
const packageRefs = ["job-1"]
const executeNodes = [{ key: "execute-1", taskId: "execute-task", packageRefs }]
const parsedHandoff = parseScheduledPostGateHandoff({ schemaVersion: SCHEDULED_POST_GATE_HANDOFF_SCHEMA, owner,
  snapshotDigest, continuationKey, gateTaskId: "gate-task", gateAttemptCount: 1, gateCompletedEventRevision: 8,
  gateProofDigest: scheduledPostGateDigest(gateProof), gateProof, gateResultDigest, packageRefs,
  packageDigest: scheduledPostGateDigest(packageRefs), proposalDigest: scheduledPostGateDigest({ expectedRevision: 8, nodes: [] }),
  gateGraphRevision: 8, graphRevision: 9, executeNodes, auditTaskId: "audit-task" })
if (!parsedHandoff) throw new Error("scheduled post-Gate handoff fixture is invalid")
const handoff = parsedHandoff

describe("resumeScheduledPostGate", () => {
  it("requests a Root plan when the verified Gate has no durable handoff yet", async () => {
    const read = vi.fn().mockResolvedValue({ status: "awaiting_plan" })
    const wait = vi.fn()
    const result = await resumeScheduledPostGate({ command: { readScheduledPostGatePlanningContext: read } as never,
      waitPort: { wait }, scope, recoveryStepId: "recovery-1", signal: new AbortController().signal })

    expect(result).toEqual({ status: "awaiting_plan" })
    expect(wait).not.toHaveBeenCalled()
  })

  it("replays the exact durable child wait and independently verifies its completion", async () => {
    const context = { status: "planned", receipt: handoff, graphRevision: handoff.graphRevision }
    const read = vi.fn().mockResolvedValue(context)
    const proof = { schemaVersion: "agent-harness.v2.scheduled-post-gate-completion.v1", handoff, graphRevision: 12,
      execute: [{ taskId: "execute-task", attemptCount: 1, resultDigest: `sha256:${"a".repeat(64)}`, completedEventRevision: 10 }],
      audit: { taskId: "audit-task", attemptCount: 1, resultDigest: `sha256:${"b".repeat(64)}`, completedEventRevision: 11,
        report: { processed: 1, applied: 0, queued: 1, pending: 0, skipped: 0, failed: 0, durationMs: 15 } } }
    const verify = vi.fn().mockResolvedValue(proof)
    const wait = vi.fn().mockResolvedValue({ waitId: "wait-1", status: "ready", deadlineAt: "2026-11-09T00:00:00.000Z",
      matchedTaskIds: ["audit-task", "execute-task"] })
    const result = await resumeScheduledPostGate({ command: { readScheduledPostGatePlanningContext: read,
      verifyScheduledPostGateCompletion: verify } as never, waitPort: { wait }, scope, recoveryStepId: "recovery-1",
      signal: new AbortController().signal })

    expect(result).toEqual({ status: "completed" })
    expect(wait).toHaveBeenCalledWith(expect.objectContaining({ taskId: scope.rootTaskId, rootTaskId: scope.rootTaskId,
      targetTaskIds: ["execute-task", "audit-task"], mode: "all" }))
    expect(read).toHaveBeenCalledTimes(2)
    expect(verify).toHaveBeenCalledWith({ scope })
  })

  it("returns the persisted wait without rerunning Gate or verifying before readiness", async () => {
    const read = vi.fn().mockResolvedValue({ status: "planned", receipt: handoff, graphRevision: handoff.graphRevision })
    const verify = vi.fn()
    const wait = vi.fn().mockResolvedValue({ waitId: "wait-1", status: "waiting", deadlineAt: "2026-11-09T00:00:00.000Z",
      matchedTaskIds: [] })

    await expect(resumeScheduledPostGate({ command: { readScheduledPostGatePlanningContext: read,
      verifyScheduledPostGateCompletion: verify } as never, waitPort: { wait }, scope, recoveryStepId: "recovery-1",
      signal: new AbortController().signal })).resolves.toEqual({ status: "waiting_for_dependency", waitId: "wait-1" })
    expect(read).toHaveBeenCalledTimes(1)
    expect(verify).not.toHaveBeenCalled()
  })

  it("blocks Root completion when the ready wait lacks independently verified child completion", async () => {
    const context = { status: "planned", receipt: handoff, graphRevision: handoff.graphRevision }
    const read = vi.fn().mockResolvedValue(context)
    const verify = vi.fn().mockResolvedValue(null)
    const wait = vi.fn().mockResolvedValue({ waitId: "wait-1", status: "ready", deadlineAt: "2026-11-09T00:00:00.000Z",
      matchedTaskIds: ["execute-task", "audit-task"] })

    await expect(resumeScheduledPostGate({ command: { readScheduledPostGatePlanningContext: read,
      verifyScheduledPostGateCompletion: verify } as never, waitPort: { wait }, scope, recoveryStepId: "recovery-1",
      signal: new AbortController().signal })).resolves.toEqual({
      status: "blocked", errorCode: "scheduled_post_gate_completion_unverified",
    })
    expect(read).toHaveBeenCalledTimes(2)
    expect(verify).toHaveBeenCalledWith({ scope })
  })

  it("accepts a refreshed live lease for the same Root attempt and rejects a stale Root attempt", async () => {
    const currentLeaseScope = { ...scope, turnLeaseOwner: "reclaimed-worker", turnLeaseVersion: 5 }
    const read = vi.fn().mockResolvedValue({ status: "planned", receipt: handoff, graphRevision: handoff.graphRevision })
    const wait = vi.fn().mockResolvedValue({ waitId: "wait-1", status: "waiting", deadlineAt: "2026-11-09T00:00:00.000Z",
      matchedTaskIds: [] })
    const command = { readScheduledPostGatePlanningContext: read, verifyScheduledPostGateCompletion: vi.fn() } as never

    await expect(resumeScheduledPostGate({ command, waitPort: { wait }, scope: currentLeaseScope,
      recoveryStepId: "recovery-2", signal: new AbortController().signal }))
      .resolves.toEqual({ status: "waiting_for_dependency", waitId: "wait-1" })
    await expect(resumeScheduledPostGate({ command, waitPort: { wait }, scope: { ...currentLeaseScope, parentAttemptCount: 3 },
      recoveryStepId: "recovery-3", signal: new AbortController().signal }))
      .resolves.toEqual({ status: "blocked", errorCode: "scheduled_post_gate_owner_mismatch" })
    expect(wait).toHaveBeenCalledOnce()
  })
})
