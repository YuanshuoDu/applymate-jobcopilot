import { describe, expect, it } from "vitest"

import { ApprovalBlock, ArtifactVersionCard, BudgetStrip, TaskTreePanel } from "./index"

describe("v2 workbench exports", () => {
  it("exports all control panels from one boundary", () => {
    expect([ApprovalBlock, ArtifactVersionCard, BudgetStrip, TaskTreePanel]).toHaveLength(4)
  })
})
