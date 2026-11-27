import { beforeEach, describe, expect, it, vi } from "vitest"

const loadSource = vi.hoisted(() => vi.fn())
vi.mock("./selected-job-artifact-context.js", () => ({ loadSelectedJobArtifactContext: loadSource }))

import { makeScheduledDraftCandidateWitnessV2 } from "./scheduled-draft-candidate-witness.js"
import { scheduledDraftJobMaterialDigest } from "./scheduled-draft-job-material.js"
import type { SelectedJobArtifactContextBundle } from "./selected-job-artifact-context.js"
import { loadSelectedJobArtifactContextForChild } from "./scheduled-draft-writer-source.js"

const digest = "a".repeat(64)
const jobId = "c123456789012345678901234"
const job = {
  id: jobId, company: "Example GmbH", role: "Engineer", location: "Berlin", status: "open", score: 8,
  url: "https://jobs.example/1", source: "greenhouse", salary: "EUR 80k", description: "Current job description", keywords: "TypeScript",
}
const witnessCore = {
  graphRevision: 3, graphDigest: digest, stableStatusDigest: digest, newlyProposedNodeKeys: [],
  candidate: { jobId, score: 8 }, sourceAnalystKeys: ["analyst-1"],
  analysts: [{ nodeKey: "analyst-1", taskId: "analyst-task", attemptCount: 1, resultDigest: digest,
    evidenceDigest: digest, reportDigest: digest, scouts: [{ nodeKey: "scout-1", taskId: "scout-task", attemptCount: 1,
      nodeDigest: digest, resultDigest: digest, evidenceDigest: digest, reportDigest: digest }] }],
}
const pool = { query: vi.fn() }

function sourceBundle(value: unknown = job): SelectedJobArtifactContextBundle {
  return {
    preparation: { jobId, sourceDigest: `sha256:${digest}`, evidenceRefs: [`job:${jobId}`, "resume:resume-1"] },
    baseResumeId: "resume-1", transientSources: [{ sourceRef: `job:${jobId}`, content: value }, { sourceRef: "resume:resume-1", content: {} }],
  }
}

function scheduledContext(witness: unknown): Record<string, unknown> {
  return { scheduledDraftCandidateMode: true, scheduledDraftCandidateWitness: witness }
}

function v1Witness() {
  const v2 = makeScheduledDraftCandidateWitnessV2({ ...witnessCore, jobMaterialDigest: `sha256:${digest}` })
  const { bindingVersion: _version, jobMaterialDigest: _materialDigest, ...core } = v2
  return { bindingVersion: "agent-harness.v2.scheduled-draft-candidate-binding.v1", ...core }
}

beforeEach(() => loadSource.mockReset())

