import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { readObjectiveJourneyRequirementReceipts } from "./objective-journey-report-requirement-receipts"
import { objectiveJourneyVerifiedRequirementRead } from "./objective-journey-report-requirement-proof"
import { readObjectiveJourneySource, type ObjectiveJourneySource } from "./objective-journey-report-source"
import { matchObjectiveJourneySkillLabels, normalizeObjectiveJourneySkillLabel, parseConfirmedPastedSkills } from "./objective-journey-skill-labels"
import { compareObjectiveJourneySkillRows, OBJECTIVE_JOURNEY_SKILL_MAX, OBJECTIVE_JOURNEY_SUGGESTED_TERMS_MAX,
  parseObjectiveJourneySkillComparison, type ObjectiveJourneySkillComparison } from "./objective-journey-skill-comparison-contract"

type Input = Readonly<{ userId: string; sessionId: string; finalItemId: string; graphRevision: number }>

/** Runs the explicit owner action in the same repeatable snapshot as the report source. */
export async function readObjectiveJourneySkillComparison(input: Input): Promise<ObjectiveJourneySkillComparison | undefined> {
  try {
    return await db.$transaction(async tx => {
      const source = await readObjectiveJourneySource(tx, input)
      if (!source || source.userId !== input.userId || source.sessionId !== input.sessionId
        || source.finalItemId !== input.finalItemId || source.graphRevision !== input.graphRevision) return undefined
      const personaSkills = await readConsentedPastedSkills(tx, source.userId)
      if (!personaSkills) return unavailable(source)
      const ready = source.slots.filter(slot => slot.tailoringStatus === "ready")
      if (!ready.length) return unavailable(source)
      const byLabel = new Map<string, { label: string; slotOrdinals: Set<number> }>()
      let checked = 0
      for (const slot of ready) {
        if (!slot.sourceReady || !slot.requirementAnalyst || !slot.jobId) continue
        const receipts = await readObjectiveJourneyRequirementReceipts(tx, source, slot)
        const verified = receipts && objectiveJourneyVerifiedRequirementRead(source, slot, receipts)
        if (!verified) continue
        checked++
        for (const item of matchObjectiveJourneySkillLabels(verified.keywords, verified.quotes)) {
          const key = item.normalizedLabel
          const current = byLabel.get(key) ?? { label: item.label, slotOrdinals: new Set<number>() }
          current.slotOrdinals.add(slot.ordinal)
          byLabel.set(key, current)
        }
      }
      const allSkills = [...byLabel.entries()].map(([key, item]) => ({ label: item.label,
        evidenceStatus: personaSkills.has(key) ? "confirmed_persona_match" as const : "needs_confirmation" as const,
        slotOrdinals: [...item.slotOrdinals].sort((left, right) => left - right) }))
        .sort(compareObjectiveJourneySkillRows)
      const skills = allSkills.slice(0, OBJECTIVE_JOURNEY_SKILL_MAX)
      const suggestedTerms = skills.filter(skill => skill.evidenceStatus === "confirmed_persona_match")
        .slice(0, OBJECTIVE_JOURNEY_SUGGESTED_TERMS_MAX).map(skill => skill.label)
      const coverage = allSkills.length > skills.length || checked > 0 && checked < ready.length ? "partial" as const
        : checked === ready.length ? "complete" as const : "unavailable" as const
      return parseObjectiveJourneySkillComparison({ schemaVersion: "agent-harness.v2.objective-skill-comparison.v1",
        finalItemId: source.finalItemId, graphRevision: source.graphRevision, coverage, skills, suggestedTerms })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
  } catch { return undefined }
}

async function readConsentedPastedSkills(tx: Prisma.TransactionClient, userId: string): Promise<ReadonlySet<string> | undefined> {
  const rows = await tx.personaFact.findMany({ where: { userId, key: "pasted_skills", category: "work", status: "confirmed",
    revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }], allowedUses: { has: "discovery" } }, take: 2,
    select: { value: true, normalizedValue: true } })
  if (rows.length !== 1) return undefined
  const labels = parseConfirmedPastedSkills(rows[0]!.value, rows[0]!.normalizedValue)
  return labels ? new Set(labels.map(normalizeObjectiveJourneySkillLabel)) : undefined
}

function unavailable(source: ObjectiveJourneySource): ObjectiveJourneySkillComparison {
  return { schemaVersion: "agent-harness.v2.objective-skill-comparison.v1", finalItemId: source.finalItemId,
    graphRevision: source.graphRevision, coverage: "unavailable", skills: [], suggestedTerms: [] }
}
