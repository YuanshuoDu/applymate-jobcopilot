import type { PrismaClient } from "@prisma/client"
import { isApprovalHash } from "@jobcopilot/agent-protocol"
import { decideObjectiveApplicationApprovalSetMemberInTransaction,
  type ObjectiveApplicationApprovalSetDecisionInput } from "./objective-application-approval-set-decision"
import { waitNotFound, waitScopeMismatch } from "./errors"
import { recordObjectiveApplicationApprovedIntent } from "./objective-application-approved-intent"
import { verifyObjectiveApplicationReviewSource } from "./objective-application-review-source"

type DecisionInput = Omit<ObjectiveApplicationApprovalSetDecisionInput, "expectedScopeHash">

/** Resolves a member using only the approval scope hash stored by the server. */
export async function decideObjectiveApplicationReviewMember(database: PrismaClient, input: DecisionInput) {
  return database.$transaction(async tx => {
    const receipt = await tx.agentApproval.findFirst({
      where: { id: input.approvalId, userId: input.userId, sessionId: input.sessionId,
        turnId: input.expectedTurnId, type: "review_application" },
      select: { scopeHash: true },
    })
    if (!receipt) throw waitNotFound()
    if (!isApprovalHash(receipt.scopeHash)) throw waitScopeMismatch()
    return decideObjectiveApplicationApprovalSetMemberInTransaction(tx, { ...input, expectedScopeHash: receipt.scopeHash }, {
      verifySource: verifyObjectiveApplicationReviewSource,
      recordApprovedHandoff: recordObjectiveApplicationApprovedIntent,
    })
  })
}
