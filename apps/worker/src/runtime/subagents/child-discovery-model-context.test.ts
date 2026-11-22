import { describe, expect, it, vi } from "vitest"
import type { ChildContextBuilder } from "./child-context.js"
import type { ChildPublicDefinition } from "./child-executor-admission.js"
import type { ContextSeedBlock, StepContextSnapshot } from "../context/step-context-builder.js"
import type { StructuredRole } from "./role-results.js"
import type { SubagentLease } from "./types.js"
import { createChildDiscoveryModelContextBuilder } from "./child-discovery-model-context.js"

const historyProjection = vi.hoisted(() => ({
  project: vi.fn((observations: readonly ContextSeedBlock[]): readonly ContextSeedBlock[] =>
    observations.filter(observation => observation.id !== "transport-chunk")),
}))
vi.mock("./child-discovery-history.js", () => ({ projectChildDiscoveryHistory: historyProjection.project }))

const wait: ContextSeedBlock = { id: "child-resume:wait", content: { toolName: "wait_subagents", output: { status: "ready" } } }
const chunk: ContextSeedBlock = { id: "transport-chunk", content: { toolName: "tool_results.read" } }
const snapshot: StepContextSnapshot = { system: [], profile: [], goal: undefined, steerHistory: [], businessRefs: [], toolObservations: [wait, chunk] }
const lease = { id: "child-a", role: "scout", taskType: "job_discovery", allowedActions: ["jobs.discover", "tool_results.read"], context: {} } as SubagentLease
const owner = { kind: "task", userId: "user-a", sessionId: "session-a", turnId: "turn-a", taskId: "child-a", rootTaskId: "root-a", ownerId: "owner-a", attemptCount: 1,
  leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z") } as const
const definitions = [
  { name: "jobs.discover", version: "1" }, { name: "tool_results.read", version: "1" },
] as unknown as readonly ChildPublicDefinition[]
type Input = Parameters<typeof createChildDiscoveryModelContextBuilder>[1]

function setup(overrides: Partial<Input> = {}) {
  const calls: Parameters<ChildContextBuilder["build"]>[0][] = []
  const builder: ChildContextBuilder = {
    build: async request => { calls.push(request); return {} as Awaited<ReturnType<ChildContextBuilder["build"]>> },
    getMailboxMessageIds: () => [],
  }
  const input: Input = { lease, structuredRole: "scout", selectedJob: undefined, selectedJobPreparation: undefined, definitions, ...overrides }
  return { calls, builder, input, decorated: createChildDiscoveryModelContextBuilder(builder, input) }
}

function request(snapshotOverride = snapshot): Parameters<ChildContextBuilder["build"]>[0] {
  return { scope: { userId: "user-a" }, identity: owner, stepId: "step-a", snapshot: snapshotOverride }
}

describe("child discovery model context", () => {
  it("keeps the original request when history projection is a no-op", async () => {
    historyProjection.project.mockReturnValueOnce(snapshot.toolObservations)
    const test = setup()
    const originalRequest = request()
    await test.decorated.build(originalRequest)
    expect(test.calls[0]).toBe(originalRequest)
  })

  it("projects only the builder snapshot and preserves the exact Wait block", async () => {
    historyProjection.project.mockClear()
    const test = setup()
    await test.decorated.build(request())
    expect(historyProjection.project).toHaveBeenCalledWith([wait, chunk])
    const forwarded = test.calls[0]!.snapshot
    expect(forwarded.toolObservations).toEqual([wait])
    expect(forwarded.toolObservations[0]).toBe(wait)
    expect(forwarded.profile).toBe(snapshot.profile)
    expect(snapshot.toolObservations).toEqual([wait, chunk])
  })

  it.each([
    ["other role", { lease: { ...lease, role: "analyst" } as SubagentLease }],
    ["missing structured role", { structuredRole: undefined }],
    ["selected job", { selectedJob: "job-a" }],
    ["selected preparation", { selectedJobPreparation: { jobId: "job-a" } }],
    ["missing allowed action", { lease: { ...lease, allowedActions: ["jobs.discover"] } as SubagentLease }],
    ["missing discover tool", { definitions: [{ name: "tool_results.read", version: "1" }] as unknown as readonly ChildPublicDefinition[] }],
    ["missing chunk reader", { definitions: [{ name: "jobs.discover", version: "1" }] as unknown as readonly ChildPublicDefinition[] }],
    ["wrong tool version", { definitions: [{ name: "jobs.discover", version: "2" }, { name: "tool_results.read", version: "1" }] as unknown as readonly ChildPublicDefinition[] }],
  ] as const)("leaves other executions unchanged: %s", async (_label, overrides) => {
    historyProjection.project.mockClear()
    const test = setup(overrides)
    expect(test.decorated).toBe(test.builder)
    await test.decorated.build(request())
    expect(test.calls[0]!.snapshot).toBe(snapshot)
    expect(historyProjection.project).not.toHaveBeenCalled()
  })
})
