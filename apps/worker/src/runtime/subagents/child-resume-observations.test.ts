import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { canonicalJson, redactSensitiveText } from "@jobcopilot/shared"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { InMemoryToolLifecycleSink, ToolLifecycle, type LifecycleCall } from "../tools/lifecycle.js"
import type { ToolResultReferenceRepository } from "../tools/tool-result-reference-types.js"
import type { JobDiscoveryOutput } from "../tools/job-discovery-client.js"

import { createObservedEvidenceIndex, hydrateObservedEvidence } from "./child-evidence.js"
import { buildChildResumeObservations, mergeDurableWaitObservation, resolveDurableWaitOutcome } from "./child-resume-observations.js"
import type { SubagentLease } from "./types.js"

const targetId = "subagent-00000000-0000-4000-8000-000000000001"
const otherId = "child-b"
const phoneShapedCallId = "child-wait-call:415-555-0134"
const freeText = `Call +1 (415) 555-0134 about ${targetId}`
const NUMERIC_UUID = "00000000-0000-4000-8000-000000000000"
const ORDINARY_UUID = "abcdefab-cdef-4abc-8def-abcdefabcdef"
const resumeLease = {
  id: "child-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", attemptCount: 1,
} as SubagentLease
const wait = {
  waitId: "wait-1", stepId: "step-1", attempt: 1, ordinal: 2, toolCallId: "wait-call", sourceItemId: "wait-result",
  input: { idempotencyKey: "key-1", taskIds: [targetId, otherId], mode: "all", timeoutMs: 5_000 },
  output: { waitId: "wait-1", status: "ready", taskIds: [otherId, targetId], deadlineAt: "2099-01-01T00:00:00.000Z",
    matchedTaskIds: [targetId, otherId], tasks: [
      { taskId: otherId, status: "completed", role: "analyst", result: null, failureReason: null },
      { taskId: targetId, status: "completed", role: "scout", result: { finalText: freeText }, failureReason: null },
    ] },
} as const

function discoveryOutput(jobId: string, description: string, summary: string): JobDiscoveryOutput {
  return {
    jobs: [{ id: jobId, title: "Engineer", company: "Example", location: "Dublin", url: "https://jobs.example/1",
      description, fullDescription: "Role details", salary: null, logo: null, source: "greenhouse", evidenceRefs: ["source-1"] }],
    evidence: [{ evidenceId: "source-1", jobId, kind: "source", source: "greenhouse", url: "https://jobs.example/1", summary }],
    nextCursor: null,
    usage: { ledgerKey: "ledger-1", toolName: "jobs.discover", toolVersion: "1", toolCallId: "discover-call",
      sessionId: "session-1", turnId: "turn-1", stepId: "step-1", requests: 1, jobsProcessed: 1, jobsSucceeded: 1,
      jobsFailed: 0, providerFailures: 0, aiCalls: 0, providers: ["greenhouse"], estimatedCostUsd: 0, durationMs: 10 },
  }
}

async function resumeDiscovery(output: unknown, callId: string) {
  const sink = new InMemoryToolLifecycleSink()
  const lifecycle = new ToolLifecycle({ sink })
  const call: LifecycleCall = { id: callId, toolName: "jobs.discover", toolVersion: "1", sessionId: "session-1", turnId: "turn-1",
    stepId: "step-1", taskId: "child-1", rootTaskId: "root-1" }
  await lifecycle.started(call, { targetRoles: ["Engineer"], targetLocations: ["Dublin"] })
  await lifecycle.completed(call, output)
  return { sink, observations: buildChildResumeObservations(lifecycleRows(sink, call), resumeLease).observations }
}

function lifecycleRows(sink: InMemoryToolLifecycleSink, call: LifecycleCall, ordinal = 0) {
  return sink.replay().map(({ item }, revision) => ({
    id: item.id, revision, sessionId: item.sessionId, turnId: item.turnId, taskId: call.taskId, rootTaskId: call.rootTaskId,
    stepId: item.stepId, attempt: 1, ordinal, type: item.type, status: item.status,
    content: item.type === "tool_call"
      ? { toolCallId: item.toolCallId, toolName: item.toolName, input: item.input }
      : { toolCallId: item.toolCallId, output: item.output, errorCode: item.errorCode },
  }))
}