describe("scheduled draft Writer source admission", () => {
  it("keeps ordinary selected-job loading unchanged when no schedule marker exists", async () => {
    const source = sourceBundle()
    loadSource.mockResolvedValue(source)

    await expect(loadSelectedJobArtifactContextForChild(pool as never, "user-1", jobId)).resolves.toEqual({ context: source })
    expect(loadSource).toHaveBeenCalledOnce()
  })

  it("continues a valid persisted V1 scheduled witness", async () => {
    const source = sourceBundle({ ...job, description: "changed after the V1 witness" })
    loadSource.mockResolvedValue(source)

    await expect(loadSelectedJobArtifactContextForChild(pool as never, "user-1", jobId, scheduledContext(v1Witness()))).resolves.toEqual({ context: source })
  })

  it("admits V2 only when the exact loaded Job source matches its commitment", async () => {
    const source = sourceBundle()
    loadSource.mockResolvedValue(source)
    const witness = makeScheduledDraftCandidateWitnessV2({
      ...witnessCore, jobMaterialDigest: scheduledDraftJobMaterialDigest(job)!,
    })

    const admitted = await loadSelectedJobArtifactContextForChild(pool as never, "user-1", jobId, scheduledContext(witness))
    expect(admitted?.context).toBe(source)
    expect(admitted?.assertCurrentDraftMaterial).toBeTypeOf("function")
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM "Job"')) return { rows: [job] }
      throw new Error("unexpected material fence query")
    }) }
    await expect(admitted!.assertCurrentDraftMaterial!(client as never, "user-1", jobId)).resolves.toBe(true)
    await expect(admitted!.assertCurrentDraftMaterial!(client as never, "other-user", jobId)).resolves.toBe(false)
    await expect(admitted!.assertCurrentDraftMaterial!(client as never, "user-1", "other-job")).resolves.toBe(false)
    expect(client.query).toHaveBeenCalledOnce()
  })

  it("denies loaded Job drift, missing or duplicate exact Job sources, and wrong candidate identity", async () => {
    const witness = makeScheduledDraftCandidateWitnessV2({
      ...witnessCore, jobMaterialDigest: scheduledDraftJobMaterialDigest(job)!,
    })
    loadSource.mockResolvedValueOnce(sourceBundle({ ...job, description: "changed before the Writer loads" }))
    await expect(loadSelectedJobArtifactContextForChild(pool as never, "user-1", jobId, scheduledContext(witness))).resolves.toBeUndefined()

    loadSource.mockResolvedValueOnce({ ...sourceBundle(), transientSources: [{ sourceRef: "resume:resume-1", content: {} }] })
    await expect(loadSelectedJobArtifactContextForChild(pool as never, "user-1", jobId, scheduledContext(witness))).resolves.toBeUndefined()

    loadSource.mockResolvedValueOnce({ ...sourceBundle(), transientSources: [...sourceBundle().transientSources, { sourceRef: `job:${jobId}`, content: job }] })
    await expect(loadSelectedJobArtifactContextForChild(pool as never, "user-1", jobId, scheduledContext(witness))).resolves.toBeUndefined()

    await expect(loadSelectedJobArtifactContextForChild(pool as never, "user-1", "job-2", scheduledContext(witness))).resolves.toBeUndefined()
  })

  it("fails closed for malformed, unknown, or accessor-backed schedule markers", async () => {
    const valid = makeScheduledDraftCandidateWitnessV2({ ...witnessCore, jobMaterialDigest: `sha256:${digest}` })
    for (const witness of [
      { ...valid, bindingVersion: 3 },
      { ...valid, jobMaterialDigest: "sha256:invalid" },
      { ...valid, unexpected: true },
    ]) {
      await expect(loadSelectedJobArtifactContextForChild(pool as never, "user-1", jobId, scheduledContext(witness))).resolves.toBeUndefined()
    }
    const accessor = { scheduledDraftCandidateMode: true }
    Object.defineProperty(accessor, "scheduledDraftCandidateWitness", { get: () => { throw new Error("accessor must not run") } })
    await expect(loadSelectedJobArtifactContextForChild(pool as never, "user-1", jobId, accessor)).resolves.toBeUndefined()
    expect(loadSource).not.toHaveBeenCalled()
  })

  it("denies a V2 draft write when its transaction-client Job source has drifted", async () => {
    const witness = makeScheduledDraftCandidateWitnessV2({
      ...witnessCore, jobMaterialDigest: scheduledDraftJobMaterialDigest(job)!,
    })
    loadSource.mockResolvedValue(sourceBundle())
    const admitted = await loadSelectedJobArtifactContextForChild(pool as never, "user-1", jobId, scheduledContext(witness))
    const changedJob = { ...job, description: "changed before the draft write" }
    const client = { query: vi.fn(async (_sql: string) => ({ rows: [changedJob] })) }

    await expect(admitted?.assertCurrentDraftMaterial?.(client as never, "user-1", jobId)).resolves.toBe(false)
    expect(client.query.mock.calls[0]?.[0]).toContain('FROM "Job"')
  })
})
