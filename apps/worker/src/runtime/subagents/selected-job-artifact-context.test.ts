import { describe, expect, it, vi } from "vitest"

import { computeArtifactSourceDigest, InMemoryArtifactToolStore } from "../tools/artifact-tools.js"
import { bindSelectedJobReadInput, loadSelectedJobArtifactContext, readSelectedJobSourceDigestWithClient } from "./selected-job-artifact-context.js"
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

function pool(options: { job?: boolean; resume?: boolean; resumeName?: string; personaFacts?: PersonaFactFixture[]; busyUser?: boolean } = {}) {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values })
      if (sql.includes("FOR UPDATE NOWAIT")) {
        if (options.busyUser) throw Object.assign(new Error("could not obtain lock on row"), { code: "55P03" })
        return { rows: [{ id: "user-1" }] }
      }
      if (sql.includes("FOR SHARE NOWAIT")) {
        if (sql.includes('FROM "Job"')) return { rows: options.job === false ? [] : [{ id: "job-1" }] }
        if (sql.includes('FROM "Resume"')) return { rows: options.resume === false ? [] : [{ id: "resume-1" }] }
        if (sql.includes("FROM persona_facts")) return { rows: options.personaFacts ?? [{ id: "fact-1" }] }
      }
      if (sql.includes('FROM "Job"')) return { rows: options.job === false ? [] : [{
        id: "job-1", company: "Example GmbH", role: "Engineer", location: "Berlin", status: "open", score: 8,
        url: "https://jobs.example/1", source: "greenhouse", salary: "EUR 80k", description: "Build systems", keywords: "TypeScript",
        createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-02T00:00:00Z"),
      }] }
      if (sql.includes('FROM "Resume"')) return { rows: options.resume === false ? [] : [{
        id: "resume-1", name: options.resumeName ?? "Base", kind: "base", origin: "manual", isDefault: true, content: { text: "Engineer with TypeScript experience" },
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
  it("returns only a source digest when reading selected-job evidence through a caller-owned client", async () => {
    const client = pool()

    const digest = await readSelectedJobSourceDigestWithClient(client as never, "user-1", "job-1")

    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(JSON.stringify(digest)).not.toContain("Engineer with TypeScript experience")
    expect(client.calls.slice(0, 4).map(call => call.sql.includes('FROM "User"') ? "User"
      : call.sql.includes('FROM "Job"') ? "Job" : call.sql.includes('FROM "Resume"') ? "Resume" : "persona_facts")).toEqual([
      "User", "Job", "Resume", "persona_facts",
    ])
    expect(client.calls[0]?.sql).toContain("FOR UPDATE NOWAIT")
    expect(client.calls[0]?.values).toEqual(["user-1"])
    expect(client.calls.slice(1, 4).every(call => call.sql.includes("FOR SHARE NOWAIT"))).toBe(true)
    expect(client.calls[1]?.values).toEqual(["job-1", "user-1"])
    expect(client.calls[2]?.values).toEqual(["user-1"])
    expect(client.calls[2]?.sql).toContain(`AND "kind" = 'base'`)
    expect(client.calls[3]?.values).toEqual(["user-1"])
    expect(client.calls).toHaveLength(7)
  })

  it("fails closed when a concurrent child insert holds the User parent lock", async () => {
    const client = pool({ busyUser: true })

    await expect(readSelectedJobSourceDigestWithClient(client as never, "user-1", "job-1")).resolves.toBeNull()
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0]?.sql).toContain('FROM "User"')
    expect(client.calls[0]?.sql).toContain("FOR UPDATE NOWAIT")
  })

  it("loads only owner-scoped job, base resume and cover-letter-approved persona evidence", async () => {
    const fakePool = pool()
    const bundle = await loadSelectedJobArtifactContext(fakePool as never, "user-1", "job-1")
    const expectedDigestSources = [
      { sourceRef: "job:job-1", content: {
        id: "job-1", company: "Example GmbH", role: "Engineer", location: "Berlin", status: "open", score: 8,
        url: "https://jobs.example/1", source: "greenhouse", salary: "EUR 80k", description: "Build systems", keywords: "TypeScript",
      } },
      { sourceRef: "resume:resume-1", content: {
        id: "resume-1", name: "Base", kind: "base", origin: "manual", isDefault: true,
        content: { text: "Engineer with TypeScript experience" },
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
      } },
      { sourceRef: "persona:fact-1", content: {
        id: "fact-1", key: "language", category: "language", value: "English C1", source: "resume",
        sourceRef: "resume:language", confidence: 0.98, allowedUses: ["cover_letter"], rank: 1,
      } },
    ]
    const expectedTransientSources = [
      expectedDigestSources[0],
      { sourceRef: "resume:resume-1", content: { text: "Engineer with TypeScript experience" } },
      { sourceRef: "persona:fact-1", content: { id: "fact-1", key: "language", value: "English C1", confidence: 0.98, sourceRef: "resume:language" } },
    ]
    const expectedDigest = computeArtifactSourceDigest("job-1", expectedDigestSources)
    expect(bundle.preparation).toEqual({
      jobId: "job-1", sourceDigest: expectedDigest,
      evidenceRefs: ["job:job-1", "persona:fact-1", "resume:resume-1"],
    })
    expect(bundle.transientSources).toEqual(expectedTransientSources)
    expect(bundle.preparation).not.toHaveProperty("transientSources")
    expect(JSON.stringify(bundle.preparation)).not.toContain("Engineer with TypeScript experience")
    expect(JSON.stringify(bundle.preparation)).not.toContain("English C1")
    expect(fakePool.calls.find(call => call.sql.includes('FROM "Job"'))?.values).toEqual(["job-1", "user-1"])
    expect(fakePool.calls.find(call => call.sql.includes('FROM "Resume"'))?.values).toEqual(["user-1", null])
    const personaCalls = fakePool.calls.filter(call => call.sql.includes("FROM persona_facts"))
    expect(personaCalls).toHaveLength(1)
    expect(personaCalls[0]?.values).toEqual(["user-1", null, "cover_letter"])
    expect(personaCalls[0]?.sql).toContain(`"status" = 'confirmed'`)
    expect(personaCalls[0]?.sql).toContain(`"expires_at" IS NULL OR "expires_at" > statement_timestamp()`)
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

    const changedFacts = facts.map(fact => ({ ...fact, sourceRef: "resume:source-43" }))
    const changed = await loadSelectedJobArtifactContext(pool({ personaFacts: changedFacts }) as never, "user-1", "job-1")
    expect(changed.preparation.sourceDigest).not.toBe(bundle.preparation.sourceDigest)

    const reordered = await loadSelectedJobArtifactContext(pool({ personaFacts: [...facts].reverse() }) as never, "user-1", "job-1")
    expect(reordered.preparation.sourceDigest).not.toBe(bundle.preparation.sourceDigest)

    for (const firstFact of [
      { ...facts[0]!, category: "eligibility" },
      { ...facts[0]!, source: "manual" },
      { ...facts[0]!, allowedUses: ["cover_letter", "form_fill"] },
    ]) {
      const changedMetadata = await loadSelectedJobArtifactContext(pool({ personaFacts: [firstFact, facts[1]!] }) as never, "user-1", "job-1")
      expect(changedMetadata.preparation.sourceDigest).not.toBe(bundle.preparation.sourceDigest)
    }
  })

  it("includes all model-visible base resume metadata in the source digest", async () => {
    const baseline = await loadSelectedJobArtifactContext(pool() as never, "user-1", "job-1")
    const renamed = await loadSelectedJobArtifactContext(pool({ resumeName: "Updated Base" }) as never, "user-1", "job-1")

    expect(renamed.preparation.sourceDigest).not.toBe(baseline.preparation.sourceDigest)
    expect(renamed.transientSources).toEqual(baseline.transientSources)
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
