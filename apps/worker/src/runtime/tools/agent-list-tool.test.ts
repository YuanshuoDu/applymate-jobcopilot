import { describe, expect, it } from "vitest"
import { Value } from "@sinclair/typebox/value"
import { TASK_GRAPH_RESULT_PAGE_SCHEMA } from "../subagents/task-graph-result-page-contract.js"
import type { CoordinationExecutorOptions } from "./coordination-executors.js"
import { createAgentListTool } from "./agent-list-tool.js"

describe("agent.list tool contract", () => {
  it("keeps the read-only coordination grants and accepts the bounded Analyst preview page", () => {
    const tool = createAgentListTool({} as CoordinationExecutorOptions)
    expect(tool).toMatchObject({
      name: "agent.list", risk: "read", domain: "coordination", idempotency: "read_only",
      capabilities: ["read", "coordination"], requiredCapabilities: ["canManageChildren"], timeoutMs: 30_000,
    })
    expect(tool.description).toContain("analysisSummary, which is advisory and never verification evidence")
    expect(tool.description).toContain("Current graph previews show at most three Scout candidates or Analyst findings")
    expect(tool.description).toContain("If a selection or analysis decision depends on unseen current results")
    expect(tool.description).toContain("stop when enough information is available")
    expect(tool.description).toContain("Do not paginate exhaustively by default")
    expect(tool.description).toContain("exact returned nextOffset")
    expect(tool.description).toContain("refresh the owner-scoped current graph")
    expect(Value.Check(tool.inputSchema, { nodeKey: "scout-node", expectedRevision: 2, offset: 0 })).toBe(true)
    expect(Value.Check(tool.inputSchema, { nodeKey: "scout-node", expectedRevision: 2, offset: -1 })).toBe(false)
    expect(Value.Check(tool.inputSchema, { nodeKey: "scout-node", expectedRevision: 2, offset: 0, cursor: 3 })).toBe(false)
    const analystPage = {
      schemaVersion: TASK_GRAPH_RESULT_PAGE_SCHEMA, trust: "untrusted", availability: "available", graphRevision: 2,
      role: "analyst", taskStatus: "completed", resultStatus: "completed", totalCount: 1, evidenceCount: 1,
      offset: 0, nextOffset: null, analysisSummary: "Advisory only", analysisSummaryTruncated: false,
      items: [{ jobId: "00000000-0000-4000-8000-000000000000", score: 8, evidenceKinds: ["job"] }],
    }
    expect(Value.Check(tool.outputSchema, analystPage)).toBe(true)
  })
})
