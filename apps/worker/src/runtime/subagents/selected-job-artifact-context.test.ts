import { describe, expect, it, vi } from "vitest"

import { computeArtifactSourceDigest, InMemoryArtifactToolStore } from "../tools/artifact-tools.js"
import { bindSelectedJobReadInput, loadSelectedJobArtifactContext } from "./selected-job-artifact-context.js"
import { resolveCoverLetterBase } from "./selected-job-artifact-context.js"

type PersonaFactFixture = {
  id: string
  key: string
  category: string
  value: string
  source: string
  sourceRef: string | null
  confidence: number
  allowedUses: string[]
}

function pool(options: { job?: boolean; resume?: boolean; personaFacts?: PersonaFactFixture[] } = {}) {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values })
      if (sql.includes('FROM "Job"')) return { rows: options.job === false ? [] : [{
        id: "job-1", company: "Example GmbH", role: "Engineer", location: "Berlin", status: "open", score: 8,
        url: "https://jobs.example/1", source: "greenhouse", salary: "EUR 80k", description: "Build systems", keywords: "TypeScript",
        createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-02T00:00:00Z"),
      }] }
      if (sql.includes('FROM "Resume"')) return { rows: options.resume === false ? [] : [{
        id: "resume-1", name: "Base", kind: "base", origin: "manual", isDefault: true, content: { text: "Engineer with TypeScript experience" },
        createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-02T00:00:00Z"),
      }] }
      if (sql.includes("FROM persona_facts")) return { rows: options.personaFacts ?? [{
        id: "fact-1", key: "language", category: "language", value: "English C1", source: "resume", sourceRef: "resume:language",
        confidence: 0.98, allowedUses: ["cover_letter"],
      }] }
      throw new Error(`unexpected source query: ${sql}`)
    }),
  }
  return { query: client.query, calls }
}

describe("loadSelectedJobArtifactContext", () => {
  it("loads only owner-scoped job, base resume and cover-letter-approved persona evidence", async () => {
    const fakePool = pool()
    const bundle = await loadSelectedJobArtifactContext(fakePool as never, "user-1", "job-1")
    const expectedSources = [
      { sourceRef: "job:job-1", content: {
        id: "job-1", company: "Example GmbH", role: "Engineer", location: "Berlin", status: "open", score: 8,
        url: "https://jobs.example/1", source: "greenhouse", salary: "EUR 80k", description: "Build systems", keywords: "TypeScript",
      } },
      { sourceRef: "resume:resume-1", content: { text: "Engineer with TypeScript experience" } },
      { sourceRef: "persona:fact-1", content: { id: "fact-1", key: "language", value: "English C1", confidence: 0.98, sourceRef: "resume:language" } },
    ]
    const expectedDigest = computeArtifactSourceDigest("job-1", expectedSources)
    expect(bundle.preparation).toEqual({
      jobId: "job-1", sourceDigest: expectedDigest,
      evidenceRefs: ["job:job-1", "persona:fact-1", "resume:resume-1"],
    })
    expect(bundle.transientSources).toEqual(expectedSources)
    expect(bundle.preparation).not.toHaveProperty("transientSources")
    expect(JSON.stringify(bundle.preparation)).not.toContain("Engineer with TypeScript experience")
    expect(JSON.stringify(bundle.preparation)).not.toContain("English C1")
    expect(fakePool.calls.find(call => call.sql.includes('FROM "Job"'))?.values).toEqual(["job-1", "user-1"])
    expect(fakePool.calls.find(call => call.sql.includes('FROM "Resume"'))?.values).toEqual(["user-1", null])
    const personaCalls = fakePool.calls.filter(call => call.sql.includes("FROM persona_facts"))
    expect(personaCalls).toHaveLength(1)
    expect(personaCalls[0]?.values).toEqual(["user-1", null, "cover_letter"])
    expect(personaCalls[0]?.sql).toContain(`"status" = 'confirmed'`)
    expect(personaCalls[0]?.sql).toContain(`"expires_at" IS NULL OR "expires_at" > NOW()`)
    expect(personaCalls[0]?.sql).toContain(`$3 = ANY("allowedUses")`)
  })

  it("keeps Persona evidence refs unique when facts share a source and hashes that source", async () => {
    const sharedSource = "resume:source-42"
    const facts: PersonaFactFixture[] = [
      { id: "fact-1", key: "language", category: "language", value: "English C1", source: "resume", sourceRef: sharedSource, confidence: 0.98, allowedUses: ["cover_letter"] },
      { id: "fact-2", key: "experience", category: "experience", value: "Built reliable systems", source: "resume", sourceRef: sharedSource, confidence: 0.91, allowedUses: ["cover_letter"] },
    ]
    const bundle = await loadSelectedJobArtifactContext(pool({ personaFacts: facts }) as never, "user-1", "job-1")
    const personaSources = bundle.transientSources.filter(source => source.sourceRef.startsWith("persona:"))

    expect(personaSources.map(source => source.sourceRef)).toEqual(["persona:fact-1", "persona:fact-2"])
    expect(personaSources.map(source => (source.content as { sourceRef: string }).sourceRef)).toEqual([sharedSource, sharedSource])
    expect(bundle.preparation.evidenceRefs).toEqual(["job:job-1", "persona:fact-1", "persona:fact-2", "resume:resume-1"])
    expect(bundle.preparation.sourceDigest).toBe(computeArtifactSourceDigest("job-1", bundle.transientSources))

    const changedFacts = facts.map(fact => ({ ...fact, sourceRef: "resume:source-43" }))
    const changed = await loadSelectedJobArtifactContext(pool({ personaFacts: changedFacts }) as never, "user-1", "job-1")
    expect(changed.preparation.sourceDigest).not.toBe(bundle.preparation.sourceDigest)
  })

  it("binds selected read identity and use case to server-loaded values", async () => {
    const bundle = await loadSelectedJobArtifactContext(pool() as never, "user-1", "job-1")

    expect(bundle.baseResumeId).toBe("resume-1")
    expect(bindSelectedJobReadInput("jobs.get", { jobId: "attacker-job" }, bundle)).toEqual({ jobId: "job-1" })
    expect(bindSelectedJobReadInput("resume.get_base", { resumeId: "attacker-resume" }, bundle)).toEqual({ resumeId: "resume-1" })
    expect(bindSelectedJobReadInput("persona.retrieve", {
      keys: ["language"], useCase: "form_fill", jobId: "attacker-job",
    }, bundle)).toEqual({ keys: ["language"], useCase: "cover_letter", jobId: "job-1" })
  })

  it.each([
    [{ job: false }, "selected_job_not_found"],
    [{ resume: false }, "selected_job_base_resume_missing"],
  ])("fails closed when a required server-owned source is absent", async (options, code) => {
    await expect(loadSelectedJobArtifactContext(pool(options as { job?: boolean; resume?: boolean }) as never, "user-1", "job-1"))
      .rejects.toThrow(code as string)
  })
})

describe("resolveCoverLetterBase", () => {
  it("reuses an immutable base or creates a content-free job-scoped base", async () => {
    const store = new InMemoryArtifactToolStore()
    const first = await resolveCoverLetterBase(store, "user-1", "job-1")
    const second = await resolveCoverLetterBase(store, "user-1", "job-1")
    expect(second).toEqual(first)
    expect(await store.listForUser("user-1", "job-1")).toEqual([expect.objectContaining({
      id: first.artifactId, lifecycle: "base", type: "cover_letter", content: { kind: "cover_letter_base", jobId: "job-1" },
    })])
    await expect(resolveCoverLetterBase(store, "user-2", "job-1")).resolves.not.toEqual(first)
  })
})
