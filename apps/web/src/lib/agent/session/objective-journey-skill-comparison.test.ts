import { beforeEach, describe, expect, it, vi } from "vitest"
import { readObjectiveJourneySkillComparison } from "./objective-journey-skill-comparison"
import type { ObjectiveJourneySource } from "./objective-journey-report-source"

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), source: vi.fn(), receipts: vi.fn(), verified: vi.fn() }))
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }))
vi.mock("./objective-journey-report-source", () => ({ readObjectiveJourneySource: mocks.source }))
vi.mock("./objective-journey-report-requirement-receipts", () => ({ readObjectiveJourneyRequirementReceipts: mocks.receipts }))
vi.mock("./objective-journey-report-requirement-proof", () => ({ objectiveJourneyVerifiedRequirementRead: mocks.verified }))

const input = { userId: "owner-1", sessionId: "session-1", finalItemId: "final-1", graphRevision: 9 }
const tx = { personaFact: { findMany: vi.fn() } }

describe("readObjectiveJourneySkillComparison", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.transaction.mockImplementation(async (work: (client: typeof tx) => Promise<unknown>) => work(tx))
    mocks.source.mockResolvedValue(sourceFixture())
    mocks.receipts.mockResolvedValue({})
    mocks.verified.mockImplementation((_source: unknown, slot: { ordinal: number }) => ({ checked: true,
      keywords: slot.ordinal === 3 ? "TypeScript, Rust, Python" : "TypeScript, Rust", quotes: slot.ordinal === 3 ? ["TypeScript only."] : ["Use TypeScript and Rust."] }))
    tx.personaFact.findMany.mockResolvedValue([{ value: "TypeScript", normalizedValue: "typescript" }])
  })

  it("uses exact verified citations, compares only consented current Skills, and ranks deterministic suggestions", async () => {
    const result = await readObjectiveJourneySkillComparison(input)
    expect(result).toEqual({ schemaVersion: "agent-harness.v2.objective-skill-comparison.v1", finalItemId: "final-1", graphRevision: 9,
      coverage: "complete", skills: [
        { label: "TypeScript", evidenceStatus: "confirmed_persona_match", slotOrdinals: [1, 2, 3] },
        { label: "Rust", evidenceStatus: "needs_confirmation", slotOrdinals: [1, 2] },
      ], suggestedTerms: ["TypeScript"] })
    expect(JSON.stringify(result)).not.toContain("Use TypeScript and Rust.")
    expect(JSON.stringify(result)).not.toContain("persona-fact")
    expect(JSON.stringify(result)).not.toContain("Python")
    expect(tx.personaFact.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: "owner-1",
      key: "pasted_skills", category: "work", status: "confirmed", revokedAt: null, allowedUses: { has: "discovery" } }) }))
  })

  it("returns unavailable without a current discovery-consented pasted Skills fact", async () => {
    tx.personaFact.findMany.mockResolvedValueOnce([])
    await expect(readObjectiveJourneySkillComparison(input)).resolves.toMatchObject({ coverage: "unavailable", skills: [], suggestedTerms: [] })
    tx.personaFact.findMany.mockResolvedValueOnce([{ value: "TypeScript", normalizedValue: "typescript" }])
    mocks.source.mockResolvedValueOnce({ ...sourceFixture(), graphRevision: 10 })
    await expect(readObjectiveJourneySkillComparison(input)).resolves.toBeUndefined()
  })

  it("does not turn an owner or source identity mismatch into a comparison", async () => {
    mocks.source.mockResolvedValueOnce(undefined)
    await expect(readObjectiveJourneySkillComparison(input)).resolves.toBeUndefined()
  })

  it("rejects a foreign source before reading Persona consent", async () => {
    mocks.source.mockResolvedValueOnce({ ...sourceFixture(), userId: "foreign-owner" })
    await expect(readObjectiveJourneySkillComparison(input)).resolves.toBeUndefined()
    expect(tx.personaFact.findMany).not.toHaveBeenCalled()
  })

  it("counts only checked ready slots and keeps a stale proof from becoming a label", async () => {
    mocks.verified.mockImplementationOnce(() => undefined).mockImplementationOnce(() => ({ checked: true, keywords: "Rust", quotes: ["Rust required."] }))
      .mockImplementationOnce(() => ({ checked: true, keywords: "TypeScript", quotes: ["TypeScript required."] }))
    await expect(readObjectiveJourneySkillComparison(input)).resolves.toMatchObject({ coverage: "partial",
      skills: [{ label: "TypeScript", evidenceStatus: "confirmed_persona_match", slotOrdinals: [3] }, { label: "Rust", evidenceStatus: "needs_confirmation", slotOrdinals: [2] }] })
  })

  it("fails closed for malformed confirmed Skills instead of treating them as absence", async () => {
    tx.personaFact.findMany.mockResolvedValueOnce([{ value: "TypeScript, typescript", normalizedValue: "typescript, typescript" }])
    await expect(readObjectiveJourneySkillComparison(input)).resolves.toMatchObject({ coverage: "unavailable", skills: [], suggestedTerms: [] })
  })

  it("caps deterministic output and reports truncation as partial", async () => {
    const labels = Array.from({ length: 33 }, (_, index) => `Skill${String(index + 1).padStart(2, "0")}`)
    tx.personaFact.findMany.mockResolvedValueOnce([{ value: labels[0], normalizedValue: labels[0]!.toLowerCase() }])
    mocks.verified.mockImplementation(() => ({ checked: true, keywords: labels.join(", "), quotes: [labels.join(", ")] }))
    const result = await readObjectiveJourneySkillComparison(input)
    expect(result?.coverage).toBe("partial")
    expect(result?.skills).toHaveLength(32)
    expect(result?.skills[0]).toEqual({ label: "Skill01", evidenceStatus: "confirmed_persona_match", slotOrdinals: [1, 2, 3] })
    expect(result?.skills.at(-1)?.label).toBe("Skill32")
    expect(result?.suggestedTerms).toEqual(["Skill01"])
  })
})

function sourceFixture(): ObjectiveJourneySource {
  const slots = [1, 2, 3].map(ordinal => ({ ordinal, tailoringStatus: "ready" as const, sourceReady: true, jobId: `job-${ordinal}`,
    job: { company: "Example", role: "Engineer" }, writerTaskId: `writer-${ordinal}`, reviewerTaskId: `reviewer-${ordinal}`,
    requirementAnalyst: { nodeKey: `analyst-${ordinal}`, taskId: `task-${ordinal}`, attemptCount: 2, proofDigest: "a".repeat(64),
      jobMaterialDigest: `sha256:${"b".repeat(64)}`, criteriaIds: ["finding-count"], dependencyNodeKeys: ["scout"],
      dependencies: [{ nodeKey: "scout", taskId: `scout-${ordinal}` }] } }))
  return { ...input, sourceTurnId: "source-turn", rootTaskId: "source-root", sourceCounts: {
    discoveredJobs: { knownCount: 3, coverage: "complete" as const }, analyzedJobs: { knownCount: 3, coverage: "complete" as const },
  }, slots }
}
