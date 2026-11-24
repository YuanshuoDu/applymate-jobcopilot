import { describe, expect, it, vi } from "vitest"
import type { PoolClient } from "pg"
import {
  buildObjectiveApplicationResumeWitness,
  sameObjectiveApplicationResumeWitness,
  type ObjectiveApplicationResumeMaterial,
} from "@jobcopilot/shared"
import { readObjectiveApplicationResumeWitness } from "./objective-application-resume-witness.js"

const scope = { userId: "user-1", jobId: "job-1" }
const material: ObjectiveApplicationResumeMaterial = {
  name: "Tailored resume", content: { basics: { name: "Candidate" }, experience: [{ company: "A" }] },
  templateId: "modern", templateOptions: { accentColor: "blue" }, kind: "adapted", targetJobId: "job-1",
  parentResumeId: "base-1", basicsDetached: false,
}
const row = {
  jobId: "job-1", userId: "user-1", finalResumeId: "resume-1", finalResumeAssignmentRevision: 3,
  resumeId: "resume-1", resumeUserId: "user-1", ...material, materialRevision: 2,
}

function reader(rows: readonly unknown[] = [row]) {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows }))
  return { client: { query } as unknown as Pick<PoolClient, "query">, query }
}

describe("Worker objective application Resume witness reader", () => {
  it("reads and locks the exact owned Job-to-Resume row on the supplied client", async () => {
    const { client, query } = reader()
    const witness = await readObjectiveApplicationResumeWitness(client, scope)
    expect(witness).toEqual(buildObjectiveApplicationResumeWitness({
      ...scope, resumeId: "resume-1", finalResumeAssignmentRevision: 3, materialRevision: 2, material,
    }))
    expect(witness).not.toHaveProperty("content")
    expect(query).toHaveBeenCalledOnce()
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('INNER JOIN "Resume"')
    expect(sql).toContain('resume."userId" = job."userId"')
    expect(sql).toContain('resume."targetJobId" = job."id"')
    expect(sql).toContain("resume.\"kind\" = 'adapted'")
    expect(sql).toContain('WHERE job."id" = $1 AND job."userId" = $2')
    expect(sql).toContain("FOR SHARE OF job, resume")
    expect(values).toEqual([scope.jobId, scope.userId])
    expect(sql).not.toMatch(/\b(?:BEGIN|COMMIT|ROLLBACK)\b/i)
  })

  it("returns null without broad reads for invalid scope, missing or duplicate rows", async () => {
    const empty = reader([])
    await expect(readObjectiveApplicationResumeWitness(empty.client, scope)).resolves.toBeNull()
    const duplicate = reader([row, row])
    await expect(readObjectiveApplicationResumeWitness(duplicate.client, scope)).resolves.toBeNull()
    const invalid = reader()
    await expect(readObjectiveApplicationResumeWitness(invalid.client, { ...scope, userId: " user-1 " })).resolves.toBeNull()
    expect(invalid.query).not.toHaveBeenCalled()
  })

  it("fails closed on cross-scope, pointer, kind, and revision mismatches", async () => {
    for (const invalid of [
      { ...row, jobId: "job-2" }, { ...row, userId: "user-2" }, { ...row, resumeUserId: "user-2" },
      { ...row, finalResumeId: "resume-2" }, { ...row, resumeId: "resume-2" }, { ...row, targetJobId: "job-2" },
      { ...row, kind: "base" }, { ...row, finalResumeAssignmentRevision: -1 },
      { ...row, materialRevision: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      const { client } = reader([invalid])
      await expect(readObjectiveApplicationResumeWitness(client, scope)).resolves.toBeNull()
    }
  })

  it("keeps revision ABA distinct even when the adapted material hash returns to its old value", async () => {
    const first = reader([row])
    const restored = reader([{ ...row, materialRevision: 4 }])
    const firstWitness = await readObjectiveApplicationResumeWitness(first.client, scope)
    const restoredWitness = await readObjectiveApplicationResumeWitness(restored.client, scope)
    expect(restoredWitness?.resumeMaterialHash).toBe(firstWitness?.resumeMaterialHash)
    expect(sameObjectiveApplicationResumeWitness(firstWitness, restoredWitness)).toBe(false)
  })

  it("rejects non-JSON Resume material through the shared canonical digest builder", async () => {
    const { client } = reader([{ ...row, content: new Date() }])
    await expect(readObjectiveApplicationResumeWitness(client, scope)).resolves.toBeNull()
  })
})
