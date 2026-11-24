import type { PrismaClient } from "@prisma/client"
import {
  parseObjectiveReviewedFillHandoffOutboxRow,
  type ObjectiveReviewedFillHandoffOutboxRow,
} from "@jobcopilot/shared"
import { runWithTenantContext } from "@/lib/db/tenant-store"
import { AutoApplyError } from "@/lib/auto-apply-guards"
import { AgentCommandError } from "../control-plane/commands/errors"
import {
  acknowledgeExistingObjectiveReviewedFill, startObjectiveReviewedApplicationFill,
} from "../control-plane/commands/objective-reviewed-application-fill-command"
import { assertReviewedFillLaunchAllowed } from "./reviewed-fill-admission"
import { ReviewedFillHandoffDeferredError } from "./reviewed-fill-handoff"
import { ReviewedFillSourceBindingError } from "./reviewed-fill-source-binding"

export type ObjectiveReviewedFillDispatchStatus = "queued" | "duplicate" | "deferred" | "terminal"

/** Consumes only a parsed Objective handoff, running every Prisma operation in its owner context. */
export async function processObjectiveReviewedFillHandoffOutbox(
  db: PrismaClient, row: ObjectiveReviewedFillHandoffOutboxRow,
): Promise<ObjectiveReviewedFillDispatchStatus> {
  const parsed = parseObjectiveReviewedFillHandoffOutboxRow(row)
  if (!parsed || parsed.id !== row.id) return "terminal"
  return runWithTenantContext(parsed.payload.userId, async () => {
    try {
      const duplicate = await acknowledgeExistingObjectiveReviewedFill(db, parsed.payload)
      if (duplicate.kind === "duplicate") return "duplicate"
      await assertReviewedFillLaunchAllowed(parsed.payload)
      const result = await startObjectiveReviewedApplicationFill(db, parsed.payload)
      return result.disposition === "started" ? "queued" : result.disposition === "duplicate" ? "duplicate" : "terminal"
    } catch (error: unknown) {
      if (error instanceof ReviewedFillHandoffDeferredError || error instanceof AgentCommandError && error.code === "retry_active_conflict") return "deferred"
      if (error instanceof ReviewedFillSourceBindingError || error instanceof AgentCommandError || error instanceof AutoApplyError) return "terminal"
      throw error
    }
  })
}
