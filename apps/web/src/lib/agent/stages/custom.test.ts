import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/db", () => ({ db: {} }))
vi.mock("@/lib/model-router", () => ({ modelChat: vi.fn() }))

import { summarizeCustomAgentResults } from "./custom"

describe("summarizeCustomAgentResults", () => {
  it("deduplicates findings by job and keeps the strongest confidence", () => {
    const summary = summarizeCustomAgentResults([
      {
        agentId: "research", agentName: "Company Research", afterStage: "scout",
        observations: [{ jobId: "job_1", company: "Acme", role: "Engineer", summary: "A", risks: ["Remote policy unclear"], recommendation: "Ask", confidence: 0.4 }],
      },
      {
        agentId: "fit", agentName: "Fit Review", afterStage: "analyst",
        observations: [{ jobId: "job_1", company: "Acme", role: "Engineer", summary: "B", risks: ["Remote policy unclear", "Visa unknown"], recommendation: "Verify visa", confidence: 0.8 }],
      },
    ])

    expect(summary).toEqual([expect.objectContaining({
      jobId: "job_1",
      confidence: 0.8,
      risks: ["Remote policy unclear", "Visa unknown"],
      recommendations: ["Ask", "Verify visa"],
    })])
  })
})
