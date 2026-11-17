import { describe, expect, it } from "vitest"
import { Buffer } from "node:buffer"
import { createDiscoveryQueryFootprint } from "../subagents/child-discovery-query-footprint.js"
import { projectRootTaskHistorySearchFootprintContext, parseRootTaskHistorySearchFootprintContext,
  mergeRootTaskHistorySearchFootprintContexts, mergeRootTaskHistorySearchFootprintSources,
  createRootTaskHistorySearchFootprintSnapshotIdentity, rootTaskHistorySearchFootprintSnapshotKey,
  createRootTaskHistorySearchFootprintSnapshotPayload, readRootTaskHistorySearchFootprintSnapshotPayload } from "./root-task-history-search-footprint-context.js"

const verification = { schemaVersion: "agent-harness.v2.task-graph-verification.v1", role: "scout",
  criteria: [{ id: "count", check: { kind: "candidate_count_gte", minimum: 1 } }] }

function scout(overrides: Record<string, unknown> = {}) {
  const criteria = { targetRoles: ["Backend Engineer", "Staff Developer"], targetLocations: ["Dublin", "Berlin"],
    source: "lever" as const, pageSize: 20, hasCursor: true }
  const discoveryQueryFootprint = createDiscoveryQueryFootprint([{ criteria, outcome: "completed", requestCount: 3,
    observedCandidateCount: 12, providerFailures: 1, materializationFailures: 2, hasMore: true }])
  return { templateId: "scout", status: "completed", verification, discoveryQueryFootprint, ...overrides }
}

function graph(nodes: readonly unknown[] = [scout()], eligibility = "ordinary") {
  return { revision: 7, discoveryTurnEligibility: eligibility, nodes }
}

