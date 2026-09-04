import { describe, expect, it, vi } from "vitest"

import { createApplicationSubmitRepository } from "./application-submit-repo.js"

const attempt = {
  id: "attempt-1", userId: "user-a", jobId: "job-a", receiptId: "receipt-a",
  constraintHash: "c".repeat(64), artifactHash: "a".repeat(64), state: "reserved",
  responseRef: null, errorCode: null, createdAt: new Date(), updatedAt: new Date(),
}

function pool(query: ReturnType<typeof vi.fn>) {
  return { query } as never
}

describe("application submit pg repository", () => {
  it("looks up a target with tenant and server-owned URL predicates", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "job-a", userId: "user-a", company: "Acme", role: "Engineer", url: "https://jobs.example/apply", source: "greenhouse" }], rowCount: 1 })
    const repository = createApplicationSubmitRepository(pool(query))

    await expect(repository.findTarget("user-a", "job-a")).resolves.toMatchObject({ jobId: "job-a", applyUrl: "https://jobs.example/apply" })
    expect(query).toHaveBeenCalledWith(expect.stringContaining('"userId" = $2 AND "url" IS NOT NULL'), ["job-a", "user-a"])
  })

  it("reserves with parameterized SQL and returns a typed attempt", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [attempt], rowCount: 1 })
    const repository = createApplicationSubmitRepository(pool(query))

    await expect(repository.reserve({ userId: "user-a", jobId: "job-a", receiptId: "receipt-a", constraintHash: attempt.constraintHash, artifactHash: attempt.artifactHash })).resolves.toMatchObject({ kind: "reserved", attempt })
    expect(query.mock.calls[0]?.[0]).toContain("INSERT INTO \"submission_attempt\"")
    expect(query.mock.calls[0]?.[1]).toEqual([expect.any(String), "user-a", "job-a", "receipt-a", attempt.constraintHash, attempt.artifactHash])
  })

  it("maps a unique receipt race to a replay without a second insert", async () => {
    const query = vi.fn()
      .mockRejectedValueOnce({ code: "23505" })
      .mockResolvedValueOnce({ rows: [{ ...attempt, state: "submitted", responseRef: "confirmation-1" }], rowCount: 1 })
    const repository = createApplicationSubmitRepository(pool(query))

    await expect(repository.reserve({ userId: "user-a", jobId: "job-a", receiptId: "receipt-a", constraintHash: attempt.constraintHash, artifactHash: attempt.artifactHash })).resolves.toMatchObject({ kind: "replay", attempt: { responseRef: "confirmation-1", state: "submitted" } })
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[1]?.[1]).toEqual(["user-a", "receipt-a"])
  })

  it("updates only a tenant-owned reserved attempt", async () => {
    const submitted = { ...attempt, state: "submitted", responseRef: "confirmation-1" }
    const query = vi.fn().mockResolvedValue({ rows: [submitted], rowCount: 1 })
    const repository = createApplicationSubmitRepository(pool(query))

    await expect(repository.markSubmitted("user-a", "receipt-a", "confirmation-1")).resolves.toMatchObject(submitted)
    expect(query).toHaveBeenCalledWith(expect.stringContaining('"userId" = $2 AND "receiptId" = $3 AND "state" = \'reserved\''), ["confirmation-1", "user-a", "receipt-a"])
  })
})
