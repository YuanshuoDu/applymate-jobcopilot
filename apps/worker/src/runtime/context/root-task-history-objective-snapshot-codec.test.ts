import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"
import { projectRootTaskHistory, type ValidatedRootTaskHistoryOutcome } from "./root-task-history.js"
import { rootTaskHistoryOrigin } from "./root-task-history-fence.js"
import {
  createRootTaskHistoryObjectiveSnapshotIdentity, createRootTaskHistoryObjectiveSnapshotPayload,
  readRootTaskHistoryObjectiveSnapshotPayload, rootTaskHistoryObjectiveSnapshotKey,
} from "./root-task-history-objective-snapshot-codec.js"
import type { RootTaskHistoryFence } from "./root-task-history-fence.js"
import type { RootTaskHistorySessionAuthorization } from "./root-task-history-session-memory.js"

const auth: RootTaskHistorySessionAuthorization = { eventId: "agent-root-task-history-auth", sessionId: "session-current", userId: "user-1",
  consentVersion: 7, consentEnabled: true, gateEnabledAtCapture: false }
const fence: RootTaskHistoryFence = { currentStartSequence: 3n, currentStartWitness: { eventId: "start-witness", xid8: "100" },
  objectiveDigest: "a".repeat(64), currentOrigin: JSON.stringify(["user", "none"]) }
const identityInput = { lease: { userId: "user-1", sessionId: "session-current" }, authorization: auth, fence,
  acceptedInputRevision: 0n, steerEvidence: { kind: "no_accepted_steer" as const } }

function outcome(turn: string, root: string, xid8: string, nodes = 1): ValidatedRootTaskHistoryOutcome {
  const taskGraph = { revision: 4, nodes: Array.from({ length: nodes }, (_, index) => ({
    templateId: index % 2 ? "analyst" : "scout", status: "completed", goal: "PRIVATE RAW GOAL", resultProjection: { query: "PRIVATE QUERY" },
    discoveryQueryFootprint: { location: "PRIVATE LOCATION", cursor: "PRIVATE CURSOR", jobId: "PRIVATE JOB" },
  })) }
  return { sourceTurnId: turn, sourceRootTaskId: root, terminalSequence: 20n, terminalXid8: xid8,
    terminalWitnessEventId: `witness-${turn}`, sourceSessionDiffers: true,
    taskGraph: taskGraph as unknown as ValidatedRootTaskHistoryOutcome["taskGraph"] }
}

