import type pg from "pg"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import type { RootTaskVerificationRequirement, RootTaskVerificationRequirementsResolution } from "../context/root-task-objective.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import type { GraphIdentityScope, GraphTaskRow, LoadedGraph } from "./task-graph-pg-state.js"
import { parseTaskGraphSnapshot, taskGraphItemId, taskGraphState, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { resolveTaskGraphCurrentLocationEvidence } from "./task-graph-current-location-evidence.js"

const { reproof } = vi.hoisted(() => ({ reproof: vi.fn() }))
vi.mock("./task-graph-retained-scout-location-proof.js", () => ({
  verifyTaskGraphRetainedScoutLocationProof: reproof,
}))

const scope: GraphIdentityScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
}
const client = { query: vi.fn() } as unknown as Pick<pg.PoolClient, "query">
const scoutVerification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout" as const,
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: 1 } }],
}
const roleResult = {
  schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "partial",
  candidates: [{ jobId: "job-1", source: "greenhouse", url: null, evidenceIds: ["job-ref"] }],
  evidence: [{ id: "job-ref", kind: "job", ref: "job-1", source: "greenhouse" }], summary: "Partial result",
}
const location = (locations: readonly string[]): RootTaskVerificationRequirement => ({
  id: "candidate-location", kind: "candidate_location_in", locations,
})
const initialRequirements: RootTaskVerificationRequirementsResolution = {
  status: "valid",
  requirements: [
    { id: "candidate-count", kind: "candidate_count_gte", minimum: 2 },
    location(["berlin"]),
    { id: "finding-count", kind: "finding_count_gte", minimum: 1 },
  ],
}

type NodeFixture = Readonly<{
  key: string
  taskId: string
  checkpoint?: bigint | null
  status?: GraphTaskRow["status"]
  failureReason?: string | null
  taskType?: string
  role?: string
  result?: unknown
  typed?: boolean
}>

function loadedGraph(specs: readonly NodeFixture[] = [], options: Readonly<{ provenance?: boolean }> = {}): LoadedGraph {
  const snapshot = parseTaskGraphSnapshot({
    schemaVersion: "agent-harness.v2.task-graph",
    nodes: specs.map((spec, index) => ({
      key: spec.key, templateId: "scout", goal: "Find roles", successCriteria: ["Find candidates"],
      dependsOn: [], depth: index + 1, taskId: spec.taskId,
      verificationDisposition: spec.typed === false ? "legacy_unverified" : "typed",
      ...(spec.typed === false ? {} : { verification: scoutVerification }),
    })),
  })
  const tasks = new Map<string, GraphTaskRow>(specs.map(spec => [spec.taskId, {
    id: spec.taskId, role: spec.role ?? "scout", taskType: spec.taskType ?? "job_discovery",
    status: spec.status ?? "completed", failureReason: spec.failureReason ?? null,
    attemptCount: 1, result: spec.result ?? { status: "completed", structuredResult: roleResult },
  }]))
  const statuses = new Map([...tasks].map(([id, task]) => [id, {
    status: task.status, failureReason: task.failureReason,
  }] as const))
  const revision = 1
  return {
    rootTaskId: scope.rootTaskId, snapshot,
    item: { id: taskGraphItemId(scope.parentTaskId), revision, content: snapshot, createdAt: null },
    state: taskGraphState(snapshot, revision, statuses, []), tasks,
    ...(options.provenance === false ? {} : {
      sourceInputCheckpointByNodeKey: new Map(specs.map(spec => [
        spec.key, spec.checkpoint === undefined || spec.checkpoint === null
          ? spec.checkpoint ?? null : { inputThroughSequence: spec.checkpoint },
      ])),
    }),
  }
}

function input(loaded: LoadedGraph, overrides: Partial<Parameters<typeof resolveTaskGraphCurrentLocationEvidence>[0]> = {}) {
  return {
    client, loaded, scope, initialRequirements, verifiedCurrentLocations: ["dublin"],
    acceptedInputSequence: 20n, retainCompatiblePriorScouts: true, ...overrides,
  }
}

beforeEach(() => reproof.mockReset())