describe("durable child wait resume observation", () => {
  it("preserves strict canonical discovery IDs through lifecycle, resume, and hydration", async () => {
    expect(redactSensitiveText(NUMERIC_UUID)).not.toBe(NUMERIC_UUID)
    expect(redactSensitiveText(ORDINARY_UUID)).toBe(ORDINARY_UUID)
    for (const { jobId, description } of [
      { jobId: NUMERIC_UUID, description: `Job reference ${NUMERIC_UUID}` },
      { jobId: ORDINARY_UUID, description: "Ordinary role details" },
    ]) {
      const { sink, observations } = await resumeDiscovery(discoveryOutput(jobId, description, "Provider listing"), `call-${jobId}`)
      const persisted = sink.replay().find(event => event.phase === "completed")?.item
      expect(persisted?.type).toBe("tool_result")
      if (persisted?.type !== "tool_result") throw new Error("missing_discovery_result")
      expect((persisted.output as JobDiscoveryOutput).jobs[0]?.id).toBe(jobId)
      expect((persisted.output as JobDiscoveryOutput).evidence[0]?.jobId).toBe(jobId)

      const resumed = observations[0]?.content as Record<string, unknown>
      const output = resumed.output as JobDiscoveryOutput
      expect(output.jobs[0]?.id).toBe(jobId)
      expect(output.evidence[0]?.jobId).toBe(jobId)
      if (jobId === NUMERIC_UUID) expect(output.jobs[0]?.description).toContain("[REDACTED_PHONE]")
      const index = createObservedEvidenceIndex()
      hydrateObservedEvidence(index, observations)
      expect([...index.entries.values()].map(entry => entry.ref)).toContain(jobId)
    }
  })

  it("redacts hostile discovery text and fails closed on unrecognized tenant or owner fields", async () => {
    const hostileText = `${NUMERIC_UUID} candidate@example.test Bearer abcdefghijk apiKey=sk-test-secret-value`
    const safe = await resumeDiscovery(discoveryOutput(NUMERIC_UUID, hostileText, hostileText), "safe-call")
    const encoded = JSON.stringify(safe.observations)
    for (const secret of ["candidate@example.test", "abcdefghijk", "sk-test-secret-value"]) expect(encoded).not.toContain(secret)
    expect(encoded).toContain("[REDACTED_PHONE]")
    expect(() => hydrateObservedEvidence(createObservedEvidenceIndex(), safe.observations)).not.toThrow()

    const scoped = { ...discoveryOutput(NUMERIC_UUID, "Role", "Listing"), ownerId: "private-owner", tenantId: "private-tenant" }
    const rejected = await resumeDiscovery(scoped, "scoped-call")
    const rejectedOutput = (rejected.observations[0]?.content as Record<string, unknown>).output
    expect(rejectedOutput).toBe("[REDACTED]")
    expect(JSON.stringify(rejected.observations)).not.toMatch(/private-owner|private-tenant/)
    expect(() => hydrateObservedEvidence(createObservedEvidenceIndex(), rejected.observations)).toThrow("child_resume_evidence_invalid")
  })

  it("preserves only strict durable discovery references and restores oversized results", async () => {
    const referenceId = "tool-result-abcdefab-cdef-4abc-8def-abcdefabcdef"
    let storedDiscovery: RepositoryJsonValue | undefined
    const durableResults: ToolResultReferenceRepository = {
      async put(_owner, input) {
        storedDiscovery = input.value as RepositoryJsonValue
        const encoded = canonicalJson(storedDiscovery)
        const now = new Date()
        return { id: referenceId, userId: resumeLease.userId, sessionId: resumeLease.sessionId, turnId: resumeLease.turnId!,
          stepId: input.stepId, taskId: resumeLease.id, toolCallId: input.toolCallId, sanitizedJson: storedDiscovery,
          sha256: createHash("sha256").update(encoded, "utf8").digest("hex"), byteCount: Buffer.byteLength(encoded, "utf8"),
          createdAt: now, updatedAt: now }
      },
      async read() { return null },
    }
    const sink = new InMemoryToolLifecycleSink()
    const call: LifecycleCall = { id: "large-discover", toolName: "jobs.discover", toolVersion: "1", sessionId: "session-1", turnId: "turn-1",
      stepId: "step-1", taskId: "child-1", rootTaskId: "root-1" }
    const lifecycle = new ToolLifecycle({ sink, durableResults, resolveOwner: () => ({ kind: "task", lease: resumeLease }) })
    await lifecycle.started(call, { targetRoles: ["Engineer"], targetLocations: ["Dublin"] })
    await lifecycle.completed(call, discoveryOutput(NUMERIC_UUID, "x".repeat(8_000), "Large provider listing"))
    if (storedDiscovery === undefined) throw new Error("large_discovery_was_not_stored")

    const persisted = sink.replay().find(event => event.phase === "completed")?.item
    if (persisted?.type !== "tool_result") throw new Error("missing_large_discovery_result")
    const reference = persisted.output as { $ref: string; sizeBytes: number; sha256: string }
    expect(reference).toMatchObject({ $ref: referenceId, sizeBytes: Buffer.byteLength(canonicalJson(storedDiscovery), "utf8"), sha256: expect.any(String) })
    expect(Object.keys(reference).sort()).toEqual(["$ref", "sha256", "sizeBytes"])

    const rows: Record<string, unknown>[] = lifecycleRows(sink, call)
    for (const malformed of [
      { ...reference, ownerId: "foreign-owner" },
      { ...reference, $ref: "tool-result-not-a-canonical-uuid" },
      { ...reference, sizeBytes: 0 },
    ]) {
      const malformedRows = rows.map(row => row.type === "tool_result"
        ? { ...row, content: { ...(row.content as Record<string, unknown>), output: malformed } }
        : row)
      expect(() => buildChildResumeObservations(malformedRows, resumeLease)).toThrow("child_resume_evidence_invalid")
    }

    const encoded = Buffer.from(canonicalJson(storedDiscovery), "utf8")
    const digest = createHash("sha256").update(encoded).digest("hex")
    const readRows: Record<string, unknown>[] = []
    let offset = 0
    let chunkOrdinal = 1
    let chunkIndex = 0
    while (offset < encoded.length) {
      const end = Math.min(offset + 4 * 1024, encoded.length)
      const readCallId = `large-read-${chunkIndex}`
      const input = { referenceId, ...(offset === 0 ? {} : { cursor: String(offset) }) }
      const output = { ref: referenceId, sha256: digest, byteCount: encoded.length,
        chunk: encoded.subarray(offset, end).toString("utf8"), nextCursor: end === encoded.length ? null : String(end) }
      readRows.push(
        { id: `tool-item:${readCallId}`, revision: chunkIndex * 2 + 2, sessionId: call.sessionId, turnId: call.turnId,
          taskId: call.taskId, rootTaskId: call.rootTaskId, stepId: call.stepId, attempt: 1, ordinal: chunkOrdinal,
          type: "tool_call", status: "started", content: { toolCallId: readCallId, toolName: "tool_results.read", input } },
        { id: `tool-result-item:${readCallId}`, revision: chunkIndex * 2 + 3, sessionId: call.sessionId, turnId: call.turnId,
          taskId: call.taskId, rootTaskId: call.rootTaskId, stepId: call.stepId, attempt: 1, ordinal: chunkOrdinal,
          type: "tool_result", status: "completed", content: { toolCallId: readCallId, output, errorCode: null } },
      )
      offset = end
      chunkOrdinal += 1
      chunkIndex += 1
    }

    const observations = buildChildResumeObservations([...rows, ...readRows], resumeLease).observations
    expect((observations[0]?.content as Record<string, unknown>).output).toEqual(reference)
    const restoredChunks = observations.filter(block => (block.content as Record<string, unknown>).toolName === "tool_results.read")
      .map(block => ((block.content as Record<string, unknown>).output as { chunk: string }).chunk).join("")
    expect(restoredChunks).toBe(encoded.toString("utf8"))
    const index = createObservedEvidenceIndex()
    hydrateObservedEvidence(index, observations)
    expect([...index.entries.values()].map(entry => entry.ref)).toContain(NUMERIC_UUID)

    const corruptChunkRows = [...rows, ...readRows].map(row => {
      const content = row.content as Record<string, unknown>
      if (row.type !== "tool_result" || content.toolCallId !== "large-read-0") return row
      const output = content.output as { chunk: string }
      return { ...row, content: { ...content, output: { ...output, chunk: `!${output.chunk.slice(1)}` } } }
    })
    expect(() => buildChildResumeObservations(corruptChunkRows, resumeLease)).toThrow("child_resume_evidence_invalid")

    const mismatchedSourceRows = [...rows, ...readRows].map(row => {
      const content = row.content as Record<string, unknown>
      if (row.type !== "tool_call" || content.toolCallId !== "large-read-0") return row
      return { ...row, content: { ...content, input: { referenceId: "tool-result-00000000-0000-4000-8000-000000000000" } } }
    })
    expect(() => buildChildResumeObservations(mismatchedSourceRows, resumeLease)).toThrow("child_resume_evidence_invalid")
  })

  it("validates the durable shape, retains only structural IDs, and preserves valid reordering", () => {
    const row = { id: "wait-1", status: "ready", mode: "all", targetTaskIds: [targetId, otherId],
      matchedTaskIds: [targetId, otherId], deadlineAt: "2099-01-01T00:00:00.000Z", result: { outcome: wait.output } }
    expect(resolveDurableWaitOutcome(row, row.targetTaskIds, row.matchedTaskIds, new Date("2026-10-22T10:00:00.000Z")))
      .toMatchObject({ waitId: "wait-1", status: "ready", taskIds: row.targetTaskIds })
    expect(() => resolveDurableWaitOutcome(row, row.targetTaskIds, [targetId], new Date("2026-10-22T10:00:00.000Z")))
      .toThrow("Persisted child wait result is invalid")

    const observations = [
      { id: "child-resume:wait-result", content: { toolCallId: "wait-call", toolName: "wait_subagents", input: wait.input, status: "completed", output: { status: "waiting" }, errorCode: null } },
      { id: "child-resume:other-result", content: { toolCallId: "other-call", toolName: "jobs.search", input: {}, status: "completed", output: { jobs: [] }, errorCode: null } },
    ]
    const restored = mergeDurableWaitObservation(observations, wait)
    expect(restored).toHaveLength(2)
    expect(restored[0]).toEqual(observations[1])
    expect(restored[1]?.id).toBe("child-resume:wait-result")

    const content = restored[1]?.content as Record<string, unknown>
    const input = content.input as Record<string, unknown>
    const output = content.output as Record<string, unknown>
    const tasks = output.tasks as Array<Record<string, unknown>>
    expect(input.taskIds).toEqual([targetId, otherId])
    expect(output.taskIds).toEqual([otherId, targetId])
    expect(output.matchedTaskIds).toEqual([targetId, otherId])
    expect(tasks.map(task => task.taskId)).toEqual([otherId, targetId])
    expect((tasks[1]?.result as Record<string, unknown>).finalText).toBe(redactSensitiveText(freeText))
    expect((tasks[1]?.result as Record<string, unknown>).finalText).not.toContain(targetId)
  })

  it("retains the validated canonical call ID internally while redacting ordinary restored text", () => {
    const phoneWait = { ...wait, toolCallId: phoneShapedCallId }
    const restored = mergeDurableWaitObservation([], phoneWait)
    const content = restored[0]?.content as Record<string, unknown>
    const output = content.output as Record<string, unknown>
    const tasks = output.tasks as Array<Record<string, unknown>>

    expect(redactSensitiveText(phoneShapedCallId)).not.toBe(phoneShapedCallId)
    expect(content.toolCallId).toBe(phoneShapedCallId)
    expect((tasks[1]?.result as Record<string, unknown>).finalText).toBe(redactSensitiveText(freeText))
    expect(JSON.stringify(content.input)).not.toContain(phoneShapedCallId)
    expect(JSON.stringify(content.output)).not.toContain(phoneShapedCallId)
  })

  it("matches wait observations by exact raw ID and fails closed on conflicting or duplicate lineage", () => {
    const phoneWait = { ...wait, toolCallId: phoneShapedCallId }
    const redactedIdObservation = { id: "child-resume:unrelated", content: { toolCallId: redactSensitiveText(phoneShapedCallId) } }
    const restored = mergeDurableWaitObservation([redactedIdObservation], phoneWait)
    expect(restored).toHaveLength(2)
    expect((restored[1]?.content as Record<string, unknown>).toolCallId).toBe(phoneShapedCallId)

    const prior = { id: `child-resume:${wait.sourceItemId}`, content: { toolCallId: phoneShapedCallId } }
    expect(mergeDurableWaitObservation([prior], phoneWait)).toHaveLength(1)
    const oldRedactedSource = { id: `child-resume:${wait.sourceItemId}`, content: { toolCallId: redactSensitiveText(phoneShapedCallId) } }
    expect((mergeDurableWaitObservation([oldRedactedSource], phoneWait)[0]?.content as Record<string, unknown>).toolCallId)
      .toBe(phoneShapedCallId)
    expect(() => mergeDurableWaitObservation([{ id: "tool-result:phone", content: { toolCallId: phoneShapedCallId } }], phoneWait))
      .toThrow("child_resume_wait_tool_call_conflict")
    expect(() => mergeDurableWaitObservation([
      prior,
      { id: "child-resume:duplicate", content: { toolCallId: phoneShapedCallId } },
    ], phoneWait)).toThrow("child_resume_wait_tool_call_conflict")
    expect(() => mergeDurableWaitObservation([
      { id: "child-resume:wrong-source", content: { toolCallId: phoneShapedCallId } },
    ], phoneWait)).toThrow("child_resume_wait_tool_call_conflict")
    expect(() => mergeDurableWaitObservation([
      { id: `child-resume:${wait.sourceItemId}`, content: { toolCallId: "misbound-call" } },
    ], phoneWait)).toThrow("child_resume_wait_tool_call_conflict")
  })

  it("rejects malformed canonical wait call IDs without normalizing their identity", () => {
    expect(() => mergeDurableWaitObservation([], { ...wait, toolCallId: " " }))
      .toThrow("child_resume_wait_lineage")
    expect(() => mergeDurableWaitObservation([], { ...wait, toolCallId: "x".repeat(257) }))
      .toThrow("child_resume_wait_lineage")
  })

  it("rejects duplicate, missing, forged, malformed, and misbound target IDs", () => {
    expect(() => mergeDurableWaitObservation([], { ...wait, input: { ...wait.input, taskIds: [targetId, targetId] } }))
      .toThrow("child_resume_invalid_wait_input")
    expect(() => mergeDurableWaitObservation([], { ...wait, input: { ...wait.input, taskIds: [targetId, 2] } }))
      .toThrow("child_resume_invalid_wait_input")
    expect(() => mergeDurableWaitObservation([], { ...wait, output: { ...wait.output, taskIds: [targetId] } }))
      .toThrow("child_resume_invalid_wait_result")
    expect(() => mergeDurableWaitObservation([], { ...wait, output: { ...wait.output, taskIds: ["forged", otherId] } }))
      .toThrow("child_resume_invalid_wait_result")
    expect(() => mergeDurableWaitObservation([], { ...wait, output: { ...wait.output, taskIds: [otherId, otherId] } }))
      .toThrow("child_resume_invalid_wait_result")
    expect(() => mergeDurableWaitObservation([], { ...wait, output: { ...wait.output, matchedTaskIds: ["foreign"] } }))
      .toThrow("child_resume_invalid_wait_result")
    expect(() => mergeDurableWaitObservation([], { ...wait, output: { ...wait.output,
      tasks: [wait.output.tasks[0], { ...wait.output.tasks[1], taskId: "misbound" }] } }))
      .toThrow("child_resume_invalid_wait_result")
    expect(() => mergeDurableWaitObservation([], { ...wait, output: { ...wait.output, waitId: "other-wait" } }))
      .toThrow("child_resume_invalid_wait_result")
  })

  it("checks matched IDs against the stored task snapshot while allowing valid timeout and async states", () => {
    const anyMode = { ...wait, input: { ...wait.input, mode: "any" } }
    const readyAsync = { ...anyMode, output: { ...wait.output, matchedTaskIds: [targetId], tasks: [
      { ...wait.output.tasks[0], status: "running" }, wait.output.tasks[1],
    ] } }
    expect(() => mergeDurableWaitObservation([], readyAsync)).not.toThrow()
    expect(() => mergeDurableWaitObservation([], { ...anyMode, output: { ...readyAsync.output,
      tasks: [{ ...readyAsync.output.tasks[0], status: "running" }, { ...readyAsync.output.tasks[1], status: "running" }] } }))
      .toThrow("child_resume_invalid_wait_result")
    expect(() => mergeDurableWaitObservation([], { ...wait, output: { ...wait.output,
      tasks: wait.output.tasks.map(task => ({ ...task, status: "running" })) } }))
      .toThrow("child_resume_invalid_wait_result")

    const timedOut = { ...wait, output: { ...wait.output, status: "timed_out", deadlineAt: new Date(Date.now() - 60_000).toISOString(),
      matchedTaskIds: [targetId], tasks: [ { ...wait.output.tasks[0], status: "running" }, wait.output.tasks[1] ] } }
    expect(() => mergeDurableWaitObservation([], timedOut)).not.toThrow()
    expect(() => mergeDurableWaitObservation([], { ...timedOut, output: { ...timedOut.output, matchedTaskIds: [],
      tasks: timedOut.output.tasks.map(task => ({ ...task, status: "running" })) } })).not.toThrow()
  })
})
