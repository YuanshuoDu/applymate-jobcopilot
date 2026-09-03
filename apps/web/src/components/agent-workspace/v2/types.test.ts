import { describe, expect, it } from "vitest"

import type { ArtifactSummary, BudgetUsage, PendingApproval, TaskTreeNode } from "./types"

describe("v2 workbench contracts", () => {
  it("keeps the control panels typed around stable ids", () => {
    const node: TaskTreeNode = { id: "turn-1", kind: "turn", label: "Goal", status: "queued" }
    const approval: PendingApproval = { approvalId: "approval-1", scopeHash: "scope", expiresAt: "2099-01-01", evidenceRefs: [] }
    const artifact: ArtifactSummary = { artifactId: "artifact-1", version: 1, status: "draft" }
    const usage: BudgetUsage = { tokensUsed: 1, tokensBudget: 2, percentage: 50 }
    expect([node.id, approval.approvalId, artifact.artifactId, usage.percentage]).toEqual(["turn-1", "approval-1", "artifact-1", 50])
  })
})