describe("current location evidence", () => {
  it("replaces only the canonical location requirement and preserves count requirements", async () => {
    const loaded = loadedGraph()
    const result = await resolveTaskGraphCurrentLocationEvidence(input(loaded))

    expect(result).toMatchObject({ status: "available", effectiveRequirements: { status: "valid" } })
    if (result.status !== "available") return
    expect(result.effectiveRequirements.requirements).toEqual([
      { id: "candidate-count", kind: "candidate_count_gte", minimum: 2 },
      { id: "candidate-location", kind: "candidate_location_in", locations: ["dublin"] },
      { id: "finding-count", kind: "finding_count_gte", minimum: 1 },
    ])
    expect(result.compatibleRetainedNodeKeys.size).toBe(0)
    expect(result.excludedHistoricalNodeKeys.size).toBe(0)
  })

  it("adds a canonical location requirement when initial requirements are absent", async () => {
    const result = await resolveTaskGraphCurrentLocationEvidence(input(loadedGraph(), {
      initialRequirements: { status: "absent" },
    }))

    expect(result).toMatchObject({
      status: "available",
      effectiveRequirements: { status: "valid", requirements: [location(["dublin"])] },
    })
  })

  it("retains only independently compatible older Scouts and leaves current nodes to their caller", async () => {
    const loaded = loadedGraph([
      { key: "old-scout", taskId: "old-task", checkpoint: 10n },
      { key: "current-scout", taskId: "current-task", checkpoint: 20n, status: "running" },
    ])
    reproof.mockResolvedValue({ status: "compatible" })
    const before = JSON.stringify(loaded.snapshot)
    const result = await resolveTaskGraphCurrentLocationEvidence(input(loaded))

    expect(result.status).toBe("available")
    if (result.status !== "available") return
    expect(result.compatibleRetainedNodeKeys).toEqual(new Set(["old-scout"]))
    expect(result.excludedHistoricalNodeKeys).toEqual(new Set())
    expect(reproof).toHaveBeenCalledOnce()
    expect(reproof.mock.calls[0]?.[0]).toMatchObject({
      scope: { userId: scope.userId, rootTaskId: scope.rootTaskId, taskId: "old-task", attemptCount: 1 },
      requirement: { id: "candidate-location", locations: ["dublin"] },
    })
    expect(JSON.stringify(loaded.snapshot)).toBe(before)
  })

  it("excludes older completed Scouts whose compatibility evidence mismatches or is unavailable", async () => {
    const loaded = loadedGraph([
      { key: "mismatch", taskId: "mismatch-task", checkpoint: 10n },
      { key: "unknown", taskId: "unknown-task", checkpoint: 11n },
    ])
    reproof.mockResolvedValueOnce({ status: "incompatible" }).mockResolvedValueOnce({ status: "unavailable" })
    const result = await resolveTaskGraphCurrentLocationEvidence(input(loaded))

    expect(result.status).toBe("available")
    if (result.status !== "available") return
    expect(result.compatibleRetainedNodeKeys.size).toBe(0)
    expect(result.excludedHistoricalNodeKeys).toEqual(new Set(["mismatch", "unknown"]))
  })

  it("excludes sound older completed Scouts when compatible retention is disabled", async () => {
    const loaded = loadedGraph([{ key: "old-scout", taskId: "old-task", checkpoint: 10n }])
    const result = await resolveTaskGraphCurrentLocationEvidence(input(loaded, { retainCompatiblePriorScouts: false }))

    expect(result.status).toBe("available")
    if (result.status !== "available") return
    expect(result.excludedHistoricalNodeKeys).toEqual(new Set(["old-scout"]))
    expect(result.compatibleRetainedNodeKeys.size).toBe(0)
    expect(reproof).not.toHaveBeenCalled()
  })

  it("returns unavailable for an older nonterminal Scout instead of classifying it historical", async () => {
    const loaded = loadedGraph([{ key: "active-scout", taskId: "active-task", checkpoint: 10n, status: "running" }])
    expect(await resolveTaskGraphCurrentLocationEvidence(input(loaded))).toEqual({ status: "unavailable" })
    expect(reproof).not.toHaveBeenCalled()
  })

  it("skips only a separately validated plan-pending Scout without calling it historical", async () => {
    const loaded = loadedGraph([{ key: "active-scout", taskId: "active-task", checkpoint: 10n, status: "running" }])
    const result = await resolveTaskGraphCurrentLocationEvidence(input(loaded, {
      pendingSupersededNodeKeys: new Set(["active-scout"]),
    }))

    expect(result).toMatchObject({ status: "available" })
    if (result.status !== "available") return
    expect(result.excludedHistoricalNodeKeys).toEqual(new Set())
    expect(result.compatibleRetainedNodeKeys).toEqual(new Set())
    expect(reproof).not.toHaveBeenCalled()
    await expect(resolveTaskGraphCurrentLocationEvidence(input(loaded, {
      pendingSupersededNodeKeys: new Set(["missing-node"]),
    }))).resolves.toEqual({ status: "unavailable" })
  })

  it.each([
    ["task role mismatch", { role: "analyst" }],
    ["task type mismatch", { taskType: "selected_job_discovery" }],
    ["failed task", { failureReason: "failed" }],
    ["unsupported result body", { result: { status: "completed", structuredResult: { role: "writer" } } }],
    ["untyped node", { typed: false }],
  ])("returns unavailable for an older Scout with %s", async (_name, override) => {
    const loaded = loadedGraph([{ key: "old-scout", taskId: "old-task", checkpoint: 10n, ...override }])
    expect(await resolveTaskGraphCurrentLocationEvidence(input(loaded))).toEqual({ status: "unavailable" })
    expect(reproof).not.toHaveBeenCalled()
  })

  it.each([
    ["missing map", loadedGraph([{ key: "scout", taskId: "task" }], { provenance: false })],
    ["missing checkpoint", loadedGraph([{ key: "scout", taskId: "task", checkpoint: null }])],
  ])("fails closed for %s provenance", async (_name, loaded) => {
    expect(await resolveTaskGraphCurrentLocationEvidence(input(loaded))).toEqual({ status: "unavailable" })
  })

  it("keeps the empty graph available without source provenance", async () => {
    const result = await resolveTaskGraphCurrentLocationEvidence(input(loadedGraph([], { provenance: false })))
    expect(result.status).toBe("available")
    expect(reproof).not.toHaveBeenCalled()
  })

  it.each([
    { status: "invalid" } as const,
    { status: "valid", requirements: [location(["berlin"]), { ...location(["paris"]), id: "other-location" }] } as const,
    { status: "valid", requirements: [
      { id: "candidate-count", kind: "candidate_count_gte", minimum: 1 },
      { id: "candidate-count", kind: "finding_count_gte", minimum: 1 },
    ] } as const,
  ])("fails closed for invalid or unsupported initial requirement shapes", async requirements => {
    expect(await resolveTaskGraphCurrentLocationEvidence(input(loadedGraph(), { initialRequirements: requirements })))
      .toEqual({ status: "unavailable" })
  })

  it("fails closed for missing ownership and duplicate graph identities", async () => {
    const base = loadedGraph([
      { key: "one", taskId: "task-one", checkpoint: 21n },
      { key: "two", taskId: "task-two", checkpoint: 21n },
    ])
    const missing = { ...base, tasks: new Map() }
    expect(await resolveTaskGraphCurrentLocationEvidence(input(missing))).toEqual({ status: "unavailable" })

    const snapshot = base.snapshot!
    const duplicateNodes = snapshot.nodes.map((node, index) => index === 1
      ? { ...node, taskId: snapshot.nodes[0]!.taskId } : node)
    const duplicated = {
      ...base,
      snapshot: { ...snapshot, nodes: duplicateNodes } as TaskGraphSnapshot,
      state: { ...base.state!, nodes: base.state!.nodes.map((node, index) => index === 1
        ? { ...node, taskId: base.state!.nodes[0]!.taskId } : node) },
    }
    expect(await resolveTaskGraphCurrentLocationEvidence(input(duplicated))).toEqual({ status: "unavailable" })
  })

  it("does not accept malformed sequence, ownership, or locations as authority", async () => {
    const loaded = loadedGraph()
    expect(await resolveTaskGraphCurrentLocationEvidence(input(loaded, { acceptedInputSequence: 0n })))
      .toEqual({ status: "unavailable" })
    expect(await resolveTaskGraphCurrentLocationEvidence(input(loaded, {
      scope: { ...scope, userId: " user-1 " },
    }))).toEqual({ status: "unavailable" })
    expect(await resolveTaskGraphCurrentLocationEvidence(input(loaded, {
      verifiedCurrentLocations: ["Dublin"],
    }))).toEqual({ status: "unavailable" })
  })
})
