import { beforeEach, describe, expect, it, vi } from "vitest"
import type { TaskGraphObjectiveLineageNode } from "../planning/task-graph-objective-lineage.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2 } from "../planning/task-graph-verification.js"
import type { TaskGraphScheduleInput } from "./task-graph-command-port.js"
import type { PreparedSteeringReconciliation } from "./steering-reconciliation-contract.js"
import { loadTaskGraph } from "./task-graph-pg-state.js"
import { readTaskGraphConfirmedLocationSteer } from "./task-graph-confirmed-location-steer.js"
import { resolveTaskGraphCurrentLocationEvidence, type TaskGraphCurrentLocationEvidenceResult } from "./task-graph-current-location-evidence.js"
import { readSteeringReconciliationState } from "./steering-reconciliation-read.js"
import { buildTaskGraphLocationCoverageNodes, canRetainCompatiblePriorScouts, evaluateTaskGraphPlanObjectiveCoverage } from "./task-graph-plan-objective-coverage.js"
import { classifyPendingSupersededScouts } from "./task-graph-pending-scout-scope.js"

const { pendingScope } = vi.hoisted(() => ({ pendingScope: vi.fn() }))

vi.mock("./task-graph-pg-state.js", () => ({ loadTaskGraph: vi.fn() }))
vi.mock("./task-graph-confirmed-location-steer.js", () => ({ readTaskGraphConfirmedLocationSteer: vi.fn() }))
vi.mock("./task-graph-current-location-evidence.js", () => ({ resolveTaskGraphCurrentLocationEvidence: vi.fn() }))
vi.mock("./steering-reconciliation-read.js", () => ({ readSteeringReconciliationState: vi.fn() }))
vi.mock("./task-graph-pending-scout-scope.js", () => ({ classifyPendingSupersededScouts: pendingScope }))

const client = { query: vi.fn() } as never
const scope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "step-1", turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "root-owner", parentAttemptCount: 1,
}
const requirements = { status: "valid" as const, requirements: [
  { id: "candidate-count", kind: "candidate_count_gte" as const, minimum: 1 },
] }
const scout = (key: string, dependsOn: readonly string[] = []): TaskGraphObjectiveLineageNode => ({
  key, templateId: "scout", dependsOn, verification: {
    schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
    criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }],
  },
})
const locationScout = (key: string, locations: readonly string[]): TaskGraphObjectiveLineageNode => ({
  key, templateId: "scout", dependsOn: [], verificationDisposition: "typed", verification: {
    schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2, role: "scout",
    criteria: [{ id: "candidate-location", check: { kind: "candidate_location_in", locations } }],
  },
})
const analyst = (key: string, dependsOn: readonly string[] = []): TaskGraphObjectiveLineageNode => ({ key, templateId: "analyst", dependsOn })
const input = (verificationRequirements: TaskGraphScheduleInput["verificationRequirements"] = requirements): TaskGraphScheduleInput => ({
  scope, proposal: { expectedRevision: 1, nodes: [{ key: "new-analysis", templateId: "analyst", goal: "Analyze", successCriteria: ["done"], dependsOn: [] }] },
  templates: { scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] },
    analyst: { role: "analyst", taskType: "analysis", allowedActions: [] } }, verificationRequirements,
})
const provenance = { sourceInputCheckpointByNodeKey: new Map(), currentInputCheckpoint: { inputThroughSequence: 100n } }
const confirmed = { kind: "confirmed" as const, locations: ["dublin"], acceptedInputSequence: 100n }
const available = (compatible: string[], excluded: string[]): Extract<TaskGraphCurrentLocationEvidenceResult, { status: "available" }> => ({
  status: "available", effectiveRequirements: { status: "valid", requirements: [
    { id: "candidate-location", kind: "candidate_location_in", locations: ["dublin"] },
  ] }, compatibleRetainedNodeKeys: new Set(compatible), excludedHistoricalNodeKeys: new Set(excluded),
})
const reconciliationState = {
  originalInputId: null, currentRevision: 1, decisionStepId: scope.stepId, decisionStepOrdinal: 1,
  decisionStepAttempt: 1, decisionInputThroughSequence: 100n, agendaPlanRevision: 1, unresolvedInputs: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(readSteeringReconciliationState).mockResolvedValue(reconciliationState)
  vi.mocked(readTaskGraphConfirmedLocationSteer).mockResolvedValue({ kind: "absent" })
  vi.mocked(loadTaskGraph).mockResolvedValue({} as never)
  vi.mocked(resolveTaskGraphCurrentLocationEvidence).mockResolvedValue({ status: "unavailable" })
  pendingScope.mockReturnValue({ status: "unavailable" })
})

