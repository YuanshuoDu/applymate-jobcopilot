import { beforeEach, describe, expect, it, vi } from "vitest"
import type { TenantScope } from "@jobcopilot/agent-protocol"
import type { StepContext, StepContextRequest } from "./context/step-context-builder.js"
import type { DirectRootTaskHistoryReader } from "./canonical-turn-root-task-history.js"
import type { TurnLease } from "./turns/lease.js"
import { buildCognitiveActionAgenda } from "./turns/cognitive-action-agenda.js"
import { contextToModelMessages } from "./turns/turn-engine-messages.js"
import { progressCheckpointFromStepContext } from "./progress.js"
import { createCanonicalTurnContextBuilder } from "./canonical-turn-context-builder.js"
import type { PrivateSponsorshipContextEntry } from "./subagents/sponsorship-private-context-reader.js"
import { SPONSORSHIP_OBSERVATION_PUBLIC_SCHEMA, SPONSORSHIP_OBSERVATION_SCHEMA } from "./subagents/sponsorship-observation-contract.js"

const reader = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock("./subagents/sponsorship-private-context-reader.js", () => ({ readPrivateSponsorshipContext: reader.read }))

const scope: TenantScope = { userId: "user-1" }
const now = new Date("2026-11-27T12:00:00.000Z")
const lease: TurnLease = { userId: scope.userId, sessionId: "session-1", turnId: "turn-1", ownerId: "worker-1",
  leaseVersion: 4, leaseStartedAt: now, leaseExpiresAt: new Date(now.getTime() + 60_000) }
const excerpt = "Sponsorship may be considered for the role."
const privateEntry: PrivateSponsorshipContextEntry = { jobId: "c123456789012345678901234", observation: {
  schemaVersion: SPONSORSHIP_OBSERVATION_SCHEMA, status: "inconclusive", reason: "interpretation_unverified",
  sourceContext: { source: "greenhouse", sourceUrl: "https://jobs.example", company: "Example Ltd", role: "Backend Engineer",
    location: "Dublin", descriptionExcerpt: excerpt, descriptionExcerptStartByte: 0, trustBoundary: "untrusted_saved_job_listing" },
} }

function snapshot(withHint: boolean): StepContextRequest["snapshot"] {
  return { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: withHint ? [{ id: "wait-result-1", content: {
    toolCallId: "wait-call-1", toolName: "agent.wait", toolVersion: "1", status: "completed", input: {}, errorCode: null,
    output: { waitId: "wait-12345678-1234-4234-9234-123456789012", status: "ready", taskIds: ["subagent-12345678-1234-4234-9234-123456789012"],
      deadlineAt: now.toISOString(), matchedTaskIds: ["subagent-12345678-1234-4234-9234-123456789012"], tasks: [{ taskId: "subagent-12345678-1234-4234-9234-123456789012",
        status: "completed", role: "scout", result: { status: "completed", structuredResult: {}, sponsorshipObservations: [{ jobId: "c123456789012345678901234",
          sourceRef: "saved_job_listing", observation: { schemaVersion: SPONSORSHIP_OBSERVATION_PUBLIC_SCHEMA, status: "inconclusive", reason: "interpretation_unverified" },
          guidance: "Use owner-scoped jobs.get for this Job. Sponsorship interpretation remains unverified without an independent same-role, same-country review bound to the exact source." }] }, failureReason: null }] },
  } }] : [] }
}

function fixture(withCountry = false) {
  const sponsorshipTargetCountry = withCountry ? {
    schemaVersion: "agent-harness.v2.objective-sponsorship-target-country.v1", countryCode: "IE",
  } as const : undefined
  const goal = "Check sponsorship scope for this Objective"
  const turnInput = sponsorshipTargetCountry ? {
    goal, content: [{ type: "text", text: goal }],
    intent: { kind: "objective_task_graph_execution", version: 1 }, sponsorshipTargetCountry,
  } : undefined
  const rootTaskObjective = sponsorshipTargetCountry ? { goal, successCriteria: ["Keep evidence scoped"] } : undefined
  const baseBuilder = { build: vi.fn(async (request: StepContextRequest): Promise<StepContext> => ({
    schemaVersion: "agent-harness.v2", sessionId: request.sessionId, turnId: request.turnId, stepId: request.stepId,
    inputThroughSequence: 3n, consumedInputIds: [], canonicalJson: "base-context", blocks: request.snapshot.toolObservations.map(observation => ({
      id: `observation:${observation.id}`, layer: "tool_observation" as const, role: "data" as const,
      trust: "external_untrusted" as const, source: "tool_or_subagent" as const, content: observation.content as StepContext["blocks"][number]["content"],
    })),
  })) }
  const rootHistoryReader: DirectRootTaskHistoryReader = { load: vi.fn(async () => []) }
  const builder = createCanonicalTurnContextBuilder({ pool: { connect: vi.fn() } as never, store: {} as never, baseBuilder,
    scope, lease, rootTaskId: "root-1", rootAttemptCount: 2, planningEnabled: true, selectedJobMode: false,
    ...(turnInput && rootTaskObjective ? { turnInput, rootTaskObjective } : {}),
    rootTaskHistoryDirectReader: rootHistoryReader, currentRootBudgetReader: async () => ({ kind: "turn_budget_current", status: "unavailable",
      advisoryOnly: true, pointInTime: true, notPermission: true, notReservation: true, notCompletionEvidence: true }) })
  return { builder, baseBuilder }
}

