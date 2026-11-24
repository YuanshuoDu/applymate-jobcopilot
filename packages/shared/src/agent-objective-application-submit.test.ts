import { describe, expect, it, vi } from "vitest"

import {
  LEGACY_APPLICATION_SUBMISSION_MANIFEST_SCHEMA,
  buildApplicationSubmissionManifest,
  hashApplicationSubmissionMaterial,
  isApplicationSubmissionManifest,
} from "./application-submission-material.js"
import {
  OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_SCHEMA,
  OBJECTIVE_APPLICATION_SUBMISSION_MATERIAL_SCHEMA,
  buildObjectiveApplicationSubmissionManifest,
  hashObjectiveApplicationSubmissionMaterial,
  OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_ACTOR,
  OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_BODY,
  OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_SCHEMA,
  OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_TYPE,
  parseObjectiveApplicationSubmissionManifestEvent,
  parseObjectiveApplicationSubmissionManifest,
  parseObjectiveApplicationSubmissionMaterial,
} from "./agent-objective-application-submit.js"

const hash = (value: string) => value.repeat(64)
const source = (materialProofHash = hash("a")) => ({
  schemaVersion: "agent-harness.v2.objective-reviewed-fill-source.v1",
  approvalId: `objective-review:objective-review-${"b".repeat(40)}:1`,
  reviewTurnId: "review-turn-1",
  materialProofHash,
})
const material = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: OBJECTIVE_APPLICATION_SUBMISSION_MATERIAL_SCHEMA,
  applicationTaskId: "application-task-1", jobId: "job-1", resumeId: "resume-1", coverLetterId: null,
  reviewedCoverLetterHash: hash("c"), objectiveSource: source(), ...overrides,
})
const manifestEvent = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_SCHEMA,
  scope: { userId: "user-1", sessionId: "session-1", applicationTaskId: "application-1", jobId: "job-1", fillTurnId: "fill-turn-1" },
  manifest: buildObjectiveApplicationSubmissionManifest(material(), hash("d")), hash: `sha256:${hash("e")}`, ...overrides,
})

describe("Objective application submission material", () => {
  it("parses the exact persisted V3 event envelope without claiming its database authority", () => {
    const value = manifestEvent()
    const parsed = parseObjectiveApplicationSubmissionManifestEvent(value)
    expect(parsed).toEqual(value)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed?.scope)).toBe(true)
    expect(OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_TYPE).toBe("objective_submission_manifest_recorded")
    expect(OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_ACTOR).toBe("worker")
    expect(OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_BODY).toBe("Objective submission manifest recorded for this fill attempt.")
  })

  it.each([
    ["extra envelope field", manifestEvent({ extra: true })],
    ["wrong envelope schema", manifestEvent({ schemaVersion: "agent-harness.v2.wrong.v1" })],
    ["extra scope field", manifestEvent({ scope: { userId: "user-1", sessionId: "session-1", applicationTaskId: "application-1",
      jobId: "job-1", fillTurnId: "fill-turn-1", extra: true } })],
    ["invalid owner identity", manifestEvent({ scope: { userId: "not an id", sessionId: "session-1", applicationTaskId: "application-1",
      jobId: "job-1", fillTurnId: "fill-turn-1" } })],
    ["unprefixed hash", manifestEvent({ hash: hash("e") })],
    ["malformed manifest", manifestEvent({ manifest: { schemaVersion: OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_SCHEMA } })],
  ])("rejects %s", (_name, value) => {
    expect(parseObjectiveApplicationSubmissionManifestEvent(value)).toBeNull()
  })

  it("rejects event envelope accessors without invoking them", () => {
    const value = manifestEvent()
    const getter = vi.fn(() => "other-user")
    Object.defineProperty(value.scope, "userId", { enumerable: true, get: getter })
    expect(parseObjectiveApplicationSubmissionManifestEvent(value)).toBeNull()
    expect(getter).not.toHaveBeenCalled()
  })

  it("parses a closed Objective proof and builds a distinct V3 manifest", () => {
    const parsed = parseObjectiveApplicationSubmissionMaterial(material())
    expect(parsed).toMatchObject({ applicationTaskId: "application-task-1", resumeId: "resume-1", objectiveSource: source() })
    const manifest = buildObjectiveApplicationSubmissionManifest(parsed, hash("d"))
    expect(manifest).toEqual({ schemaVersion: OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_SCHEMA, material: parsed, answersHash: hash("d") })
    expect(parseObjectiveApplicationSubmissionManifest(manifest)).toEqual(manifest)
  })

  it.each([
    ["missing Resume", { resumeId: null }],
    ["extra field", { untrusted: true }],
    ["wrong material schema", { schemaVersion: "agent-harness.application-submission.v2" }],
    ["invalid Objective source", { objectiveSource: { ...source(), untrusted: true } }],
    ["invalid proof hash", { objectiveSource: source("not-a-proof-hash") }],
    ["invalid reviewed letter digest", { reviewedCoverLetterHash: "sha256:" + hash("c") }],
  ])("rejects %s", (_name, override) => {
    expect(parseObjectiveApplicationSubmissionMaterial(material(override))).toBeNull()
  })

  it("rejects accessors without invoking them", () => {
    const input = material()
    const getter = vi.fn(() => "resume-2")
    Object.defineProperty(input, "resumeId", { enumerable: true, get: getter })
    expect(parseObjectiveApplicationSubmissionMaterial(input)).toBeNull()
    expect(getter).not.toHaveBeenCalled()
  })

  it("changes the material digest when the approved proof, Resume, or reviewed artifact changes", async () => {
    const initial = await hashObjectiveApplicationSubmissionMaterial(material())
    expect(initial).toMatch(/^[a-f0-9]{64}$/)
    expect(await hashObjectiveApplicationSubmissionMaterial(material({ resumeId: "resume-2" }))).not.toBe(initial)
    expect(await hashObjectiveApplicationSubmissionMaterial(material({ objectiveSource: source(hash("e")) }))).not.toBe(initial)
    expect(await hashObjectiveApplicationSubmissionMaterial(material({ reviewedCoverLetterHash: hash("f") }))).not.toBe(initial)
  })

  it("keeps Objective V3 separate from existing selected-job V1/V2 parsing", async () => {
    const objectiveManifest = buildObjectiveApplicationSubmissionManifest(material(), hash("d"))
    const selectedV2 = buildApplicationSubmissionManifest({ applicationTaskId: "task-1", jobId: "job-1", resumeId: null,
      coverLetterId: null, reviewedCoverLetterHash: hash("c") }, hash("d"))
    expect(selectedV2?.schemaVersion).toBe("agent-harness.application-submission.v2")
    expect(isApplicationSubmissionManifest(selectedV2)).toBe(true)
    expect(isApplicationSubmissionManifest(objectiveManifest)).toBe(false)
    expect(parseObjectiveApplicationSubmissionManifest(selectedV2)).toBeNull()
    await expect(hashApplicationSubmissionMaterial(material())).resolves.toBeNull()
    expect(LEGACY_APPLICATION_SUBMISSION_MANIFEST_SCHEMA).toBe("agent-harness.application-submission.v1")
  })

  it("requires exact V3 manifest fields and a valid answers digest", () => {
    const valid = buildObjectiveApplicationSubmissionManifest(material(), hash("d"))!
    expect(parseObjectiveApplicationSubmissionManifest({ ...valid, extra: true })).toBeNull()
    expect(buildObjectiveApplicationSubmissionManifest(material(), "invalid")).toBeNull()
    expect(parseObjectiveApplicationSubmissionManifest({ ...valid, answersHash: "invalid" })).toBeNull()
  })
})
