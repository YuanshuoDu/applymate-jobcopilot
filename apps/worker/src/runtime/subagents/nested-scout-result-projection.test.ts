import { describe, expect, it } from "vitest"

import { projectNestedScoutResults } from "./nested-scout-result-projection.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"

type CandidateInput = Readonly<{ jobId: string; source: string }>

function scoutResult(candidates: readonly CandidateInput[] = [{ jobId: "job-1", source: "greenhouse" }], status = "completed") {
  const evidence = candidates.map((candidate, index) => ({
    id: `evidence-${index}`,
    kind: "job",
    ref: candidate.jobId,
    source: "private evidence source",
  }))
  return {
    schemaVersion: ROLE_RESULT_SCHEMA,
    role: "scout",
    status,
    candidates: candidates.map((candidate, index) => ({
      ...candidate,
      url: null,
      evidenceIds: [`evidence-${index}`],
    })),
    evidence,
    summary: "Private summary must not appear in the projection",
  }
}

function waitTask(
  taskId: string,
  structuredResult: unknown,
  overrides: Record<string, unknown> = {},
) {
  return {
    taskId,
    status: "completed",
    role: "scout",
    attemptCount: 1,
    maxAttempts: 2,
    leaseExpiresAt: null,
    interruptRequestedAt: null,
    result: {
      status: "completed",
      stepCount: 3,
      toolCallCount: 1,
      finalItemId: "private-final-item",
      finalText: "Private freeform response",
      structuredResult,
    },
    failureReason: null,
    ...overrides,
  }
}

function waitOutput(tasks: readonly unknown[]) {
  return {
    waitId: "private-wait-id",
    status: "ready",
    taskIds: tasks.map(task => (task as { taskId: string }).taskId),
    deadlineAt: "2026-11-13T12:00:00.000Z",
    matchedTaskIds: tasks.map(task => (task as { taskId: string }).taskId),
    tasks,
  }
}

describe("nested Scout result projection", () => {
  it("projects validated candidates for the exact expected children only", () => {
    const value = waitOutput([
      waitTask("child-b", scoutResult([{ jobId: "job-b", source: "lever" }])),
      waitTask("child-a", scoutResult([{ jobId: "job-a", source: "greenhouse" }])),
    ])

    const projection = projectNestedScoutResults(value, ["child-a", "child-b"])
    expect(projection).toEqual({
      availability: "available",
      children: [
        { taskId: "child-a", taskStatus: "completed", candidates: [{ jobId: "job-a", source: "greenhouse" }] },
        { taskId: "child-b", taskStatus: "completed", candidates: [{ jobId: "job-b", source: "lever" }] },
      ],
    })
    const encoded = JSON.stringify(projection)
    for (const privateValue of ["Private freeform response", "Private summary", "private-final-item", "private evidence source", "evidence-0", "private-wait-id"]) {
      expect(encoded).not.toContain(privateValue)
    }
  })

  it("keeps a valid empty completed Scout available as an empty child outcome", () => {
    const projection = projectNestedScoutResults(
      [waitTask("child-a", scoutResult([], "completed"))],
      ["child-a"],
    )

    expect(projection).toEqual({
      availability: "available",
      children: [{ taskId: "child-a", taskStatus: "completed", candidates: [] }],
    })
  })

  it.each([
    ["foreign child identity", [waitTask("foreign-child", scoutResult())], ["child-a"]],
    ["duplicate child identity", [waitTask("child-a", scoutResult()), waitTask("child-a", scoutResult())], ["child-a", "child-b"]],
    ["incomplete outer task", [waitTask("child-a", scoutResult(), { status: "running" })], ["child-a"]],
    ["wrong child role", [waitTask("child-a", scoutResult(), { role: "analyst" })], ["child-a"]],
    ["incomplete result wrapper", [waitTask("child-a", scoutResult(), { result: { status: "partial", structuredResult: scoutResult() } })], ["child-a"]],
    ["partial Scout payload", [waitTask("child-a", scoutResult([], "partial"))], ["child-a"]],
    ["missing Scout payload", [waitTask("child-a", undefined)], ["child-a"]],
    ["direct Scout payload without its stored wrapper", [waitTask("child-a", scoutResult(), { result: scoutResult() })], ["child-a"]],
    ["truncated wait result", [waitTask("child-a", scoutResult(), { result: { $truncated: true } })], ["child-a"]],
    ["unknown Scout field", [waitTask("child-a", { ...scoutResult(), privateNote: "do not project" })], ["child-a"]],
    ["unknown wait task field", [waitTask("child-a", scoutResult(), { privateMetadata: "do not project" })], ["child-a"]],
    ["missing expected child", [waitTask("child-a", scoutResult())], ["child-a", "child-b"]],
  ] as const)("fails closed for %s", (_label, tasks, expectedIds) => {
    expect(projectNestedScoutResults(waitOutput(tasks), expectedIds)).toEqual({ availability: "unavailable" })
  })

  it("ignores untrusted wait-envelope metadata and emits no fields outside the projection", () => {
    const projection = projectNestedScoutResults({
      ...waitOutput([waitTask("child-a", scoutResult())]),
      privateMetadata: "must not escape",
    }, ["child-a"])

    expect(projection).toEqual({
      availability: "available",
      children: [{ taskId: "child-a", taskStatus: "completed", candidates: [{ jobId: "job-1", source: "greenhouse" }] }],
    })
    expect(JSON.stringify(projection)).not.toContain("must not escape")
  })

  it("bounds child count, total candidates, and every projected string", () => {
    const source = "s".repeat(256)
    const candidates = Array.from({ length: 10 }, (_, index) => ({
      jobId: `${index}${"j".repeat(255)}`,
      source,
    }))
    const atLimit = projectNestedScoutResults([
      waitTask("child-a", scoutResult(candidates)),
      waitTask("child-b", scoutResult(candidates.map((candidate, index) => ({ ...candidate, jobId: `b${index}${candidate.jobId.slice(2)}` })))),
    ], ["child-a", "child-b"])
    expect(atLimit.availability).toBe("available")
    if (atLimit.availability === "available") {
      expect(atLimit.children).toHaveLength(2)
      expect(atLimit.children.flatMap(child => child.candidates)).toHaveLength(20)
      expect(atLimit.children.flatMap(child => [child.taskId, ...child.candidates.flatMap(candidate => [candidate.jobId, candidate.source])])
        .every(value => value.length <= 256)).toBe(true)
    }

    const overLimitCandidates = Array.from({ length: 21 }, (_, index) => ({
      jobId: `o${String(index).padStart(2, "0")}${"j".repeat(253)}`,
      source: "greenhouse",
    }))
    expect(projectNestedScoutResults([waitTask("child-a", scoutResult(overLimitCandidates))], ["child-a"]))
      .toEqual({ availability: "unavailable" })
    expect(projectNestedScoutResults([waitTask("child-a", scoutResult([{ jobId: "j".repeat(257), source: "greenhouse" }]))], ["child-a"]))
      .toEqual({ availability: "unavailable" })
    expect(projectNestedScoutResults([waitTask("child-a", scoutResult([{ jobId: "job-1", source: "s".repeat(257) }]))], ["child-a"]))
      .toEqual({ availability: "unavailable" })
    expect(projectNestedScoutResults([waitTask("t".repeat(257), scoutResult())], ["t".repeat(257)]))
      .toEqual({ availability: "unavailable" })
    expect(projectNestedScoutResults([waitTask("child-a", scoutResult())], ["a", "b", "c"]))
      .toEqual({ availability: "unavailable" })
  })
})
