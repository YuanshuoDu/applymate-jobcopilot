import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"
import { projectRootTaskHistory, type ValidatedRootTaskHistoryOutcome } from "./root-task-history.js"
import {
  createRootTaskHistoryObjectiveSnapshotIdentity, createRootTaskHistoryObjectiveSnapshotPayload,
  readRootTaskHistoryObjectiveSnapshotPayload, rootTaskHistoryObjectiveSnapshotKey,
} from "./root-task-history-objective-snapshot-codec.js"
import type { RootTaskHistoryFence } from "./root-task-history-fence.js"
import type { RootTaskHistorySessionAuthorization } from "./root-task-history-session-memory.js"

const currentStart = new Date("2026-10-28T12:00:00.000Z")
const auth: RootTaskHistorySessionAuthorization = { eventId: "agent-root-task-history-auth", sessionId: "session-current", userId: "user-1",
  consentVersion: 7, consentEnabled: true, gateEnabledAtCapture: false }
const fence: RootTaskHistoryFence = { currentStartSequence: 3n, currentStartCreatedAt: currentStart,
  objectiveDigest: "a".repeat(64), currentOrigin: JSON.stringify(["user", "none"]) }
const identityInput = { lease: { userId: "user-1", sessionId: "session-current" }, authorization: auth, fence,
  acceptedInputRevision: 0n, steerEvidence: { kind: "no_accepted_steer" as const } }

function outcome(turn: string, root: string, at: string, nodes = 1): ValidatedRootTaskHistoryOutcome {
  const taskGraph = { revision: 4, nodes: Array.from({ length: nodes }, (_, index) => ({
    templateId: index % 2 ? "analyst" : "scout", status: "completed", goal: "PRIVATE RAW GOAL", resultProjection: { query: "PRIVATE QUERY" },
    discoveryQueryFootprint: { location: "PRIVATE LOCATION", cursor: "PRIVATE CURSOR", jobId: "PRIVATE JOB" },
  })) }
  return { sourceTurnId: turn, sourceRootTaskId: root, terminalSequence: 20n, terminalAt: new Date(at), sourceSessionDiffers: true,
    taskGraph: taskGraph as unknown as ValidatedRootTaskHistoryOutcome["taskGraph"] }
}

describe("root task history objective snapshot codec", () => {
  it("binds the identity to fence objective, canonical origin, authorization, revision and no-steer evidence", () => {
    const identity = createRootTaskHistoryObjectiveSnapshotIdentity(identityInput)
    expect(identity).toMatchObject({ sessionId: "session-current", userId: "user-1", authorizationEventId: auth.eventId,
      consentVersion: 7, gateEnabledAtCapture: false, objectiveDigest: "a".repeat(64), canonicalOrigin: '["user","none"]',
      intentKind: null, intentVersion: null, acceptedInputRevision: "0", steerEvidence: "no_accepted_steer" })
    expect(rootTaskHistoryObjectiveSnapshotKey(identity!)).not.toBe(rootTaskHistoryObjectiveSnapshotKey({ ...identity!, acceptedInputRevision: "1" }))
    expect(createRootTaskHistoryObjectiveSnapshotIdentity({ ...identityInput, authorization: { ...auth, userId: "other" } })).toBeNull()
    expect(createRootTaskHistoryObjectiveSnapshotIdentity({ ...identityInput, steerEvidence: { kind: "accepted_steer" } })).toBeNull()
    expect(createRootTaskHistoryObjectiveSnapshotIdentity({ ...identityInput, fence: { ...fence, objectiveDigest: "bad" } })).toBeNull()
  })

  it("stores only ordered minimal prior-session projections and strips raw graph and Scout query data", () => {
    const identity = createRootTaskHistoryObjectiveSnapshotIdentity(identityInput)!
    const payload = createRootTaskHistoryObjectiveSnapshotPayload(identity, [
      outcome("older", "root-old", "2026-10-27T10:00:00.000Z", 4),
      outcome("latest", "root-latest", "2026-10-28T10:00:00.000Z", 4),
      outcome("oldest", "root-oldest", "2026-10-26T10:00:00.000Z", 4),
    ], currentStart)
    expect(payload).not.toBeNull()
    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThanOrEqual(8192)
    const serialized = JSON.stringify(payload)
    for (const privateValue of ["PRIVATE RAW GOAL", "PRIVATE QUERY", "PRIVATE LOCATION", "PRIVATE CURSOR", "PRIVATE JOB", "discoveryQueryFootprint", "resultProjection"]) {
      expect(serialized).not.toContain(privateValue)
    }
    const replay = readRootTaskHistoryObjectiveSnapshotPayload(payload, identity, currentStart)
    expect(replay).toHaveLength(2)
    expect(replay?.map(value => value.sourceTurnId)).toEqual(["latest", "older"])
    expect(replay?.reduce((sum, value) => sum + value.taskGraph.nodes.length, 0)).toBe(8)
    expect(replay?.[0]?.terminalAt?.toISOString()).toBe("2026-10-28T10:00:00.000Z")
    const block = projectRootTaskHistory(replay!, true)
    expect(JSON.stringify(block)).not.toContain("discoveryQueryFootprint")
    expect(JSON.stringify(block)).not.toContain("PRIVATE")
  })

  it("persists an empty array as a valid immutable value and rejects unsafe source outcomes", () => {
    const identity = createRootTaskHistoryObjectiveSnapshotIdentity(identityInput)!
    const empty = createRootTaskHistoryObjectiveSnapshotPayload(identity, [], currentStart)
    expect(readRootTaskHistoryObjectiveSnapshotPayload(empty, identity, currentStart)).toEqual([])
    expect(createRootTaskHistoryObjectiveSnapshotPayload(identity, [
      { ...outcome("same-session", "root", "2026-10-27T10:00:00.000Z"), sourceSessionDiffers: false },
    ], currentStart)).toBeNull()
    expect(createRootTaskHistoryObjectiveSnapshotPayload(identity, [outcome("future", "root", currentStart.toISOString())], currentStart)).toBeNull()
  })

  it("fails replay closed on signature, schema, chronology, node-bound, or footprint tampering", () => {
    const identity = createRootTaskHistoryObjectiveSnapshotIdentity(identityInput)!
    const payload = createRootTaskHistoryObjectiveSnapshotPayload(identity, [outcome("source", "root", "2026-10-27T10:00:00.000Z")], currentStart)!
    expect(readRootTaskHistoryObjectiveSnapshotPayload(payload, { ...identity, objectiveDigest: "b".repeat(64) }, currentStart)).toBeNull()
    const extra = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
    const outcomes = extra.outcomes as Array<Record<string, unknown>>
    const graph = outcomes[0]!.taskGraph as { nodes: Array<Record<string, unknown>> }
    graph.nodes[0]!.discoveryQueryFootprint = { location: "hidden" }
    expect(readRootTaskHistoryObjectiveSnapshotPayload(extra, identity, currentStart)).toBeNull()
    const future = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
    const futureOutcomes = future.outcomes as Array<Record<string, unknown>>
    futureOutcomes[0]!.terminalAt = currentStart.toISOString()
    expect(readRootTaskHistoryObjectiveSnapshotPayload(future, identity, currentStart)).toBeNull()
  })
})
