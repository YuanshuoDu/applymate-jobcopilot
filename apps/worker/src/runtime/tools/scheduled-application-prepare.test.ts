import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

import { ROLE_RESULT_SCHEMA } from "../subagents/role-results.js"
import { SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_SCHEMA } from "../subagents/scheduled-taskgraph-continuation-receipt.js"
import { createScheduledApplicationPrepareTool, SCHEDULED_PREPARE_CHOICE_SCHEMA, type ScheduledPrepareArtifactWriteBinding, type ScheduledPrepareChoiceResolution, type ScheduledPrepareJobInput, type VerifiedScheduledPrepareInvocation } from "./scheduled-application-prepare.js"
import { ToolRegistry } from "./registry.js"
import type { ToolExecutionContext } from "./types.js"

const digest = (letter: string) => `sha256:${letter.repeat(64)}`
const hexDigest = (letter: string) => letter.repeat(64)
const continuationKey = `scheduled-taskgraph:sha256:${"a".repeat(64)}`

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1",
    targetRoles: ["Engineer"], targetLocations: ["Dublin"], minScore: 70,
    dailyCap: 10, requireApproval: true, autoApply: false,
    ...overrides,
  }
}

function snapshotDigest(value: ReturnType<typeof snapshot> = snapshot()) {
  const projection = [value.schemaVersion, value.targetRoles, value.targetLocations, value.minScore, value.dailyCap, value.requireApproval, value.autoApply]
  return `sha256:${createHash("sha256").update(JSON.stringify(projection), "utf8").digest("hex")}`
}

function owner(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 1,
    turnLeaseOwnerId: "turn-lease-1", turnLeaseVersion: 3, executionId: "execution-1", executionAttemptCount: 2,
    ...overrides,
  }
}

function invocation(overrides: Record<string, unknown> = {}) {
  const storedSnapshot = snapshot()
  const storedOwner = owner()
  return {
    source: "automation", runMode: "scheduled", templateId: "prepare", role: "prepare", taskType: "scheduled_application_prepare",
    owner: storedOwner,
    taskFence: {
      taskId: "prepare-task-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
      parentTaskId: "root-1", leaseOwner: "worker-lease-1", attemptCount: 1,
    },
    snapshot: storedSnapshot,
    receipt: {
      schemaVersion: SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_SCHEMA, continuationKey, snapshotDigest: snapshotDigest(storedSnapshot), evidenceDigest: hexDigest("b"), checkpointDigest: hexDigest("c"),
      analyzeGraphRevision: 3, prepareScheduleRevision: 4, owner: storedOwner,
    },
    resumeTailoringChoice: { schemaVersion: SCHEDULED_PREPARE_CHOICE_SCHEMA, key: continuationKey, questionId: "question-1",
      answerItemId: "agent-wait:question:question-1", value: "apply_ai_changes", snapshotDigest: snapshotDigest(storedSnapshot),
      evidenceDigest: hexDigest("b"), checkpointDigest: hexDigest("c"), analyzeGraphRevision: 3, prepareScheduleRevision: 4, owner: storedOwner },
    checkpointJobs: [
      { jobId: "job-a", score: 82, sourceDigest: digest("d"), evidenceRefs: ["job:job-a", "resume:base-a"] },
      { jobId: "job-b", score: 68, sourceDigest: digest("e"), evidenceRefs: ["job:job-b", "resume:base-b"] },
    ],
    ...overrides,
  }
}

function choiceFor(receipt: ReturnType<typeof invocation>["receipt"], choiceOwner: ReturnType<typeof owner>) {
  return {
    schemaVersion: SCHEDULED_PREPARE_CHOICE_SCHEMA, key: receipt.continuationKey, questionId: "question-1",
    answerItemId: "agent-wait:question:question-1", value: "apply_ai_changes" as const, snapshotDigest: receipt.snapshotDigest,
    evidenceDigest: receipt.evidenceDigest, checkpointDigest: receipt.checkpointDigest,
    analyzeGraphRevision: receipt.analyzeGraphRevision, prepareScheduleRevision: receipt.prepareScheduleRevision, owner: choiceOwner,
  }
}

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    scope: { userId: "user-1" } as ToolExecutionContext["scope"], sessionId: "session-1", turnId: "turn-1", stepId: "step-1",
    taskId: "prepare-task-1", rootTaskId: "root-1", toolCallId: "model-call-1", actorRole: "subagent",
    delegateOutputSchemaMarker: { schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare" }, signal: new AbortController().signal,
    capabilities: ["read"], reportProgress: async () => undefined,
    ...overrides,
  }
}