describe("Root task history search-footprint context", () => {
  it("projects only bounded role, location, and allowlisted ATS source names", () => {
    const projected = projectRootTaskHistorySearchFootprintContext(graph() as never)
    expect(projected).toEqual({ roles: ["Backend Engineer", "Staff Developer"], locations: ["Dublin", "Berlin"], atsSources: ["lever"] })
    const serialized = JSON.stringify(projected)
    for (const forbidden of ["pageSize", "hasCursor", "outcome", "requestCount", "observedCandidateCount", "providerFailures",
      "materializationFailures", "hasMore", "cursor", "job", "url", "session", "task"]) expect(serialized).not.toContain(forbidden)
  })

  it("rejects scheduled, malformed, legacy, native, repaired, and unsafe observations", () => {
    const valid = scout()
    const accessor = { ...valid }
    Object.defineProperty(accessor, "discoveryQueryFootprint", { enumerable: true, get: () => valid.discoveryQueryFootprint })
    const malformed = { ...valid, discoveryQueryFootprint: { ...valid.discoveryQueryFootprint, secret: "leak" } }
    const unsafe = { ...valid, discoveryQueryFootprint: createDiscoveryQueryFootprint([{ criteria: {
      targetRoles: ["person@example.com"], targetLocations: ["Dublin"], source: "lever", pageSize: 20, hasCursor: false,
    }, outcome: "completed", requestCount: 1, observedCandidateCount: 1, providerFailures: 0, materializationFailures: 0, hasMore: false }]) }
    const cases = [
      projectRootTaskHistorySearchFootprintContext(graph([valid], "scheduled") as never),
      projectRootTaskHistorySearchFootprintContext({ ...graph([valid]), revision: -1 } as never),
      projectRootTaskHistorySearchFootprintContext(graph([{ ...valid, templateId: "analyst" }]) as never),
      projectRootTaskHistorySearchFootprintContext(graph([{ ...valid, repairOf: {} }]) as never),
      projectRootTaskHistorySearchFootprintContext(graph([{ ...valid, nativeResult: {} }]) as never),
      projectRootTaskHistorySearchFootprintContext(graph([malformed]) as never),
      projectRootTaskHistorySearchFootprintContext(graph([unsafe]) as never),
      projectRootTaskHistorySearchFootprintContext(graph([accessor]) as never),
    ]
    expect(cases.every(value => value === undefined)).toBe(true)
  })

  it("rejects augmented or non-allowlisted persisted projections", () => {
    expect(parseRootTaskHistorySearchFootprintContext({ roles: ["Backend"], locations: [], atsSources: ["lever"], taskId: "x" })).toBeUndefined()
    expect(parseRootTaskHistorySearchFootprintContext({ roles: ["Backend"], locations: [], atsSources: ["unknown"] })).toBeUndefined()
    expect(parseRootTaskHistorySearchFootprintContext({ roles: ["Backend", "Backend"], locations: [], atsSources: [] })).toBeUndefined()
    expect(parseRootTaskHistorySearchFootprintContext({ roles: ["person@example.com"], locations: [], atsSources: [] })).toBeUndefined()
  })

  it("merges newest-first bounded projections deterministically", () => {
    const older = { roles: ["Backend Engineer", "Analyst"], locations: ["Berlin"], atsSources: ["greenhouse"] }
    const newer = { roles: ["Backend Engineer", "Staff Developer"], locations: ["Dublin"], atsSources: ["lever"] }
    expect(mergeRootTaskHistorySearchFootprintContexts([newer, older])).toEqual({
      roles: ["Backend Engineer", "Staff Developer", "Analyst"], locations: ["Dublin", "Berlin"], atsSources: ["lever", "greenhouse"],
    })
  })

  it("orders source graphs by verified chronology and drops all source identity metadata", () => {
    const source = (turn: string, root: string, xid: string, role: string) => ({ sourceTurnId: turn, sourceRootTaskId: root,
      terminalXid8: xid, terminalWitnessEventId: `witness-${turn}`, footprint: { roles: [role], locations: [], atsSources: ["lever"] } })
    const projection = mergeRootTaskHistorySearchFootprintSources([
      source("older-private-turn", "older-private-root", "10", "Analyst"),
      source("newer-private-turn", "newer-private-root", "30", "Backend Engineer"),
      source("future", "future-root", "60", "Future Role"),
      { ...source("bad", "bad-root", "20", "Bad"), queryText: "PRIVATE" },
    ], "50")
    expect(projection).toEqual({ roles: ["Backend Engineer", "Analyst"], locations: [], atsSources: ["lever"] })
    expect(JSON.stringify(projection)).not.toContain("private-turn")
    expect(JSON.stringify(projection)).not.toContain("private-root")
    expect(JSON.stringify(projection)).not.toContain("witness")
    expect(JSON.stringify(projection)).not.toContain("Future Role")
  })

  it("accepts only the canonical v1 objective TaskGraph origin for snapshot identity", () => {
    const input = {
      lease: { userId: "user-a", sessionId: "current-session" },
      authorization: { eventId: "session-auth", sessionId: "current-session", userId: "user-a", consentVersion: 1,
        consentEnabled: false, gateEnabledAtCapture: false },
      searchFootprintReadAllowed: true,
      fence: { currentStartSequence: 4n, searchFootprintStartWitness: { eventId: "footprint-start", xid8: "50" },
        objectiveDigest: "a".repeat(64), searchFootprintOrigin: JSON.stringify(["user", "objective_task_graph_execution", 1]) },
      acceptedInputRevision: 2n, steerEvidence: { kind: "no_accepted_steer" as const },
    }
    const identity = createRootTaskHistorySearchFootprintSnapshotIdentity(input)
    expect(identity).toMatchObject({
      canonicalOrigin: '["user","objective_task_graph_execution",1]',
      intentKind: "objective_task_graph_execution",
      intentVersion: 1,
    })
    expect(createRootTaskHistorySearchFootprintSnapshotIdentity({
      ...input, fence: { ...input.fence, searchFootprintOrigin: JSON.stringify(["user", "objective_task_graph_execution", 2]) },
    })).toBeUndefined()
    expect(createRootTaskHistorySearchFootprintSnapshotIdentity({
      ...input, fence: { ...input.fence, searchFootprintOrigin: '["user","objective_task_graph_execution",1,"extra"]' },
    })).toBeUndefined()
    expect(createRootTaskHistorySearchFootprintSnapshotIdentity({
      ...input, fence: { ...input.fence, searchFootprintOrigin: undefined,
        currentOrigin: '["user","objective_task_graph_execution",1]' },
    })).toBeUndefined()
  })

  it("persists and replays a separate bounded searchFootprints event payload", () => {
    const identity = createRootTaskHistorySearchFootprintSnapshotIdentity({
      lease: { userId: "user-a", sessionId: "current-session" },
      authorization: { eventId: "session-auth", sessionId: "current-session", userId: "user-a", consentVersion: 1,
        consentEnabled: false, gateEnabledAtCapture: false },
      searchFootprintReadAllowed: true,
      fence: { currentStartSequence: 4n, searchFootprintStartWitness: { eventId: "footprint-start", xid8: "50" },
        objectiveDigest: "a".repeat(64), searchFootprintOrigin: '["user","objective_task_graph_execution",1]' },
      acceptedInputRevision: 2n, steerEvidence: { kind: "no_accepted_steer" },
    })!
    const projection = { roles: ["Backend Engineer"], locations: ["Dublin"], atsSources: ["lever"] }
    const payload = createRootTaskHistorySearchFootprintSnapshotPayload(identity, projection)!
    const encoded = JSON.stringify(payload)
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(4096)
    expect(encoded).toContain("searchFootprints")
    expect(encoded).not.toContain("outcomes")
    expect(readRootTaskHistorySearchFootprintSnapshotPayload(payload, identity)).toEqual(projection)
    expect(rootTaskHistorySearchFootprintSnapshotKey(identity)).not.toBe(rootTaskHistorySearchFootprintSnapshotKey({
      ...identity, acceptedInputRevision: "3",
    }))
    expect(createRootTaskHistorySearchFootprintSnapshotIdentity({
      lease: { userId: "user-a", sessionId: "current-session" },
      authorization: { eventId: "session-auth", sessionId: "current-session", userId: "user-a", consentVersion: 1,
        consentEnabled: false, gateEnabledAtCapture: false },
      searchFootprintReadAllowed: false,
      fence: { currentStartSequence: 4n, searchFootprintStartWitness: { eventId: "footprint-start", xid8: "50" },
        objectiveDigest: "a".repeat(64), searchFootprintOrigin: '["user","objective_task_graph_execution",1]' },
      acceptedInputRevision: 2n, steerEvidence: { kind: "no_accepted_steer" },
    })).toBeUndefined()
    const serializedPayload = payload as Record<string, unknown>
    expect(readRootTaskHistorySearchFootprintSnapshotPayload({ ...serializedPayload, outcomes: [] }, identity)).toBeUndefined()
    expect(readRootTaskHistorySearchFootprintSnapshotPayload({ ...serializedPayload, schemaVersion: "legacy" }, identity)).toBeUndefined()
  })
})
