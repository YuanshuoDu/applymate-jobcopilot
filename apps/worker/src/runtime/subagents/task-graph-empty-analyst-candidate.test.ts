import { describe, expect, it, vi } from "vitest"
import type { TaskExecutionOwnerFence } from "../execution-owner.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, validateTaskGraphVerificationContract } from "../planning/task-graph-verification.js"
import {
  authorizeEmptyAnalystCandidate, completeEmptyAnalystCandidateOnly,
  type EmptyAnalystCandidateAuthorizer,
  type EmptyAnalystCandidateHandoff,
} from "./task-graph-empty-analyst-candidate.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"

const candidateText = JSON.stringify({ schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed",
  findings: [], evidence: [], summary: "No findings" })

function taskIdentity(): TaskExecutionOwnerFence {
  return { kind: "task", userId: "user", sessionId: "session", turnId: "turn", taskId: "analyst",
    rootTaskId: "root", ownerId: "owner", attemptCount: 2, leaseExpiresAt: new Date("2030-01-01T00:00:00Z") }
}

describe("TaskGraph empty Analyst candidate handoff", () => {
  it("rejects incomplete and ambiguous multi-Scout source selectors at the contract boundary", () => {
    const contract = (dependencyNodeKeys: string[]) => ({ schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
      criteria: [{ id: "source-coverage", check: { kind: "findings_cover_each_scout_candidates_gte", dependencyNodeKeys, minimumPercent: 100 } }] })
    expect(validateTaskGraphVerificationContract(contract(["scout-a"]), "analyst")).toMatchObject({
      ok: false, error: { code: "invalid_shape" },
    })
    expect(validateTaskGraphVerificationContract(contract(["scout-a", "scout-a"]), "analyst")).toMatchObject({
      ok: false, error: { code: "invalid_shape" },
    })
  })

  it("does not trust a model-supplied authorization marker or forged token", async () => {
    const identity = taskIdentity(), forged = { authorization: "task_graph_empty_analyst" } as unknown as EmptyAnalystCandidateHandoff
    const authorize: EmptyAnalystCandidateAuthorizer = async () => forged
    const finishStep = vi.fn(async () => undefined)

    await expect(completeEmptyAnalystCandidateOnly({ identity, candidateText,
      authorize, stepCount: 1, toolCallCount: 0, finishStep })).resolves.toBeNull()
    expect(finishStep).not.toHaveBeenCalled()
  })

  it("does not request a child authorization for a root Turn", async () => {
    const authorize = vi.fn(async () => null), finishStep = vi.fn(async () => undefined)
    await expect(completeEmptyAnalystCandidateOnly({ identity: { kind: "turn" }, candidateText,
      authorize, stepCount: 1, toolCallCount: 0, finishStep })).resolves.toBeNull()
    expect(authorize).not.toHaveBeenCalled()
    expect(finishStep).not.toHaveBeenCalled()
  })

  it("rejects malformed or nonempty results before opening a database connection", async () => {
    const connect = vi.fn(), pool = { connect }
    const lease = {} as never
    const identity = {} as unknown as TaskExecutionOwnerFence
    for (const text of ["not-json", candidateText.replace('"evidence":[]', '"evidence":[{}]'),
      candidateText.replace('"findings":[]', '"findings":[{}]'), candidateText.replace(/\}$/, ',"authorization":true}')]) {
      await expect(authorizeEmptyAnalystCandidate({ pool, lease, identity, candidateText: text })).resolves.toBeNull()
    }
    expect(connect).not.toHaveBeenCalled()
  })

  it("rejects a valid empty result when the server lease does not match the owner fence", async () => {
    const connect = vi.fn(), pool = { connect }
    await expect(authorizeEmptyAnalystCandidate({ pool, lease: {} as never, identity: taskIdentity(), candidateText }))
      .resolves.toBeNull()
    expect(connect).not.toHaveBeenCalled()
  })
})