async function build(builder: ReturnType<typeof createCanonicalTurnContextBuilder>, withHint = true,
  suppliedSnapshot?: StepContextRequest["snapshot"]) {
  return builder.build({ scope, sessionId: lease.sessionId, turnId: lease.turnId, stepId: "step-current", taskId: "root-1",
    snapshot: suppliedSnapshot ?? snapshot(withHint), now, lease: { ownerId: lease.ownerId, leaseVersion: lease.leaseVersion, now } })
}

function consumedAsyncWaitProjection(role: "scout" | "auditor" = "scout") {
  const waitId = "wait-12345678-1234-4234-9234-123456789012"
  const taskId = "subagent-12345678-1234-4234-9234-123456789012"
  return { id: `wait-result:${waitId}`, content: { toolCallId: `wait:${waitId}`, toolName: "agent.wait",
    input: { taskIds: [taskId], mode: "all" }, status: "completed", errorCode: null,
    output: { waitId, status: "ready", targetTaskIds: [taskId], matchedTaskIds: [taskId], tasks: [{ taskId,
      status: "completed", role, result: { sourceMaterial: "must not become the source context" }, failureReason: null }] } } }
}

describe("canonical Root private sponsorship context", () => {
  beforeEach(() => { vi.clearAllMocks(); reader.read.mockResolvedValue([privateEntry]) })

  it("adds source excerpt only as an untrusted model context block, outside public wait and progress projections", async () => {
    const { builder } = fixture(), context = await build(builder)
    const sourceBlock = context.blocks.find(block => block.id === "sponsorship-private-source-0")
    expect(sourceBlock).toMatchObject({ layer: "business", role: "data", trust: "external_untrusted", source: "current_saved_job_listing",
      content: { jobId: privateEntry.jobId, sourceRef: "saved_job_listing", observation: { status: "inconclusive",
        sourceContext: { trustBoundary: "untrusted_saved_job_listing", descriptionExcerpt: excerpt } } } })
    expect(context.blocks.find(block => block.id === "sponsorship-private-guidance")?.content).toContain("not semantic sponsorship meaning or country scope")
    expect(context.canonicalJson).toContain(excerpt)
    const modelMessages = JSON.stringify(contextToModelMessages(context))
    expect(modelMessages).toContain(excerpt)
    expect(modelMessages).toContain("UNTRUSTED_DATA")
    const publicWait = JSON.stringify(context.blocks.filter(block => block.id === "observation:wait-result-1"))
    expect(publicWait).not.toContain(excerpt)
    expect(JSON.stringify(buildCognitiveActionAgenda(context))).not.toContain(excerpt)
    expect(Object.values(progressCheckpointFromStepContext(context)).join(" ")).not.toContain(excerpt)
    expect(reader.read).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: scope.userId,
      sessionId: lease.sessionId, turnId: lease.turnId, taskId: "root-1", rootTaskId: "root-1", stepId: "step-current" }), [])
  })

  it("keeps explicit Objective country scope beside current private source context without joining their authority", async () => {
    const { builder } = fixture(true)
    const context = await build(builder)
    const country = context.blocks.find(block => block.id === "observation:root-task-sponsorship-target-country")
    const source = context.blocks.find(block => block.id === "sponsorship-private-source-0")
    const guidance = context.blocks.find(block => block.id === "sponsorship-private-guidance")?.content

    expect(country).toMatchObject({
      layer: "tool_observation", role: "data", trust: "external_untrusted",
      content: { status: "selected", countryCode: "IE", scope: "user_selected_sponsorship_target_only",
        notJobLocation: true, notEvidence: true, notAuthority: true },
    })
    expect(source).toMatchObject({
      layer: "business", role: "data", trust: "external_untrusted", source: "current_saved_job_listing",
      content: { sourceRef: "saved_job_listing", observation: { status: "inconclusive", reason: "interpretation_unverified",
        sourceContext: { location: "Dublin", descriptionExcerpt: excerpt, trustBoundary: "untrusted_saved_job_listing" } } },
    })
    expect(guidance).toContain("not semantic sponsorship meaning or country scope")
    expect(guidance).toContain("Do not state that sponsorship is available or unavailable, infer a country from free-form location")
    const modelMessages = JSON.stringify(contextToModelMessages(context))
    expect(modelMessages).toContain("countryCode")
    expect(modelMessages).toContain("IE")
    expect(modelMessages).toContain(excerpt)
    const publicWait = JSON.stringify(context.blocks.find(block => block.id === "observation:wait-result-1")?.content)
    expect(publicWait).not.toContain(excerpt)
    expect(publicWait).not.toContain("countryCode")
  })

  it("discovers a consumed async wait projection without any sponsorship sidecar", async () => {
    const { builder } = fixture()
    const projection = consumedAsyncWaitProjection()
    const asyncSnapshot = { ...snapshot(false), toolObservations: [projection] }
    const context = await build(builder, false, asyncSnapshot)
    expect(reader.read).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stepId: "step-current" }), [projection])
    expect(context.blocks.some(block => block.id === "sponsorship-private-source-0")).toBe(true)
    const publicProjection = JSON.stringify(context.blocks.find(block => block.id === `observation:${projection.id}`)?.content)
    expect(publicProjection).not.toContain(excerpt)
    expect(JSON.stringify(context.blocks.find(block => block.id === "sponsorship-private-source-0")?.content)).not.toContain("must not become the source context")
  })

  it("also discovers a completed Auditor in a consumed wait without a sponsorship sidecar", async () => {
    const { builder } = fixture(true)
    const projection = consumedAsyncWaitProjection("auditor")
    const context = await build(builder, false, { ...snapshot(false), toolObservations: [projection] })

    expect(reader.read).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stepId: "step-current" }), [projection])
    expect(context.blocks.some(block => block.id === "sponsorship-private-source-0")).toBe(true)
    expect(JSON.stringify(context.blocks.find(block => block.id === `observation:${projection.id}`)?.content)).not.toContain(excerpt)
  })

  it("does not use an async wait hint whose projected tool call is bound to another wait", async () => {
    const { builder } = fixture()
    const projection = consumedAsyncWaitProjection()
    const mismatchedProjection = { ...projection, content: { ...projection.content, toolCallId: "wait:another-id" } }
    const context = await build(builder, false, { ...snapshot(false), toolObservations: [mismatchedProjection] })

    expect(reader.read).not.toHaveBeenCalled()
    expect(context.blocks.some(block => block.id.startsWith("sponsorship-private-source-"))).toBe(false)
  })

  it("keeps ordinary Root execution usable if optional source enrichment throws or has no current wait hint", async () => {
    const { builder } = fixture()
    reader.read.mockRejectedValueOnce(new Error("private database detail"))
    const afterFailure = await build(builder)
    expect(afterFailure.schemaVersion).toBe("agent-harness.v2")
    expect(afterFailure.blocks.some(block => block.id.startsWith("sponsorship-private-source-"))).toBe(false)
    expect(JSON.stringify(afterFailure.blocks)).not.toContain("private database detail")

    reader.read.mockClear()
    const withoutHint = await build(builder, false)
    expect(reader.read).not.toHaveBeenCalled()
    expect(withoutHint.blocks.some(block => block.id.startsWith("sponsorship-private-source-"))).toBe(false)
  })

  it("drops a source excerpt that the canonical context privacy guard rejects", async () => {
    const { builder } = fixture()
    const maliciousEntry: PrivateSponsorshipContextEntry = { jobId: privateEntry.jobId, observation: {
      schemaVersion: SPONSORSHIP_OBSERVATION_SCHEMA, status: "inconclusive", reason: "interpretation_unverified",
      sourceContext: { source: "greenhouse", sourceUrl: "https://jobs.example", company: "Example Ltd", role: "Backend Engineer",
        location: "Dublin", descriptionExcerpt: "sk-liveabcdefgh1234567", descriptionExcerptStartByte: 0,
        trustBoundary: "untrusted_saved_job_listing" },
    } }
    reader.read.mockResolvedValueOnce([maliciousEntry])
    const context = await build(builder)
    expect(context.schemaVersion).toBe("agent-harness.v2")
    expect(context.blocks.some(block => block.id.startsWith("sponsorship-private-source-"))).toBe(false)
    expect(context.canonicalJson).not.toContain("sk-liveabcdefgh1234567")
  })
})
