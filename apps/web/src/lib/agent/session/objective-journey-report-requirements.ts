import type { Prisma } from "@prisma/client"
import { readObjectiveJourneyRequirementReceipts } from "./objective-journey-report-requirement-receipts"
import { verifyObjectiveJourneyRequirementProof } from "./objective-journey-report-requirement-proof"
import type { ObjectiveJourneySource } from "./objective-journey-report-source"

export type ObjectiveJourneyRequirementCoverage = Readonly<{ status: "unavailable" } | {
  status: "complete" | "partial"; checkedReadyJobs: number; verifiedReadyJobs: number
}>

/** Counts only ready slots whose current Analyst, read receipts and Job material all revalidate. */
export async function readObjectiveJourneyRequirementCoverage(
  tx: Prisma.TransactionClient, source: ObjectiveJourneySource,
): Promise<ObjectiveJourneyRequirementCoverage | undefined> {
  const ready = source.slots.filter(slot => slot.tailoringStatus === "ready")
  if (ready.length === 0) return undefined
  if (ready.length > 8) return { status: "unavailable" }
  let checkedReadyJobs = 0, verifiedReadyJobs = 0
  for (const slot of ready) {
    if (!slot.sourceReady || !slot.requirementAnalyst || !slot.jobId) continue
    const receipts = await readObjectiveJourneyRequirementReceipts(tx, source, slot)
    if (!receipts) continue
    const proof = verifyObjectiveJourneyRequirementProof(source, slot, receipts)
    if (!proof.checked) continue
    checkedReadyJobs += 1
    if (proof.hasVerifiedRequirements) verifiedReadyJobs += 1
  }
  if (checkedReadyJobs === 0) return { status: "unavailable" }
  return { status: checkedReadyJobs === ready.length ? "complete" : "partial", checkedReadyJobs, verifiedReadyJobs }
}