function ref(artifactId: string, sourceDigest: string) {
  return { artifactId, version: 1, contentHash: digest("f"), sourceDigest }
}

function dependencies(options: {
  invocation?: unknown
  prepareJob?: (input: ScheduledPrepareJobInput, signal: AbortSignal) => Promise<unknown>
  resolveResumeTailoringChoice?: (input: { invocation: VerifiedScheduledPrepareInvocation; context: ToolExecutionContext }) => Promise<ScheduledPrepareChoiceResolution>
} = {}) {
  return {
    loadVerifiedInvocation: vi.fn(async () => options.invocation ?? invocation()),
    resolveResumeTailoringChoice: vi.fn(async (input: { invocation: VerifiedScheduledPrepareInvocation; context: ToolExecutionContext }) => options.resolveResumeTailoringChoice
      ? options.resolveResumeTailoringChoice(input)
      : { status: "waiting_for_user" as const, owner: input.invocation.owner, snapshotDigest: input.invocation.receipt.snapshotDigest,
        receipt: { status: "waiting_for_user" as const, disposition: "created" as const, waitId: "wait-1", itemId: "agent-wait:question:wait-1",
          turnId: input.invocation.owner.turnId, toolCallId: null, nextTurnRevision: 5 } }),
    prepareJob: vi.fn(async (input: ScheduledPrepareJobInput, signal: AbortSignal) => options.prepareJob
      ? options.prepareJob(input, signal)
      : { status: "prepared", materials: [{ kind: "resume", artifactRef: ref("resume-a", input.job.sourceDigest) }] }),
  }
}

