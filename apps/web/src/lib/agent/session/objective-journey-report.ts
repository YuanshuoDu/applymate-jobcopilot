import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { readObjectiveJourneyReportApplication } from "./objective-journey-report-application"
import { readObjectiveJourneyReportApprovals } from "./objective-journey-report-approvals"
import { parseObjectiveJourneyReport, OBJECTIVE_JOURNEY_REPORT_SCHEMA, OBJECTIVE_JOURNEY_REPORT_SCHEMA_V2,
  type ObjectiveJourneyReport } from "./objective-journey-report-contract"
import { readObjectiveJourneySource } from "./objective-journey-report-source"

type Input = Readonly<{ userId: string; sessionId: string; finalItemId: string }>

/** Composes the read-only report from one owner-scoped, repeatable snapshot. */
export async function readObjectiveJourneyReport(input: Input): Promise<ObjectiveJourneyReport | undefined> {
  try {
    return await db.$transaction(async tx => {
      const source = await readObjectiveJourneySource(tx, input)
      if (!source) return undefined
      const approvals = await readObjectiveJourneyReportApprovals(tx, source)
      if (approvals.length !== source.slots.length) return undefined
      const slots: ObjectiveJourneyReport["slots"][number][] = []
      for (let index = 0; index < source.slots.length; index += 1) {
        const slot = source.slots[index]!, approval = approvals[index]
        if (!approval || approval.slotOrdinal !== slot.ordinal) return undefined
        const binding = slot.sourceReady && approval.reviewStatus === "approved" ? approval.approvedBinding ?? null : null
        const sourceUnavailable = slot.tailoringStatus === "ready" && !slot.sourceReady
        const application = approval.reviewStatus === "unknown" || sourceUnavailable
          || approval.reviewStatus === "approved" && !binding
          ? { applicationStatus: "unknown" as const, submissionEvidence: null }
          : await readObjectiveJourneyReportApplication(tx, binding)
        slots.push({ ordinal: slot.ordinal, tailoringStatus: slot.tailoringStatus, job: slot.job,
          reviewStatus: approval.reviewStatus, reviewTurnId: approval.reviewTurnId,
          retirementReason: approval.retirementReason, ...application })
      }
      const known = slots.filter(slot => slot.reviewStatus !== "unknown").length
      const common = { finalItemId: source.finalItemId, graphRevision: source.graphRevision, sourceCounts: source.sourceCounts,
        reviewCoverage: known === slots.length ? "complete" : known ? "partial" : "unavailable", slots }
      const projection = source.reportedScoreFloor === undefined
        ? { schemaVersion: OBJECTIVE_JOURNEY_REPORT_SCHEMA, ...common }
        : { schemaVersion: OBJECTIVE_JOURNEY_REPORT_SCHEMA_V2, ...common, reportedScoreFloor: source.reportedScoreFloor }
      const report = parseObjectiveJourneyReport(projection)
      return report
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
  } catch { return undefined }
}
