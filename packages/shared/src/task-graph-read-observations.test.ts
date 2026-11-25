import { describe, expect, it } from "vitest"

import { canonicalTaskGraphReadObservations } from "./task-graph-read-observations.js"
import { isTaskGraphEvidenceToolName } from "./task-graph-verification-digest.js"

function call(id: string, toolName: string) {
  return { id: `call-item:${id}`, type: "tool_call", attempt: 1, revision: 0,
    content: { toolCallId: id, toolName, toolVersion: "1", input: {} } }
}

function result(id: string, output?: unknown) {
  return { id: `result-item:${id}`, type: "tool_result", revision: 0,
    content: { toolCallId: id, ...(output === undefined ? {} : { output }) } }
}

describe("canonical TaskGraph read observations", () => {
  it("uses the existing closed six-tool allowlist", () => {
    const names = ["jobs.search", "jobs.get", "jobs.discover", "tool_results.read", "persona.retrieve", "resume.get_base"]
    for (const name of names) expect(isTaskGraphEvidenceToolName(name)).toBe(true)
    expect(isTaskGraphEvidenceToolName("cover_letter.draft")).toBe(false)
  })

  it("keeps every successful accepted read, even when the result did not cite it", () => {
    const items = [
      call("direct", "jobs.search"), result("direct", { jobs: [{ id: "job-a" }], page: 1, hasMore: false }),
      call("extra", "jobs.get"), result("extra", { job: { id: "job-b" } }),
      call("failed", "persona.retrieve"), result("failed", { facts: [{ id: "private-fact" }] }),
      call("unrelated", "cover_letter.draft"), result("unrelated", { artifactRef: { artifactId: "a", version: 1 } }),
    ]
    const observations = canonicalTaskGraphReadObservations(items, new Map([
      ["direct", "completed"], ["extra", "completed"], ["failed", "failed"], ["unrelated", "completed"],
    ]))
    expect(observations.map(item => item.content.toolCallId)).toEqual(["direct", "extra"])
    expect(observations.map(item => item.content.output)).toEqual([
      { jobs: [{ id: "job-a", source: "jobs.read", observedSource: null, location: null }] },
      { job: { id: "job-b", source: "jobs.read", observedSource: null, location: null } },
    ])
  })

  it("rejects omitted and truncated successful outputs", () => {
    expect(() => canonicalTaskGraphReadObservations([call("missing", "jobs.get"), result("missing")],
      new Map([["missing", "completed"]]))).toThrow("task_graph_verification_output_invalid")
    expect(() => canonicalTaskGraphReadObservations([call("truncated", "jobs.search"), result("truncated", "[TRUNCATED]")],
      new Map([["truncated", "completed"]]))).toThrow("task_graph_verification_output_invalid")
  })

  it("preserves per-observation and aggregate byte caps", () => {
    const oversized = [call("large", "jobs.search"), result("large", { jobs: [], preview: "x".repeat(512 * 1024) })]
    expect(() => canonicalTaskGraphReadObservations(oversized, new Map([["large", "completed"]])))
      .toThrow("task_graph_verification_output_invalid")
    const items = Array.from({ length: 5 }, (_, index) => [
      call(`total-${index}`, "jobs.search"),
      result(`total-${index}`, { jobs: [], padding: "x".repeat(450 * 1024) }),
    ]).flat()
    const outcomes = new Map<string, "completed" | "failed">(Array.from({ length: 5 }, (_, index) => [`total-${index}`, "completed"]))
    expect(() => canonicalTaskGraphReadObservations(items, outcomes)).toThrow("task_graph_verification_output_invalid")
  })
})
