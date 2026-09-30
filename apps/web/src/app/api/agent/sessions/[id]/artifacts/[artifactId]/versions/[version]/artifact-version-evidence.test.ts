import { describe, expect, it } from "vitest"

import {
  boundedRefs,
  isContactKey,
  MAX_SOURCE_EVIDENCE_ITEM_CHARS,
  projectSourceEvidence,
  resumeEvidenceText,
  safeEvidencePreview,
  type SelectedSourceSnapshot,
  type SourceEvidenceItem,
} from "./artifact-version-evidence"

function snapshot(digest: string, entries: Array<[string, SourceEvidenceItem]>): SelectedSourceSnapshot {
  return { digest, byRef: new Map(entries) }
}

function evidenceArtifact(overrides: Record<string, unknown> = {}) {
  return {
    sourceDigest: "digest-current",
    evidenceRefs: ["job:1", "persona:1"],
    provenanceRefs: ["job:1", "resume:1"],
    ...overrides,
  }
}

describe("immutable artifact source evidence projection", () => {
  it("bounds and filters refs before projection", () => {
    expect(boundedRefs(["job:1", " padded ", "x".repeat(257), 3, "resume:1"])).toEqual(["job:1", "resume:1"])
    expect(boundedRefs(Array.from({ length: 40 }, (_, index) => "ref:" + index))).toHaveLength(32)
    expect(boundedRefs("job:1")).toEqual([])
  })

  it("projects deduplicated current evidence with bounded, redacted text", () => {
    const result = projectSourceEvidence(evidenceArtifact(), snapshot("digest-current", [
      ["job:1", { kind: "job", label: "Job description", text: "<p>Build safe APIs &amp; workflows</p> at private@example.test +353 86 123 4567" }],
      ["resume:1", { kind: "resume", label: "Base resume", text: "Designed reliable systems" }],
      ["persona:1", { kind: "persona", label: "Profile fact", text: "Led secure migrations" }],
    ]), true)

    expect(result.freshness).toBe("current")
    expect(result.items.map(item => item.reference)).toEqual(["job:1", "persona:1", "resume:1"])
    expect(result.items[0].text).toContain("Build safe APIs & workflows")
    expect(result.items[0].text).not.toContain("private@example.test")
    expect(result.items[0].text).not.toContain("+353 86 123 4567")
    expect(result.items[0].text).toContain("[redacted email]")
    expect(result.items[0].text).toContain("[redacted phone]")
  })

  it("never returns evidence text for a non-current version", () => {
    const result = projectSourceEvidence(evidenceArtifact(), snapshot("digest-current", [
      ["job:1", { kind: "job", label: "Job", text: "SECRET_SOURCE_TEXT" }],
      ["resume:1", { kind: "resume", label: "Resume", text: "SECRET_RESUME_TEXT" }],
      ["persona:1", { kind: "persona", label: "Fact", text: "SECRET_FACT_TEXT" }],
    ]), false)

    expect(result).toEqual({ freshness: "stale", items: [] })
    expect(JSON.stringify(result)).not.toContain("SECRET_")
  })

  it("returns stale without text when the selected-job source digest changed", () => {
    const result = projectSourceEvidence(evidenceArtifact(), snapshot("digest-new", [
      ["job:1", { kind: "job", label: "Job", text: "SECRET_SOURCE_TEXT" }],
      ["resume:1", { kind: "resume", label: "Resume", text: "Resume text" }],
      ["persona:1", { kind: "persona", label: "Fact", text: "Fact text" }],
    ]), true)

    expect(result).toEqual({ freshness: "stale", items: [] })
    expect(JSON.stringify(result)).not.toContain("SECRET_")
  })

  it("returns unavailable without partial text when sources or refs are missing", () => {
    const unavailableSnapshot = projectSourceEvidence(evidenceArtifact(), null, true)
    const missingRef = projectSourceEvidence(evidenceArtifact(), snapshot("digest-current", [
      ["job:1", { kind: "job", label: "Job", text: "Would be partial" }],
    ]), true)
    const emptyRefs = projectSourceEvidence(evidenceArtifact({ evidenceRefs: [], provenanceRefs: [] }), snapshot("digest-current", []), true)

    expect(unavailableSnapshot).toEqual({ freshness: "unavailable", items: [] })
    expect(missingRef).toEqual({ freshness: "unavailable", items: [] })
    expect(emptyRefs).toEqual({ freshness: "unavailable", items: [] })
  })

  it("caps evidence item count and total projected text", () => {
    const shortRefs = Array.from({ length: 9 }, (_, index) => "short:" + index)
    const shortSnapshot = snapshot("digest-current", shortRefs.map((reference): [string, SourceEvidenceItem] => [
      reference,
      { kind: "job", label: "L".repeat(100), text: "x".repeat(100) },
    ]))
    const itemLimited = projectSourceEvidence({
      sourceDigest: "digest-current", evidenceRefs: shortRefs, provenanceRefs: [],
    }, shortSnapshot, true)
    expect(itemLimited.items).toHaveLength(8)
    expect(itemLimited.items.every(item => item.label.length <= 80 && item.text.length <= MAX_SOURCE_EVIDENCE_ITEM_CHARS)).toBe(true)

    const longSnapshot = snapshot("digest-current", shortRefs.slice(0, 8).map((reference): [string, SourceEvidenceItem] => [
      reference,
      { kind: "job", label: "Job", text: "y".repeat(700) },
    ]))
    const charLimited = projectSourceEvidence({
      sourceDigest: "digest-current", evidenceRefs: shortRefs.slice(0, 8), provenanceRefs: [],
    }, longSnapshot, true)
    expect(charLimited.items.reduce((total, item) => total + item.text.length, 0)).toBeLessThanOrEqual(3_000)
    expect(charLimited.items.every(item => item.text.length <= MAX_SOURCE_EVIDENCE_ITEM_CHARS)).toBe(true)
  })

  it("sanitizes bounded previews and selects only short resume evidence", () => {
    expect(safeEvidencePreview("  <b>abcdef</b>  ", 5)).toBe("abcd…")
    expect(safeEvidencePreview("abcdef", 0)).toBe("")
    expect(isContactKey("phoneNumber")).toBe(true)
    expect(isContactKey("primaryEmail")).toBe(true)
    expect(isContactKey("location")).toBe(false)

    const resumeText = resumeEvidenceText({
      summary: "Built products with private@example.test",
      skills: ["TypeScript", "SQL", "Python", "AWS", "Hidden fifth skill"],
      experience: [{ role: "Engineer", company: "Example", bullets: ["Shipped a service", "Improved reliability", "Hidden third bullet"] }],
    })
    expect(resumeText).toContain("[redacted email]")
    expect(resumeText).toContain("AWS")
    expect(resumeText).not.toContain("Hidden fifth skill")
    expect(resumeText).not.toContain("Hidden third bullet")
    expect(resumeText.length).toBeLessThanOrEqual(MAX_SOURCE_EVIDENCE_ITEM_CHARS)
  })
})
