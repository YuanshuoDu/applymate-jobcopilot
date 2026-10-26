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
    const analystPage = {
      schemaVersion: TASK_GRAPH_RESULT_PAGE_SCHEMA, trust: "untrusted", availability: "available", graphRevision: 2,
      role: "analyst", taskStatus: "completed", resultStatus: "completed", totalCount: 1, evidenceCount: 1,
      offset: 0, nextOffset: null, analysisSummary: "Advisory only", analysisSummaryTruncated: false,
      items: [{ jobId: "00000000-0000-4000-8000-000000000000", score: 8, evidenceKinds: ["job"] }],
    }
    expect(Value.Check(tool.outputSchema, analystPage)).toBe(true)
  })
})
