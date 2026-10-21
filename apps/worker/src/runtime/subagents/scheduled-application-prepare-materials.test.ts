import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import type { HarnessModelRequest } from "@jobcopilot/agent-model"
import type { AgentArtifactDraftWrite, AgentArtifactTaskFence } from "../../db/agent-artifact-repo.js"
import type { ScheduledPrepareArtifactWriteBinding, ScheduledPrepareJobInput } from "../tools/scheduled-application-prepare.js"
import type { AnalystResult } from "./role-results.js"
import type { ScheduledPrepareMaterialSources } from "./scheduled-application-prepare-materials.js"
import { persistScheduledPrepareMaterial, prepareScheduledJobMaterials, scheduledPrepareArtifactIdentity, scheduledPrepareCitedRefs } from "./scheduled-application-prepare-materials.js"

const { createArtifactRepository, loadSelectedJobArtifactContext } = vi.hoisted(() => ({
  createArtifactRepository: vi.fn(), loadSelectedJobArtifactContext: vi.fn(),
}))
vi.mock("../../db/agent-artifact-repo.js", () => ({ createAgentArtifactRepository: createArtifactRepository }))
vi.mock("./selected-job-artifact-context.js", () => ({ loadSelectedJobArtifactContext }))

const sourceDigest = `sha256:${"c".repeat(64)}`
const evidenceRefs = ["job:job-a", "resume:resume-a"]
const baseFence = {
  taskId: "prepare-task-a", userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "root-a",
  parentTaskId: "root-a", leaseOwner: "worker-a", attemptCount: 3,
}
const binding: ScheduledPrepareArtifactWriteBinding = {
  userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "root-a", taskId: "prepare-task-a",
  executionId: "execution-a", executionAttemptCount: 2, taskFence: baseFence,
  continuationKey: `scheduled-taskgraph:sha256:${"a".repeat(64)}`, snapshotDigest: `sha256:${"b".repeat(64)}`,
  evidenceDigest: "d".repeat(64), checkpointDigest: "e".repeat(64), analyzeGraphRevision: 5, prepareScheduleRevision: 6,
  resumeTailoringChoiceDigest: null, jobId: "job-a", score: 80, sourceDigest, evidenceRefs, kind: "resume",
  toolCallId: "prepare-call-a", requestHash: "stable-request-hash",
}

