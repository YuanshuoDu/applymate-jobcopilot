import { describe, expect, it } from "vitest"
import {
  OBJECTIVE_APPLICATION_RESUME_WITNESS_SCHEMA,
  buildObjectiveApplicationResumeWitness,
  parseObjectiveApplicationResumeWitness,
  sameObjectiveApplicationResumeWitness,
  type ObjectiveApplicationResumeMaterial,
} from "./agent-objective-application-resume-witness.js"

const material: ObjectiveApplicationResumeMaterial = {
  name: "Tailored resume",
  content: { basics: { name: "Candidate" }, experience: [{ company: "A" }] },
  templateId: "modern",
  templateOptions: { accentColor: "blue" },
  kind: "adapted",
  targetJobId: "job-1",
  parentResumeId: "base-1",
  basicsDetached: false,
}

function build(overrides: Partial<Parameters<typeof buildObjectiveApplicationResumeWitness>[0]> = {}) {
  return buildObjectiveApplicationResumeWitness({
    userId: "user-1",
    jobId: "job-1",
    resumeId: "resume-1",
    finalResumeAssignmentRevision: 0,
    materialRevision: 0,
    material,
    ...overrides,
  })
}

describe("objective application Resume witness", () => {
  it("hashes exactly the material fields protected by the database revision trigger", () => {
    const original = build()
    expect(original?.schema).toBe(OBJECTIVE_APPLICATION_RESUME_WITNESS_SCHEMA)
    expect(original?.resumeMaterialHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(original).not.toHaveProperty("content")

    const changes: Partial<ObjectiveApplicationResumeMaterial>[] = [
      { name: "Renamed" },
      { content: { basics: { name: "Changed" } } },
      { templateId: "classic" },
      { templateOptions: { accentColor: "green" } },
      { parentResumeId: "base-2" },
      { basicsDetached: true },
    ]
    for (const change of changes) {
      const changed = build({ material: { ...material, ...change } })
      expect(changed?.resumeMaterialHash).not.toBe(original?.resumeMaterialHash)
    }
  })

  it("requires monotonic revisions to distinguish an A-to-B-to-A material edit", () => {
    const first = build({ materialRevision: 0 })
    const changed = build({ materialRevision: 1, material: { ...material, content: { restored: false } } })
    const restored = build({ materialRevision: 2 })
    expect(restored?.resumeMaterialHash).toBe(first?.resumeMaterialHash)
    expect(sameObjectiveApplicationResumeWitness(first, restored)).toBe(false)
    expect(sameObjectiveApplicationResumeWitness(first, changed)).toBe(false)
  })

  it("binds Job assignment revision and exact owner, Job, and Resume identities", () => {
    const original = build()
    expect(sameObjectiveApplicationResumeWitness(original, build({ finalResumeAssignmentRevision: 1 }))).toBe(false)
    expect(sameObjectiveApplicationResumeWitness(original, build({ userId: "user-2" }))).toBe(false)
    expect(sameObjectiveApplicationResumeWitness(original, build({ jobId: "job-2" }))).toBe(false)
    expect(sameObjectiveApplicationResumeWitness(original, build({ resumeId: "resume-2" }))).toBe(false)
  })

  it("does not build an adapted Resume witness for another Job or an unadapted Resume", () => {
    expect(build({ material: { ...material, targetJobId: "job-2" } })).toBeNull()
    expect(build({ material: { ...material, kind: "base" } })).toBeNull()
  })

  it("parses only a closed, bounded witness with nonnegative safe revisions", () => {
    const valid = build()
    expect(parseObjectiveApplicationResumeWitness(valid)).toEqual(valid)
    expect(parseObjectiveApplicationResumeWitness({ ...valid, content: material.content })).toBeNull()
    expect(parseObjectiveApplicationResumeWitness({ ...valid, materialRevision: -1 })).toBeNull()
    expect(parseObjectiveApplicationResumeWitness({ ...valid, finalResumeAssignmentRevision: Number.MAX_SAFE_INTEGER + 1 })).toBeNull()
    expect(parseObjectiveApplicationResumeWitness({ ...valid, resumeMaterialHash: `sha256:${"A".repeat(64)}` })).toBeNull()
    expect(parseObjectiveApplicationResumeWitness({ ...valid, userId: " user-1 " })).toBeNull()
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    expect(() => parseObjectiveApplicationResumeWitness(revoked.proxy)).not.toThrow()
    expect(parseObjectiveApplicationResumeWitness(revoked.proxy)).toBeNull()
  })

  it("rejects accessor and non-JSON material without invoking getters", () => {
    let invoked = false
    const hostile = { ...material, content: Object.defineProperty({}, "secret", { enumerable: true, get() { invoked = true; return "x" } }) }
    expect(build({ material: hostile })).toBeNull()
    expect(invoked).toBe(false)
    expect(build({ material: { ...material, content: new Date() } })).toBeNull()
  })
})
