import { describe, expect, it } from "vitest"
import type { ToolCallRequest, ToolExecutionContext } from "./types.js"

const request: ToolCallRequest = { id: "call-1", toolName: "jobs.get", toolVersion: "1", input: { jobId: "job-1" } }
const contextFields: Pick<ToolExecutionContext, "sessionId" | "turnId" | "stepId"> = { sessionId: "session", turnId: "turn", stepId: "step" }

describe("tool runtime contracts", () => {
  it("keeps model calls separate from runtime tenant context", () => {
    expect(request.input).not.toHaveProperty("userId")
    expect(contextFields).toEqual({ sessionId: "session", turnId: "turn", stepId: "step" })
  })
})