describe("TaskGraph plan objective coverage", () => {
  it("allows independently reverified Scout reuse after a valid keep of the confirmed steer", () => {
    expect(canRetainCompatiblePriorScouts({
      ...reconciliationState, lastReconciledInputThroughSequence: 100n,
    }, 100n)).toBe(true)
  })

  it("keeps legacy coverage when the scoped E2 location event is absent", async () => {
    const nodes = [scout("old-scout")]
    const result = await evaluateTaskGraphPlanObjectiveCoverage({ client, input: input(), nodes, provenance })
    expect(result).toEqual({ status: "covered" })
    expect(readTaskGraphConfirmedLocationSteer).toHaveBeenCalledWith(client, {
      userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
    }, 100n)
    expect(readSteeringReconciliationState).not.toHaveBeenCalled()
    expect(loadTaskGraph).not.toHaveBeenCalled()
  })

  it("keeps direct in-memory callers on the existing coverage path", async () => {
    const nodes = [scout("old-scout")]
    await expect(evaluateTaskGraphPlanObjectiveCoverage({ client, input: input(), nodes })).resolves.toEqual({ status: "covered" })
    expect(readSteeringReconciliationState).not.toHaveBeenCalled()
  })

  it.each([
    ["pending", { kind: "pending" }],
    ["unavailable", { kind: "unavailable" }],
  ] as const)("fails closed when confirmed location steering is %s", async (_label, result) => {
    vi.mocked(readTaskGraphConfirmedLocationSteer).mockResolvedValue(result)
    await expect(evaluateTaskGraphPlanObjectiveCoverage({ client, input: input(), nodes: [], provenance }))
      .rejects.toMatchObject({ code: `task_graph_current_location_steer_${result.kind}` })
    expect(loadTaskGraph).not.toHaveBeenCalled()
  })

  it("uses same-transaction evidence and a temporary retained-Scout projection", async () => {
    const prior = scout("prior-scout"), historical = scout("historical-scout")
    const nodes = [prior, historical]
    vi.mocked(readTaskGraphConfirmedLocationSteer).mockResolvedValue(confirmed)
    vi.mocked(readSteeringReconciliationState).mockResolvedValue({
      ...reconciliationState, lastReconciledInputThroughSequence: 100n,
      latestUserRevision: { resultingRevision: 2, stepId: "step-0", inputThroughSequence: 100n, soleSteerSequence: 100n },
    })
    vi.mocked(resolveTaskGraphCurrentLocationEvidence).mockResolvedValue(available(["prior-scout"], ["historical-scout"]))

    await expect(evaluateTaskGraphPlanObjectiveCoverage({
      client, input: input({ status: "absent" }), nodes, provenance,
    })).resolves.toEqual({ status: "covered" })

    expect(loadTaskGraph).toHaveBeenCalledWith(client, scope, false, {
      includeSourceProvenance: true, currentStepId: scope.stepId, currentStepAttempt: 1,
    })
    expect(resolveTaskGraphCurrentLocationEvidence).toHaveBeenCalledWith(expect.objectContaining({
      client, acceptedInputSequence: 100n, retainCompatiblePriorScouts: true,
    }))
    expect(readSteeringReconciliationState).toHaveBeenCalledWith(client, scope)
    expect(readTaskGraphConfirmedLocationSteer).toHaveBeenCalledTimes(2)
    const projected = buildTaskGraphLocationCoverageNodes(nodes, available(["prior-scout"], ["historical-scout"]))
    expect(projected.map(node => node.key)).toEqual(["prior-scout"])
    expect(projected[0]?.verification).toMatchObject({
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2,
      criteria: [{ id: "candidate-count" }, { id: "candidate-location", check: { kind: "candidate_location_in", locations: ["dublin"] } }],
    })
    expect(prior.verification?.criteria).toHaveLength(1)
  })

  it("filters an admitted running Scout only from plan coverage and keeps its key out of history", async () => {
    const nodes = [locationScout("old-scout", ["berlin"]), locationScout("new-scout", ["dublin"])]
    vi.mocked(readTaskGraphConfirmedLocationSteer).mockResolvedValue(confirmed)
    vi.mocked(readSteeringReconciliationState).mockResolvedValue({
      ...reconciliationState, unresolvedInputs: [{ id: "input-1", acceptedSequence: 100n, status: "consumed",
        consumedByStepId: scope.stepId, consumingOrdinal: 1 }],
    })
    pendingScope.mockReturnValue({ status: "available", pendingNodeKeys: new Set(["old-scout"]) })
    vi.mocked(resolveTaskGraphCurrentLocationEvidence).mockResolvedValue(available([], []))

    await expect(evaluateTaskGraphPlanObjectiveCoverage({ client, input: input({ status: "absent" }), nodes, provenance,
      prepared: { decision: "revise" } as PreparedSteeringReconciliation })).resolves.toEqual({ status: "covered" })

    expect(classifyPendingSupersededScouts).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 1, confirmed, reconciliation: expect.objectContaining({ unresolvedInputs: expect.any(Array) }), nodes,
    }))
    expect(vi.mocked(resolveTaskGraphCurrentLocationEvidence).mock.calls[0]?.[0].pendingSupersededNodeKeys)
      .toEqual(new Set(["old-scout"]))
    expect(available([], []).excludedHistoricalNodeKeys).toEqual(new Set())
  })

  it("keeps verified completed-Scout reuse when the pending partition is unavailable", async () => {
    const nodes = [locationScout("completed-scout", ["berlin"])]
    vi.mocked(readTaskGraphConfirmedLocationSteer).mockResolvedValue(confirmed)
    vi.mocked(readSteeringReconciliationState).mockResolvedValue({
      ...reconciliationState, lastReconciledInputThroughSequence: 90n,
      unresolvedInputs: [{ id: "input-1", acceptedSequence: 100n, status: "consumed",
        consumedByStepId: scope.stepId, consumingOrdinal: 1 }],
    })
    pendingScope.mockReturnValue({ status: "unavailable" })
    vi.mocked(resolveTaskGraphCurrentLocationEvidence).mockResolvedValue(available(["completed-scout"], []))

    await expect(evaluateTaskGraphPlanObjectiveCoverage({ client, input: input({ status: "absent" }), nodes, provenance,
      prepared: { decision: "revise" } as PreparedSteeringReconciliation })).resolves.toEqual({ status: "covered" })
    expect(vi.mocked(resolveTaskGraphCurrentLocationEvidence).mock.calls[0]?.[0].pendingSupersededNodeKeys).toEqual(new Set())
  })

  it("rechecks a pending typed steer against the exact current Step cursor", async () => {
    const nodes = [scout("prior-scout")]
    vi.mocked(readTaskGraphConfirmedLocationSteer)
      .mockResolvedValueOnce({ kind: "pending" })
      .mockResolvedValueOnce({ ...confirmed, acceptedInputSequence: 150n })
    vi.mocked(readSteeringReconciliationState).mockResolvedValue({
      ...reconciliationState, decisionInputThroughSequence: 150n, lastReconciledInputThroughSequence: 150n,
      latestUserRevision: { resultingRevision: 2, stepId: "step-0", inputThroughSequence: 150n, soleSteerSequence: 150n },
    })
    vi.mocked(resolveTaskGraphCurrentLocationEvidence).mockResolvedValue(available(["prior-scout"], []))

    await expect(evaluateTaskGraphPlanObjectiveCoverage({
      client, input: input({ status: "absent" }), nodes, provenance,
    })).resolves.toEqual({ status: "covered" })
    expect(vi.mocked(readTaskGraphConfirmedLocationSteer).mock.calls.map(call => call[2])).toEqual([100n, 150n])
    expect(vi.mocked(readSteeringReconciliationState).mock.calls[0]?.[1]).toBe(scope)
  })

  it("retains prior Scouts when the confirmed steer is the only pending input and no material revision precedes it", async () => {
    const nodes = [scout("prior-scout")]
    vi.mocked(readTaskGraphConfirmedLocationSteer).mockResolvedValue(confirmed)
    vi.mocked(readSteeringReconciliationState).mockResolvedValue({
      ...reconciliationState, lastReconciledInputThroughSequence: 90n,
      unresolvedInputs: [{ id: "input-1", acceptedSequence: 100n, status: "consumed", consumedByStepId: "step-1", consumingOrdinal: 1 }],
    })
    vi.mocked(resolveTaskGraphCurrentLocationEvidence).mockResolvedValue(available(["prior-scout"], []))

    await expect(evaluateTaskGraphPlanObjectiveCoverage({
      client, input: input({ status: "absent" }), nodes, provenance,
    })).resolves.toEqual({ status: "covered" })
    expect(vi.mocked(resolveTaskGraphCurrentLocationEvidence).mock.calls[0]?.[0].retainCompatiblePriorScouts).toBe(true)
  })

  it("retains prior Scouts when the latest revision is the same sole steer with no earlier material revision", async () => {
    const nodes = [scout("prior-scout")]
    vi.mocked(readTaskGraphConfirmedLocationSteer).mockResolvedValue(confirmed)
    vi.mocked(readSteeringReconciliationState).mockResolvedValue({
      ...reconciliationState, lastReconciledInputThroughSequence: 100n,
      latestUserRevision: { resultingRevision: 2, stepId: "step-0", inputThroughSequence: 100n, soleSteerSequence: 100n },
    })
    vi.mocked(resolveTaskGraphCurrentLocationEvidence).mockResolvedValue(available(["prior-scout"], []))

    await expect(evaluateTaskGraphPlanObjectiveCoverage({
      client, input: input({ status: "absent" }), nodes, provenance,
    })).resolves.toEqual({ status: "covered" })
    expect(vi.mocked(resolveTaskGraphCurrentLocationEvidence).mock.calls[0]?.[0].retainCompatiblePriorScouts).toBe(true)
  })

  it("rejects a newly proposed node with a transitive dependency on an excluded Scout", async () => {
    const nodes = [scout("old-scout"), analyst("bridge", ["old-scout"]), analyst("new-analysis", ["bridge"])]
    vi.mocked(readTaskGraphConfirmedLocationSteer).mockResolvedValue(confirmed)
    vi.mocked(resolveTaskGraphCurrentLocationEvidence).mockResolvedValue(available([], ["old-scout"]))
    const request = { ...input({ status: "absent" }), proposal: { expectedRevision: 1, nodes: [{
      key: "new-analysis", templateId: "analyst", goal: "Analyze", successCriteria: ["done"], dependsOn: ["bridge"],
    }] } }

    await expect(evaluateTaskGraphPlanObjectiveCoverage({ client, input: request, nodes, provenance }))
      .rejects.toMatchObject({ code: "task_graph_dependency_unverified" })
  })
})