describe("scheduled.application.prepare tool", () => {
  it("registers the exact model-safe draft-write contract for the Prepare template", () => {
    const tool = createScheduledApplicationPrepareTool(dependencies())
    const registry = new ToolRegistry([tool])

    expect(registry.resolve("scheduled.application.prepare", "1")).toMatchObject({
      name: "scheduled.application.prepare", version: "1", template: "prepare", risk: "draft_write", domain: "resume",
      capabilities: ["read", "write"], requiredCapabilities: [], idempotency: "requires_key",
    })
    expect(tool.inputSchema).toMatchObject({ type: "object", properties: {}, additionalProperties: false })
    expect(tool.outputSchema).toMatchObject({ type: "object", additionalProperties: false })
  })

  it("uses only persisted eligible scores and source bindings, returning safe artifact references", async () => {
    const deps = dependencies()
    const output = await createScheduledApplicationPrepareTool(deps).execute(context(), {})

    expect(deps.loadVerifiedInvocation).toHaveBeenCalledOnce()
    expect(deps.prepareJob).toHaveBeenCalledOnce()
    expect(deps.prepareJob.mock.calls[0]?.[0].job).toMatchObject({ jobId: "job-a", score: 82, sourceDigest: digest("d") })
    expect(deps.prepareJob.mock.calls[0]?.[0].resumeTailoringChoice).toBe("apply_ai_changes")
    expect(deps.prepareJob.mock.calls[0]?.[0].artifactBinding("resume")).toMatchObject({
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", taskId: "prepare-task-1",
      executionId: "execution-1", executionAttemptCount: 2, jobId: "job-a", score: 82, sourceDigest: digest("d"),
      continuationKey, analyzeGraphRevision: 3, prepareScheduleRevision: 4,
      resumeTailoringChoiceDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    })
    expect(output).toEqual({
      schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare", status: "completed", taskId: "prepare-task-1", attemptCount: 1,
      snapshotDigest: snapshotDigest(), checkpointDigest: hexDigest("c"),
      jobs: [{ jobId: "job-a", status: "prepared" }],
      materials: [{ jobId: "job-a", kind: "resume", artifactRef: ref("resume-a", digest("d")) }],
    })
    expect(JSON.stringify(output)).not.toMatch(/"score"|userId|sessionId|turnId|continuationKey|resumeBody|coverLetterBody|authorization|accessToken|apply_ai_changes/i)
  })

  it("completes with empty arrays when the persisted score checkpoint has no eligible jobs", async () => {
    const deps = dependencies({
      invocation: invocation({ checkpointJobs: [{ jobId: "job-low", score: 69, sourceDigest: digest("a"), evidenceRefs: ["job:job-low"] }] }),
    })
    const output = await createScheduledApplicationPrepareTool(deps).execute(context(), {})

    expect(deps.prepareJob).not.toHaveBeenCalled()
    expect(output).toMatchObject({ status: "completed", jobs: [], materials: [] })
  })

  it("yields a typed resumable wait when a required resume choice is absent", async () => {
    const missing = dependencies({ invocation: invocation({ resumeTailoringChoice: undefined }) })
    await expect(createScheduledApplicationPrepareTool(missing).execute(context(), {})).rejects.toMatchObject({
      code: "policy_requires_user_input", safeOutput: { status: "waiting_for_user", waitId: "wait-1", nextTurnRevision: 5 },
    })
    expect(missing.resolveResumeTailoringChoice).toHaveBeenCalledOnce()
    expect(missing.prepareJob).not.toHaveBeenCalled()
  })

  it("rejects a wait receipt whose item identity does not match its wait id", async () => {
    const deps = dependencies({ invocation: invocation({ resumeTailoringChoice: undefined }), resolveResumeTailoringChoice: async ({ invocation: current }) => ({
      status: "waiting_for_user", owner: current.owner, snapshotDigest: current.receipt.snapshotDigest,
      receipt: { status: "waiting_for_user", disposition: "created", waitId: "wait-1", itemId: "agent-wait:question:other-wait",
        turnId: current.owner.turnId, toolCallId: null, nextTurnRevision: 5 },
    }) })

    await expect(createScheduledApplicationPrepareTool(deps).execute(context(), {})).rejects.toMatchObject({ code: "scheduled_prepare_unavailable" })
    expect(deps.prepareJob).not.toHaveBeenCalled()
  })

  it("rejects a malformed current Turn lease owner before any artifact write", async () => {
    const malformed = dependencies({ invocation: invocation({ owner: owner({ turnLeaseOwnerId: "worker\nforged", turnLeaseVersion: 4 }) }) })

    await expect(createScheduledApplicationPrepareTool(malformed).execute(context(), {})).rejects.toMatchObject({ code: "scheduled_prepare_unavailable" })
    expect(malformed.prepareJob).not.toHaveBeenCalled()
  })

  it("uses only the exact answer receipt returned by the durable resolver and permits lease reacquisition", async () => {
    const oldOwner = owner(), currentOwner = owner({ turnLeaseOwnerId: "new-turn-lease", turnLeaseVersion: 4 })
    const stored = invocation({ owner: currentOwner, resumeTailoringChoice: undefined })
    const deps = dependencies({ invocation: stored, resolveResumeTailoringChoice: async ({ invocation: current }) => ({
      status: "answered", choice: { schemaVersion: SCHEDULED_PREPARE_CHOICE_SCHEMA, key: current.receipt.continuationKey,
        questionId: "question-1", answerItemId: "agent-wait:question:question-1", value: "apply_ai_changes",
        snapshotDigest: current.receipt.snapshotDigest, evidenceDigest: current.receipt.evidenceDigest,
        checkpointDigest: current.receipt.checkpointDigest, analyzeGraphRevision: current.receipt.analyzeGraphRevision,
        prepareScheduleRevision: current.receipt.prepareScheduleRevision, owner: oldOwner },
    }) })
    const output = await createScheduledApplicationPrepareTool(deps).execute(context(), {})

    expect(deps.prepareJob.mock.calls[0]?.[0].resumeTailoringChoice).toBe("apply_ai_changes")
    expect(JSON.stringify(output)).not.toContain("apply_ai_changes")
  })

  it("replays a persisted choice across lease reacquisition when the immutable continuation identity is exact", async () => {
    const priorOwner = owner(), currentOwner = owner({ turnLeaseOwnerId: "new-turn-lease", turnLeaseVersion: 4 })
    const current = invocation({ owner: currentOwner, resumeTailoringChoice: choiceFor(invocation().receipt, priorOwner) })
    const deps = dependencies({ invocation: current })

    const output = await createScheduledApplicationPrepareTool(deps).execute(context(), {})

    expect(deps.prepareJob).toHaveBeenCalledOnce()
    expect(deps.prepareJob.mock.calls[0]?.[0].resumeTailoringChoice).toBe("apply_ai_changes")
    expect(output.status).toBe("completed")
  })

  it("rejects a persisted choice when any immutable continuation binding is changed or missing", async () => {
    const base = invocation().resumeTailoringChoice
    if (!base) throw new Error("fixture choice is missing")
    const changedBindings: Record<string, unknown>[] = [
      { ...base, key: `scheduled-taskgraph:sha256:${"9".repeat(64)}` },
      { ...base, snapshotDigest: digest("f") },
      { ...base, evidenceDigest: hexDigest("f") },
      { ...base, checkpointDigest: hexDigest("e") },
      { ...base, analyzeGraphRevision: 4, prepareScheduleRevision: 5 },
    ]

    for (const changed of changedBindings) {
      const deps = dependencies({ invocation: invocation({ resumeTailoringChoice: changed }) })
      await expect(createScheduledApplicationPrepareTool(deps).execute(context(), {})).rejects.toMatchObject({ code: "scheduled_prepare_unavailable" })
      expect(deps.prepareJob).not.toHaveBeenCalled()

    }
    for (const key of ["key", "snapshotDigest", "evidenceDigest", "checkpointDigest", "analyzeGraphRevision", "prepareScheduleRevision"]) {
      const missing = { ...base } as Record<string, unknown>
      delete missing[key]
      const deps = dependencies({ invocation: invocation({ resumeTailoringChoice: missing }) })
      await expect(createScheduledApplicationPrepareTool(deps).execute(context(), {})).rejects.toMatchObject({ code: "scheduled_prepare_unavailable" })
      expect(deps.prepareJob).not.toHaveBeenCalled()
    }
  })

  it("rejects a resolver answer when immutable continuation bindings differ or are absent", async () => {
    const current = invocation({ resumeTailoringChoice: undefined })
    const base = choiceFor(current.receipt, current.owner)
    const changed = { ...base, evidenceDigest: hexDigest("f") }
    const missing = { ...base } as Record<string, unknown>
    delete missing.prepareScheduleRevision
    for (const choice of [changed, missing]) {
      const deps = dependencies({ invocation: current, resolveResumeTailoringChoice: async () => ({ status: "answered", choice } as ScheduledPrepareChoiceResolution) })
      await expect(createScheduledApplicationPrepareTool(deps).execute(context(), {})).rejects.toMatchObject({ code: "scheduled_prepare_unavailable" })
      expect(deps.prepareJob).not.toHaveBeenCalled()
    }
  })

  it("rejects a persisted answer from another Turn before any artifact write", async () => {
    const mismatched = dependencies({ invocation: invocation({ resumeTailoringChoice: {
      schemaVersion: SCHEDULED_PREPARE_CHOICE_SCHEMA, key: continuationKey, questionId: "question-1",
      answerItemId: "agent-wait:question:question-1", value: "apply_ai_changes", snapshotDigest: snapshotDigest(), owner: owner({ turnId: "other-turn" }),
    } }) })
    await expect(createScheduledApplicationPrepareTool(mismatched).execute(context(), {})).rejects.toMatchObject({ code: "scheduled_prepare_unavailable" })
    expect(mismatched.prepareJob).not.toHaveBeenCalled()
  })

  it("rejects an answer from a stale scheduled execution attempt", async () => {
    const current = invocation({ resumeTailoringChoice: undefined })
    const staleOwner = owner({ executionAttemptCount: 1 })
    const stale = dependencies({ invocation: current, resolveResumeTailoringChoice: async () => ({
      status: "answered", choice: { schemaVersion: SCHEDULED_PREPARE_CHOICE_SCHEMA, key: continuationKey,
        questionId: "question-1", answerItemId: "agent-wait:question:question-1", value: "apply_ai_changes",
        snapshotDigest: snapshotDigest(), evidenceDigest: hexDigest("b"), checkpointDigest: hexDigest("c"),
        analyzeGraphRevision: 3, prepareScheduleRevision: 4, owner: staleOwner },
    }) })

    await expect(createScheduledApplicationPrepareTool(stale).execute(context(), {})).rejects.toMatchObject({ code: "scheduled_prepare_unavailable" })
    expect(stale.prepareJob).not.toHaveBeenCalled()
  })

  it("rejects a Prepare task fence whose parent is not the persisted root task", async () => {
    const stored = invocation()
    const mismatched = dependencies({ invocation: {
      ...stored,
      taskFence: { ...stored.taskFence, parentTaskId: "other-parent" },
    } })

    await expect(createScheduledApplicationPrepareTool(mismatched).execute(context(), {})).rejects.toMatchObject({ code: "scheduled_prepare_unavailable" })
    expect(mismatched.prepareJob).not.toHaveBeenCalled()
  })

  it("rejects a non-enum answer or non-canonical question item before writing", async () => {
    const malformed = dependencies({ invocation: invocation({ resumeTailoringChoice: {
      ...invocation().resumeTailoringChoice, answerItemId: "answer-1", value: "tailor_from_base",
    } }) })
    await expect(createScheduledApplicationPrepareTool(malformed).execute(context(), {})).rejects.toMatchObject({ code: "scheduled_prepare_unavailable" })
    expect(malformed.prepareJob).not.toHaveBeenCalled()
  })

  it("reports partial results without leaking malformed outputs or thrown error text", async () => {
    const canary = "PRIVATE COVER LETTER BODY CANARY"
    const deps = dependencies({
      invocation: invocation({ checkpointJobs: [
        { jobId: "job-a", score: 82, sourceDigest: digest("d"), evidenceRefs: ["job:job-a"] },
        { jobId: "job-c", score: 80, sourceDigest: digest("e"), evidenceRefs: ["job:job-c"] },
        { jobId: "job-d", score: 90, sourceDigest: digest("a"), evidenceRefs: ["job:job-d"] },
      ] }),
      prepareJob: async ({ job }) => {
        if (job.jobId === "job-a") return { status: "prepared", materials: [{ kind: "resume", artifactRef: ref("resume-a", job.sourceDigest) }] }
        if (job.jobId === "job-c") return { status: "prepared", materials: [{ kind: "resume", artifactRef: ref("resume-c", job.sourceDigest) }], coverLetterBody: canary }
        throw new Error(canary)
      },
    })
    const output = await createScheduledApplicationPrepareTool(deps).execute(context(), {})

    expect(output.status).toBe("partial")
    expect(output.jobs).toEqual([{ jobId: "job-a", status: "prepared" }, { jobId: "job-c", status: "failed" }, { jobId: "job-d", status: "failed" }])
    expect(output.materials).toEqual([{ jobId: "job-a", kind: "resume", artifactRef: ref("resume-a", digest("d")) }])
    expect(JSON.stringify(output)).not.toContain(canary)
  })

  it("turns a stale artifact source binding into a safe failed job", async () => {
    const deps = dependencies({
      prepareJob: async () => ({ status: "prepared", materials: [{ kind: "resume", artifactRef: ref("resume-a", digest("f")) }] }),
    })
    const output = await createScheduledApplicationPrepareTool(deps).execute(context(), {})
    expect(output).toMatchObject({ status: "partial", jobs: [{ jobId: "job-a", status: "failed" }], materials: [] })
  })

  it("replays across TaskGraph retries in one execution attempt and rejects changed bindings", async () => {
    const receipts = new Map<string, { requestHash: string; artifactRef: ReturnType<typeof ref> }>()
    const bindings: ScheduledPrepareArtifactWriteBinding[] = []
    let writes = 0
    let replays = 0
    let conflicts = 0
    const deps = dependencies({ prepareJob: async ({ job, artifactBinding }) => {
      const binding = artifactBinding("resume")
      bindings.push(binding)
      const existing = receipts.get(binding.toolCallId)
      if (existing && existing.requestHash !== binding.requestHash) { conflicts++; throw new Error("receipt_conflict") }
      const artifactRef = existing?.artifactRef ?? ref("resume-a", job.sourceDigest)
      if (existing) replays++
      else writes++
      receipts.set(binding.toolCallId, { requestHash: binding.requestHash, artifactRef })
      return { status: "prepared", materials: [{ kind: "resume", artifactRef }] }
    } })
    const tool = createScheduledApplicationPrepareTool(deps)

    const firstInvocation = invocation()
    const retryOwner = owner({ executionAttemptCount: firstInvocation.owner.executionAttemptCount })
    const retryInvocation = invocation({
      owner: retryOwner,
      taskFence: { ...firstInvocation.taskFence, leaseOwner: "worker-lease-2", attemptCount: 2 },
      receipt: { ...firstInvocation.receipt, owner: retryOwner },
      resumeTailoringChoice: { ...firstInvocation.resumeTailoringChoice, owner: retryOwner },
    })
    const changedOwner = firstInvocation.owner
    const changedInvocation = invocation({
      owner: changedOwner,
      taskFence: { ...firstInvocation.taskFence, leaseOwner: "worker-lease-3", attemptCount: 3 },
      receipt: { ...firstInvocation.receipt, owner: changedOwner },
      resumeTailoringChoice: { ...firstInvocation.resumeTailoringChoice, owner: changedOwner },
      checkpointJobs: [{ ...firstInvocation.checkpointJobs[0], sourceDigest: digest("a") }, firstInvocation.checkpointJobs[1]],
    })
    const newAttemptOwner = owner({ executionAttemptCount: 4 })
    const newAttemptKey = `scheduled-taskgraph:sha256:${"9".repeat(64)}`
    const newAttemptInvocation = invocation({
      owner: newAttemptOwner,
      taskFence: { ...firstInvocation.taskFence, leaseOwner: "worker-lease-4", attemptCount: 4 },
      receipt: { ...firstInvocation.receipt, owner: newAttemptOwner, continuationKey: newAttemptKey },
      resumeTailoringChoice: { ...firstInvocation.resumeTailoringChoice, owner: newAttemptOwner, key: newAttemptKey },
    })
    vi.mocked(deps.loadVerifiedInvocation)
      .mockResolvedValueOnce(firstInvocation)
      .mockResolvedValueOnce(retryInvocation)
      .mockResolvedValueOnce(changedInvocation)
      .mockResolvedValueOnce(newAttemptInvocation)

    const first = await tool.execute(context(), {})
    const retry = await tool.execute(context(), {})
    const changed = await tool.execute(context(), {})
    const newAttempt = await tool.execute(context(), {})

    expect(retry).toEqual({ ...first, attemptCount: 2 })
    expect(bindings[1]?.toolCallId).toBe(bindings[0]?.toolCallId)
    expect(bindings[1]?.requestHash).toBe(bindings[0]?.requestHash)
    expect(bindings[1]?.taskFence).toMatchObject({ attemptCount: 2, leaseOwner: "worker-lease-2" })
    expect(bindings[1]?.executionAttemptCount).toBe(firstInvocation.owner.executionAttemptCount)
    expect(changed).toMatchObject({ status: "partial", jobs: [{ jobId: "job-a", status: "failed" }], materials: [] })
    expect(bindings[2]?.toolCallId).toBe(bindings[0]?.toolCallId)
    expect(bindings[2]?.requestHash).not.toBe(bindings[0]?.requestHash)
    expect(newAttempt).toMatchObject({ status: "partial", jobs: [{ jobId: "job-a", status: "failed" }], materials: [] })
    expect(bindings[3]?.executionAttemptCount).toBe(newAttemptOwner.executionAttemptCount)
    expect(bindings[3]?.requestHash).not.toBe(bindings[0]?.requestHash)
    expect({ writes, replays, conflicts, receipts: receipts.size }).toEqual({ writes: 1, replays: 1, conflicts: 2, receipts: 1 })
  })

  it("rejects caller data and fails closed when context or persisted binding is malformed", async () => {
    const deps = dependencies()
    const tool = createScheduledApplicationPrepareTool(deps)
    await expect(tool.execute(context(), { jobId: "attacker-job", score: 100 })).rejects.toMatchObject({ code: "invalid_input" })
    await expect(tool.execute(context({ actorRole: "orchestrator" }), {})).rejects.toMatchObject({ code: "scheduled_prepare_unavailable" })
    await expect(createScheduledApplicationPrepareTool(dependencies({
      invocation: invocation({ receipt: { continuationKey: "continuation-1", snapshotDigest: digest("f") } }),
    })).execute(context(), {})).rejects.toMatchObject({ code: "scheduled_prepare_unavailable" })
    expect(deps.loadVerifiedInvocation).not.toHaveBeenCalled()
  })

  it("rejects a private continuation receipt with a skipped Prepare schedule revision", async () => {
    const stored = invocation()
    const deps = dependencies({ invocation: {
      ...stored,
      receipt: { ...stored.receipt, prepareScheduleRevision: 5 },
    } })

    await expect(createScheduledApplicationPrepareTool(deps).execute(context(), {})).rejects.toMatchObject({ code: "scheduled_prepare_unavailable" })
    expect(deps.prepareJob).not.toHaveBeenCalled()
  })
})