describe("root task history objective snapshot codec", () => {
  it("binds the identity to fence objective, canonical origin, authorization, revision and no-steer evidence", () => {
    const identity = createRootTaskHistoryObjectiveSnapshotIdentity(identityInput)
    expect(identity).toMatchObject({ sessionId: "session-current", userId: "user-1", authorizationEventId: auth.eventId,
      consentVersion: 7, gateEnabledAtCapture: false, objectiveDigest: "a".repeat(64), canonicalOrigin: '["user","none"]',
      intentKind: null, intentVersion: null, acceptedInputRevision: "0", steerEvidence: "no_accepted_steer",
      startWitnessEventId: "start-witness", startWitnessXid8: "100" })
    expect(rootTaskHistoryObjectiveSnapshotKey(identity!)).not.toBe(rootTaskHistoryObjectiveSnapshotKey({ ...identity!, acceptedInputRevision: "1" }))
    expect(createRootTaskHistoryObjectiveSnapshotIdentity({ ...identityInput, authorization: { ...auth, userId: "other" } })).toBeNull()
    expect(createRootTaskHistoryObjectiveSnapshotIdentity({ ...identityInput, steerEvidence: { kind: "accepted_steer" } })).toBeNull()
    expect(createRootTaskHistoryObjectiveSnapshotIdentity({ ...identityInput, fence: { ...fence, objectiveDigest: "bad" } })).toBeNull()
    expect(createRootTaskHistoryObjectiveSnapshotIdentity({ ...identityInput, fence: { ...fence, currentStartWitness: undefined } })).toBeNull()
    expect(rootTaskHistoryObjectiveSnapshotKey(identity!)).not.toBe(rootTaskHistoryObjectiveSnapshotKey({ ...identity!, startWitnessXid8: "101" }))
  })

  it("keys and replays persisted snapshots only for the exact canonical origin and typed intent", () => {
    const noIntent = createRootTaskHistoryObjectiveSnapshotIdentity(identityInput)!
    const intent = { kind: "interactive_discovery_shortlist", version: 1 }
    const userOrigin = rootTaskHistoryOrigin("user", { intent })!
    const automationOrigin = rootTaskHistoryOrigin("automation", { intent })!
    const typedIntent = createRootTaskHistoryObjectiveSnapshotIdentity({ ...identityInput, fence: {
      ...fence, currentOrigin: userOrigin,
    } })!
    const sameIntentDifferentOrigin = createRootTaskHistoryObjectiveSnapshotIdentity({ ...identityInput, fence: {
      ...fence, currentOrigin: automationOrigin,
    } })!

    expect(typedIntent).toMatchObject({ canonicalOrigin: '["user","interactive_discovery_shortlist",1]',
      intentKind: "interactive_discovery_shortlist", intentVersion: 1 })
    expect(sameIntentDifferentOrigin).toMatchObject({ canonicalOrigin: '["automation","interactive_discovery_shortlist",1]',
      intentKind: "interactive_discovery_shortlist", intentVersion: 1 })
    expect(rootTaskHistoryObjectiveSnapshotKey(noIntent)).not.toBe(rootTaskHistoryObjectiveSnapshotKey(typedIntent))
    expect(rootTaskHistoryObjectiveSnapshotKey(typedIntent)).not.toBe(rootTaskHistoryObjectiveSnapshotKey(sameIntentDifferentOrigin))

    const typedPayload = createRootTaskHistoryObjectiveSnapshotPayload(typedIntent, [])!
    const otherOriginPayload = createRootTaskHistoryObjectiveSnapshotPayload(sameIntentDifferentOrigin, [])!
    expect(typedPayload).toMatchObject({ canonicalOrigin: typedIntent.canonicalOrigin,
      intentKind: typedIntent.intentKind, intentVersion: typedIntent.intentVersion, outcomes: [] })
    expect(readRootTaskHistoryObjectiveSnapshotPayload(typedPayload, typedIntent)).toEqual([])
    expect(readRootTaskHistoryObjectiveSnapshotPayload(typedPayload, noIntent)).toBeNull()
    expect(readRootTaskHistoryObjectiveSnapshotPayload(typedPayload, sameIntentDifferentOrigin)).toBeNull()
    expect(readRootTaskHistoryObjectiveSnapshotPayload(otherOriginPayload, typedIntent)).toBeNull()
    expect(createRootTaskHistoryObjectiveSnapshotIdentity({ ...identityInput, fence: {
      ...fence, currentOrigin: JSON.stringify(["user", "interactive_discovery_shortlist", 2]),
    } })).toBeNull()
    expect(createRootTaskHistoryObjectiveSnapshotIdentity({ ...identityInput, fence: {
      ...fence, currentOrigin: JSON.stringify(["user", "other_intent", 1]),
    } })).toBeNull()
  })

  it("stores only ordered minimal prior-session projections and strips raw graph and Scout query data", () => {
    const identity = createRootTaskHistoryObjectiveSnapshotIdentity(identityInput)!
    const payload = createRootTaskHistoryObjectiveSnapshotPayload(identity, [
      outcome("older", "root-old", "9", 4),
      outcome("latest", "root-latest", "10", 4),
      outcome("oldest", "root-oldest", "2", 4),
    ])
    expect(payload).not.toBeNull()
    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThanOrEqual(8192)
    const serialized = JSON.stringify(payload)
    for (const privateValue of ["PRIVATE RAW GOAL", "PRIVATE QUERY", "PRIVATE LOCATION", "PRIVATE CURSOR", "PRIVATE JOB", "discoveryQueryFootprint", "resultProjection"]) {
      expect(serialized).not.toContain(privateValue)
    }
    const replay = readRootTaskHistoryObjectiveSnapshotPayload(payload, identity)
    expect(replay).toHaveLength(2)
    expect(replay?.map(value => value.sourceTurnId)).toEqual(["latest", "older"])
    expect(replay?.reduce((sum, value) => sum + value.taskGraph.nodes.length, 0)).toBe(8)
    expect(replay?.map(value => value.terminalXid8)).toEqual(["10", "9"])
    const block = projectRootTaskHistory(replay!, true)
    expect(JSON.stringify(block)).not.toContain("discoveryQueryFootprint")
    expect(JSON.stringify(block)).not.toContain("PRIVATE")
  })

  it("persists an empty array as a valid immutable value and rejects unsafe source outcomes", () => {
    const identity = createRootTaskHistoryObjectiveSnapshotIdentity(identityInput)!
    const empty = createRootTaskHistoryObjectiveSnapshotPayload(identity, [])
    expect(readRootTaskHistoryObjectiveSnapshotPayload(empty, identity)).toEqual([])
    expect(createRootTaskHistoryObjectiveSnapshotPayload(identity, [
      { ...outcome("same-session", "root", "50"), sourceSessionDiffers: false },
    ])).toBeNull()
    expect(createRootTaskHistoryObjectiveSnapshotPayload(identity, [outcome("future", "root", "100")])).toBeNull()
    expect(createRootTaskHistoryObjectiveSnapshotPayload(identity, [outcome("malformed-xid", "root", "010")])).toBeNull()
  })

  it("fails replay closed on signature, schema, chronology, node-bound, or footprint tampering", () => {
    const identity = createRootTaskHistoryObjectiveSnapshotIdentity(identityInput)!
    const payload = createRootTaskHistoryObjectiveSnapshotPayload(identity, [outcome("source", "root", "90")])!
    expect(readRootTaskHistoryObjectiveSnapshotPayload(payload, { ...identity, objectiveDigest: "b".repeat(64) })).toBeNull()
    const extra = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
    const outcomes = extra.outcomes as Array<Record<string, unknown>>
    const graph = outcomes[0]!.taskGraph as { nodes: Array<Record<string, unknown>> }
    graph.nodes[0]!.discoveryQueryFootprint = { location: "hidden" }
    expect(readRootTaskHistoryObjectiveSnapshotPayload(extra, identity)).toBeNull()
    const future = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
    const futureOutcomes = future.outcomes as Array<Record<string, unknown>>
    futureOutcomes[0]!.terminalXid8 = "100"
    expect(readRootTaskHistoryObjectiveSnapshotPayload(future, identity)).toBeNull()
    const legacy = { ...JSON.parse(JSON.stringify(payload)), schemaVersion: "agent-harness.v2.root-task-history-objective-snapshot.v1" }
    expect(readRootTaskHistoryObjectiveSnapshotPayload(legacy, identity)).toBeNull()
  })
})