describe("scheduled Prepare material persistence", () => {
  it("adds the current job and base resume when Analyst cites only the job", () => {
    const analyst = { evidence: [
      { id: "job-evidence", kind: "job", ref: "job-a", source: "selected job" },
      { id: "persona-evidence", kind: "persona", ref: "fact-a", source: "confirmed profile" },
    ] } as unknown as AnalystResult

    expect(scheduledPrepareCitedRefs(analyst, "job-a", ["job-evidence"], "resume-a")).toEqual(["job:job-a", "resume:resume-a"])
    expect(scheduledPrepareCitedRefs(analyst, "job-a", ["job-evidence", "persona-evidence"], "resume-a"))
      .toEqual(["job:job-a", "persona:fact-a", "resume:resume-a"])
  })

  it("records only Persona facts sent to each material model input", async () => {
    const source = { preparation: { jobId: "job-a", sourceDigest, evidenceRefs: ["job:job-a", "persona:fact-a", "persona:fact-b", "resume:resume-a"] },
      baseResumeId: "resume-a", transientSources: [
        { sourceRef: "job:job-a", content: { title: "Software Engineer" } },
        { sourceRef: "resume:resume-a", content: { summary: "confirmed base resume" } },
        { sourceRef: "persona:fact-a", content: { value: "Used fact" } },
        { sourceRef: "persona:fact-b", content: { value: "Unused fact" } },
      ] }
    const modelInputs: string[] = [], writtenRefs: Record<string, readonly string[]> = {}
    loadSelectedJobArtifactContext.mockResolvedValue(source)
    const adapter = {
      id: "fixture", profile: { provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true,
        streaming: true, continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: true,
        supportsReasoningSummary: true, supportsResponseContinuation: false, supportsProviderConversation: false,
        supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low" },
      complete: vi.fn(async (request: HarnessModelRequest) => {
        modelInputs.push(JSON.stringify(request.messages))
        return { text: "Cover letter", finishReason: "stop" as const, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 } }
      }),
      async *stream() { yield { type: "completed" as const, finishReason: "stop" as const } },
    }
    const input = { invocation: { owner: { userId: "user-a", sessionId: "session-a", turnId: "turn-a", taskId: "task-a",
      rootTaskId: "root-a", ownerId: "worker-a", attemptCount: 1 }, taskFence: baseFence },
      job: { jobId: "job-a", score: 80, sourceDigest, evidenceRefs: ["job:job-a", "persona:fact-a", "resume:resume-a"] },
      resumeTailoringChoice: "keep_resume", artifactBinding: () => binding } as unknown as ScheduledPrepareJobInput
    const options = { pool: {} as pg.Pool, owner: input.invocation.owner as never, resolveModel: async () => adapter as never,
      authorize: async () => ({ settle: async () => undefined, release: async () => undefined }) as never,
      treeBudget: ({ reserve: async () => ({ id: "reservation", userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "root-a",
        taskId: "task-a", stepId: "scheduled-prepare-cover_letter", attempt: 1, units: 1 as const, status: "reserved" as const, idempotencyKey: "key",
        createdAt: new Date(), updatedAt: new Date(), settledAt: null }), settle: async () => undefined } as never),
      persistMaterial: async (_job: ScheduledPrepareJobInput, kind: "resume" | "cover_letter", _content: unknown,
        _sources: ScheduledPrepareMaterialSources, refs: readonly string[]) => { writtenRefs[kind] = refs; return { artifactId: kind } } }
    const detail = { sources: source, matched: [], missing: [] }

    await expect(prepareScheduledJobMaterials(options, input, detail, new AbortController().signal)).resolves.toMatchObject({ status: "prepared" })

    expect(adapter.complete).toHaveBeenCalledTimes(1)
    expect(modelInputs[0]).toContain("Used fact")
    expect(modelInputs[0]).not.toContain("Unused fact")
    expect(writtenRefs).toEqual({
      resume: ["job:job-a", "resume:resume-a"],
      cover_letter: ["job:job-a", "persona:fact-a", "resume:resume-a"],
    })
  })

  it("stops before generation and persistence when the complete current source digest drifts", async () => {
    const current = { preparation: { sourceDigest: `sha256:${"d".repeat(64)}`, evidenceRefs }, baseResumeId: "resume-a", transientSources: [
      { sourceRef: "job:job-a", content: { title: "Changed job" } }, { sourceRef: "resume:resume-a", content: { summary: "resume" } },
    ] }
    loadSelectedJobArtifactContext.mockResolvedValue(current)
    const complete = vi.fn()
    const persistMaterial = vi.fn()
    const input = { invocation: { owner: { userId: "user-a" } }, job: { jobId: "job-a", score: 80, sourceDigest, evidenceRefs },
      resumeTailoringChoice: "keep_resume", artifactBinding: () => binding } as unknown as ScheduledPrepareJobInput

    await expect(prepareScheduledJobMaterials({ pool: {} as pg.Pool, owner: {} as never, resolveModel: async () => ({ complete } as never),
      authorize: vi.fn() as never, treeBudget: {} as never, persistMaterial }, input,
    { sources: current as never, matched: [], missing: [] }, new AbortController().signal)).rejects.toThrow("scheduled_prepare_source_changed")

    expect(complete).not.toHaveBeenCalled()
    expect(persistMaterial).not.toHaveBeenCalled()
  })

  it("passes one captured Turn fence unchanged to the base insert and draft write", async () => {
    const source = { preparation: { sourceDigest, evidenceRefs }, baseResumeId: "resume-a", transientSources: [
      { sourceRef: "resume:resume-a", content: { summary: "source resume" } },
      { sourceRef: "job:job-a", content: { title: "Software Engineer" } },
    ] }
    const baseFences: AgentArtifactTaskFence[] = []
    const baseClients: unknown[] = []
    const draftWrites: AgentArtifactDraftWrite[] = []
    const draftClients: unknown[] = []
    const client = { query: vi.fn(async (_sql: string) => ({ rows: [] })), release: vi.fn() }
    const repository = {
      insertBaseWithClient: vi.fn(async (writeClient: unknown, _base: unknown, taskFence: AgentArtifactTaskFence) => {
        baseClients.push(writeClient)
        baseFences.push(taskFence)
      }),
      find: vi.fn(async () => null),
      saveDraft: vi.fn(async (write: AgentArtifactDraftWrite, writeClient: unknown) => {
        draftWrites.push(write)
        draftClients.push(writeClient)
        return { artifactId: write.id, version: 1, contentHash: write.hash, sourceDigest: write.sourceDigest } as never
      }),
    }
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool
    createArtifactRepository.mockReturnValue(repository)
    loadSelectedJobArtifactContext.mockResolvedValue(source)
    const input = {
      invocation: { owner: { rootAttemptCount: 2, turnLeaseOwnerId: "turn-owner-current", turnLeaseVersion: 12 } },
      artifactBinding: () => binding,
    } as unknown as ScheduledPrepareJobInput

    await expect(persistScheduledPrepareMaterial(pool, input, "resume", { summary: "tailored resume" }, source as never))
      .resolves.toMatchObject({ artifactId: expect.any(String), version: 1, sourceDigest })

    expect(baseFences).toHaveLength(1)
    expect(draftWrites).toHaveLength(1)
    expect(baseFences[0]).toBe(draftWrites[0]?.taskFence)
    expect(baseClients[0]).toBe(client)
    expect(draftClients[0]).toBe(client)
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "SELECT set_config($1, $2, true)", "COMMIT"])
    expect(baseFences[0]).toMatchObject({ taskFenceMode: "scheduled_prepare", turnLeaseOwnerId: "turn-owner-current", turnLeaseVersion: 12 })
    expect(repository.insertBaseWithClient).toHaveBeenCalledWith(client, expect.objectContaining({ id: expect.stringMatching(/^scheduled-base:/) }), baseFences[0])
    expect(repository.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ taskFence: baseFences[0] }), client)
  })

  it("keeps lease identity out of the stable base, draft, and tool receipt keys", () => {
    const oldLease = { ...binding, taskFence: { ...baseFence, turnLeaseOwnerId: "turn-owner-old", turnLeaseVersion: 4 } }
    const currentLease = { ...binding, taskFence: { ...baseFence, turnLeaseOwnerId: "turn-owner-current", turnLeaseVersion: 12 } }

    expect(scheduledPrepareArtifactIdentity(oldLease, 2)).toEqual(scheduledPrepareArtifactIdentity(currentLease, 2))
  })
})
