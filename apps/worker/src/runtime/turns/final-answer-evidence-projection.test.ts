import { describe, expect, it } from "vitest"
import { projectFinalAnswerEvidenceSources } from "./final-answer-evidence-projection.js"

function job(id: string, company: string, role = "Software Engineer") {
  return { id, company, role, location: "Dublin, Ireland", status: "saved", score: 8, url: "https://private.example/jobs/1",
    source: "internal-feed", salary: "private salary", description: "private description with contact details", keywords: "secret keywords" }
}

function fact(id: string, key: string, category: string, value: string) {
  return { id, key, category, value, source: "manual", sourceRef: `persona:${id}`, confidence: 1, allowedUses: ["tailor"] }
}

describe("final answer evidence projection", () => {
  it("uses only bounded job display fields and never emits source IDs or locator fields", () => {
    const output = { jobs: [job("job-public-1", "Acme Inc."), job("job-public-2", "example.xyz"), job("job-public-3", "https://private.example")], page: 1, hasMore: false }
    const projected = projectFinalAnswerEvidenceSources("jobs.search", output)
    expect(projected).toEqual([{
      sourceRef: "jobs/0", sourceId: "job-public-1", kind: "job", label: "Job listing",
      excerpt: "Role: Software Engineer · Company: Acme Inc. · Location: Dublin, Ireland",
    }])
    const display = JSON.stringify(projected.map(({ label, excerpt }) => ({ label, excerpt })))
    for (const privateValue of ["job-public-1", "https://private.example/jobs/1", "internal-feed", "private salary", "private description", "secret keywords"])
      expect(display).not.toContain(privateValue)
  })

  it("fails closed for CUID, UUID, opaque tokens, URLs, bare domains, and IDs embedded in allowed text", () => {
    const cuid = `c${"a".repeat(24)}`
    const uuid = "123e4567-e89b-42d3-a456-426614174000"
    const output = { jobs: [
      job("job-1", cuid), job("job-2", uuid), job("job-3", "a23456789012345678901"),
      job("job-4", "company.xyz"), job("job-private-42", "safe-name job-private-42"),
    ], page: 1, hasMore: false }
    expect(projectFinalAnswerEvidenceSources("jobs.search", output)).toEqual([])
  })

  it("suppresses whole contact facts while retaining only approved professional preference keys", () => {
    const output = { facts: [
      fact("fact-email", "email", "contact", "steven@example.com"),
      fact("fact-phone", "phone_number", "personal", "+353 87 123 4567"),
      fact("fact-name", "firstName", "personal", "Steven"),
      fact("fact-role", "target_role", "career", "Applied AI Engineer"),
      fact("fact-freeform", "custom_note", "preferences", "Use my private details"),
    ] }
    const projected = projectFinalAnswerEvidenceSources("persona.retrieve", output)
    expect(projected).toEqual([{
      sourceRef: "facts/3", sourceId: "fact-role", kind: "persona", label: "Target role",
      excerpt: "Target role: Applied AI Engineer",
    }])
    expect(JSON.stringify(projected.map(({ label, excerpt }) => ({ label, excerpt })))).not.toMatch(/steven|example\.com|353|fact-role|fact-email|fact-phone|fact-name/i)
  })

  it("omits an unsafe approved fact instead of trying to redact or trim it", () => {
    const output = { facts: [fact("fact-role", "target_role", "career", "Engineer at contact me@example.xyz")] }
    expect(projectFinalAnswerEvidenceSources("persona.retrieve", output)).toEqual([])
  })

  it("projects only the resume skills and experience role/company allowlist", () => {
    const output = { resume: { id: "resume-private-1", name: "Ada Lovelace", kind: "base", origin: "upload", isDefault: true,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
      content: { summary: "private summary", email: "ada@example.com", skills: ["TypeScript", "React", "private@example.com"],
        experience: [{ role: "Engineer", company: "Acme", bullets: ["private bullet"] }] } } }
    const projected = projectFinalAnswerEvidenceSources("resume.get_base", output)
    expect(projected).toEqual([{
      sourceRef: "resume", sourceId: "resume-private-1", kind: "resume", label: "Base resume",
      excerpt: "Skills: TypeScript, React · Experience: Engineer at Acme",
    }])
    expect(JSON.stringify(projected.map(({ label, excerpt }) => ({ label, excerpt })))).not.toMatch(/Ada Lovelace|ada@example\.com|private summary|private bullet|resume-private-1/i)
  })

  it("rejects extra source fields and malformed record shapes", () => {
    const extra = { ...job("job-1", "Acme"), ownerId: "owner-private" }
    expect(projectFinalAnswerEvidenceSources("jobs.get", { job: extra })).toEqual([])
    expect(projectFinalAnswerEvidenceSources("jobs.search", { jobs: [null], page: 1, hasMore: false })).toEqual([])
  })
})
