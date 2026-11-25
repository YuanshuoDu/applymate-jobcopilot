import { describe, expect, it } from "vitest"
import {
  canonicalTaskGraphResultJson,
  isTaskGraphEvidenceToolName,
  taskGraphEvidenceDigest,
  taskGraphResultDigest,
} from "./task-graph-verification-digest.js"

const result = {
  status: "completed",
  structuredResult: {
    findings: [{ jobId: "job-1", score: 8, evidenceIds: ["ev-b", "ev-a"] }],
    evidence: [{ id: "ev-a", kind: "job" }],
  },
}
const replayCall = "task-graph-replay-v1:step-9:source-call"
const items = [
  { id: "call-item-2", type: "tool_call", attempt: 2, revision: 4, content: {
    toolCallId: "call-2", toolName: "jobs.get", toolVersion: "1", input: { jobId: "job-1" }, status: "completed", errorCode: null,
  } },
  { id: "result-item-2", type: "tool_result", attempt: 2, revision: 5, content: {
    toolCallId: "call-2", output: { job: { id: "job-1", source: "greenhouse" } }, errorCode: null,
  } },
  { id: "call-item-1", type: "tool_call", attempt: 1, revision: 1, content: {
    toolCallId: replayCall, toolName: "jobs.search", toolVersion: "1", input: { query: "engineer" }, status: "completed", errorCode: null,
  } },
  { id: "result-item-1", type: "tool_result", attempt: 1, revision: 3, content: {
    toolCallId: replayCall, output: { jobs: [{ id: "job-1", source: "greenhouse" }] }, errorCode: null,
  } },
]
const outcomes = new Map<string, "completed" | "failed">([
  [replayCall, "completed"], ["call-2", "completed"], ["failed", "failed"], ["ordinary", "completed"],
])
const resultDigest = "c0de43b19aee1d9f9c33c485f1bdaeb0f3f932b4ca5efdca3565df4aca53d2d5"
const replayReceipts = [{ currentCallId: replayCall, sourceCallItem: ["source-call", 2] as const,
  sourceResultItem: ["source-result", 3] as const }]

describe("TaskGraph verification digest compatibility", () => {
  it("pins canonical result bytes, including nested key-order normalization", () => {
    expect(canonicalTaskGraphResultJson(result)).toBe('{"status":"completed","structuredResult":{"evidence":[{"id":"ev-a","kind":"job"}],"findings":[{"evidenceIds":["ev-b","ev-a"],"jobId":"job-1","score":8}]}}')
    expect(taskGraphResultDigest(result)).toBe(resultDigest)
    expect(taskGraphResultDigest({
      structuredResult: {
        evidence: [{ kind: "job", id: "ev-a" }],
        findings: [{ evidenceIds: ["ev-b", "ev-a"], score: 8, jobId: "job-1" }],
      },
      status: "completed",
    })).toBe(resultDigest)
    expect(taskGraphResultDigest({ ...result, extra: true }))
      .toBe("a18b4901b36be0286490adc768f350d238951a1050679284ed5a1c962573f8ea")
    expect(() => canonicalTaskGraphResultJson(undefined)).toThrow("task_graph_verification_result_invalid")
  })

  it("pins evidence bytes with and without a verified replay source", () => {
    expect(taskGraphEvidenceDigest(items, outcomes, ["ev-b", "ev-a"], resultDigest, replayReceipts))
      .toBe("0dc4740e860f61b2e54dcc2c275304581a43ad33242dc2673f4ed7dc85339033")
    expect(taskGraphEvidenceDigest(items, outcomes, ["ev-b", "ev-a"], resultDigest, []))
      .toBe("d1bc2b10773b37760ab016bb0d8d0133917ab268bd22fa4aaabcc80926b57046")
  })

  it("sorts evidence IDs and receipt entries while retaining replay bindings", () => {
    expect(taskGraphEvidenceDigest(items, outcomes, ["ev-a", "ev-b"], resultDigest, replayReceipts))
      .toBe("0dc4740e860f61b2e54dcc2c275304581a43ad33242dc2673f4ed7dc85339033")
    expect(taskGraphEvidenceDigest(items, outcomes, ["ev-b", "ev-c"], resultDigest, replayReceipts))
      .toBe("d8de2d895fd1c3d662018f42de60e5acdbcb28ba93e57f36b47132e191bfd4a9")
    expect(taskGraphEvidenceDigest(items, outcomes, ["ev-b", "ev-a"], resultDigest, [
      { ...replayReceipts[0]!, sourceResultItem: ["source-result-other", 3] as const },
    ])).toBe("6a4cefa35ecba05e6f9edd3ec0aaa0ca1f8d28821997b686b4df1c3d9646e192")
  })

  it("preserves persisted output JSON key order and omits failed or unrelated calls", () => {
    const reorderedOutput = taskGraphEvidenceDigest(items.map(item => item.id === "result-item-2" ? {
      ...item, content: { ...item.content, output: { job: { source: "greenhouse", id: "job-1" } } },
    } : item), outcomes, ["ev-b", "ev-a"], resultDigest, replayReceipts)
    expect(reorderedOutput).toBe("e9538937b0f219a2bea89dcffc51ab7f7239a6697b22b1bf8a8e709a0967d0a3")
    const ignored = [
      ...items,
      { id: "failed-call", type: "tool_call", attempt: 3, revision: 1, content: {
        toolCallId: "failed", toolName: "jobs.get", toolVersion: "1", input: {}, status: "failed", errorCode: "temporary",
      } },
      { id: "failed-result", type: "tool_result", attempt: 3, revision: 1, content: { toolCallId: "failed", output: null } },
      { id: "ordinary-call", type: "tool_call", attempt: 4, revision: 1, content: {
        toolCallId: "ordinary", toolName: "agent.plan", toolVersion: "1", input: {}, status: "completed", errorCode: null,
      } },
      { id: "ordinary-result", type: "tool_result", attempt: 4, revision: 1, content: { toolCallId: "ordinary", output: { plan: true } } },
    ]
    expect(taskGraphEvidenceDigest(ignored, outcomes, ["ev-b", "ev-a"], resultDigest, replayReceipts))
      .toBe("0dc4740e860f61b2e54dcc2c275304581a43ad33242dc2673f4ed7dc85339033")
  })

  it("keeps the evidence tool selection closed", () => {
    expect(["jobs.search", "jobs.get", "jobs.discover", "tool_results.read", "persona.retrieve", "resume.get_base"]
      .every(isTaskGraphEvidenceToolName)).toBe(true)
    expect(isTaskGraphEvidenceToolName("agent.plan")).toBe(false)
  })
})
