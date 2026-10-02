import { describe, expect, it, vi } from "vitest"

import { buildInteractiveDiscoveryShortlist, requireCurrentOwnerJobs, selectLatestDiscoveryTasks } from "./interactive-discovery-persistence.js"
import { ROLE_RESULT_SCHEMA, type AnalystResult, type RoleEvidence, type ScoutResult } from "./subagents/role-results.js"
import type { GraphTaskRow } from "./subagents/task-graph-pg-state.js"

const ownerUserId = "user-1"
const evidence: RoleEvidence = { id: "read:job:job-1", kind: "job", ref: "job-1", source: "greenhouse" }
const scout: ScoutResult = {
  schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
  candidates: [{ jobId: "job-1", source: "model-source", url: "https://untrusted.example", evidenceIds: [evidence.id] }], evidence: [evidence], summary: "Found a role",
}
const analyst: AnalystResult = {
  schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed",
  findings: [{ jobId: "job-1", score: 8.5, evidenceIds: [evidence.id] }], evidence: [evidence], summary: "Strong match",
}
const observation = { id: "tool-result:call-1", content: {
  toolCallId: "call-1", toolName: "jobs.search", input: { location: "Dublin" }, status: "completed",
  output: { jobs: [{ id: "job-1", source: "greenhouse" }] }, errorCode: null,
} }

function shortlist() {
  return buildInteractiveDiscoveryShortlist({ ownerUserId, scoutResult: scout, analystResult: analyst, scoutObservations: [observation], analystObservations: [observation] })
}

function node(templateId: "scout" | "analyst", taskId: string) { return { templateId, taskId } }
function task(id: string, role: "scout" | "analyst", status: string): GraphTaskRow {
  return { id, role, status: status as GraphTaskRow["status"], failureReason: null, result: { structuredResult: role === "scout" ? scout : analyst } }
}

describe("interactive discovery persistence", () => {
  it("selects the initial persisted Scout and Analyst outputs", () => {
    const tasks = new Map([
      ["scout-1", task("scout-1", "scout", "completed")],
      ["analyst-1", task("analyst-1", "analyst", "completed")],
    ])

    expect(selectLatestDiscoveryTasks([node("scout", "scout-1"), node("analyst", "analyst-1")], tasks)).toEqual({
      ok: true, scout: tasks.get("scout-1"), analyst: tasks.get("analyst-1"),
    })
  })

  it("selects the latest appended completed role outputs after replan", () => {
    const tasks = new Map([
      ["scout-1", task("scout-1", "scout", "completed")],
      ["analyst-1", task("analyst-1", "analyst", "completed")],
      ["scout-2", task("scout-2", "scout", "completed")],
      ["analyst-2", task("analyst-2", "analyst", "completed")],
    ])

    expect(selectLatestDiscoveryTasks([
      node("scout", "scout-1"), node("analyst", "analyst-1"), node("scout", "scout-2"), node("analyst", "analyst-2"),
    ], tasks)).toEqual({ ok: true, scout: tasks.get("scout-2"), analyst: tasks.get("analyst-2") })
  })

  it("rejects stale completed output when the newest role task failed or remains incomplete", () => {
    const nodes = [node("scout", "scout-1"), node("analyst", "analyst-1"), node("scout", "scout-2")]
    const completed = new Map([
      ["scout-1", task("scout-1", "scout", "completed")],
      ["analyst-1", task("analyst-1", "analyst", "completed")],
      ["scout-2", task("scout-2", "scout", "failed")],
    ])
    expect(selectLatestDiscoveryTasks(nodes, completed)).toEqual({ ok: false, failures: ["scout_task_failed"] })

    completed.set("scout-2", task("scout-2", "scout", "running"))
    expect(selectLatestDiscoveryTasks(nodes, completed)).toEqual({ ok: false, failures: ["scout_task_incomplete"] })
  })

  it("returns bounded role-specific failures when the latest role task is missing", () => {
    expect(selectLatestDiscoveryTasks([], new Map())).toEqual({
      ok: false, failures: ["scout_task_missing", "analyst_task_missing"],
    })
  })

  it("reconstructs candidates only from successful observed job evidence", () => {
    expect(shortlist()).toEqual({ schemaVersion: 1, status: "completed", items: [{ jobId: "job-1", score: 8.5, evidenceIds: ["read:job:job-1"] }], failures: [] })
    expect(buildInteractiveDiscoveryShortlist({ ownerUserId, scoutResult: scout, analystResult: analyst, scoutObservations: [], analystObservations: [] }))
      .toMatchObject({ status: "failed", items: [], failures: ["evidence_unverified"] })
  })

  it("rechecks candidate IDs against current rows owned by the lease user", async () => {
    const query = vi.fn(async (_sql: string, values?: readonly unknown[]) => ({
      rows: values?.[0] === ownerUserId ? [{ id: "job-1" }] : [], rowCount: values?.[0] === ownerUserId ? 1 : 0,
    }))
    expect(await requireCurrentOwnerJobs({ query } as never, ownerUserId, shortlist())).toMatchObject({ status: "completed", items: [{ jobId: "job-1" }] })
    expect(await requireCurrentOwnerJobs({ query } as never, "foreign-user", shortlist())).toMatchObject({ status: "failed", items: [], failures: ["evidence_unverified"] })
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('WHERE "userId" = $1 AND "id" = ANY($2::text[])'), ["foreign-user", ["job-1"]])
  })

  it("drops deleted candidates and records a bounded partial or failed result", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    expect(await requireCurrentOwnerJobs({ query } as never, ownerUserId, shortlist())).toMatchObject({
      schemaVersion: 1, status: "failed", items: [], failures: ["evidence_unverified"],
    })
  })
})
