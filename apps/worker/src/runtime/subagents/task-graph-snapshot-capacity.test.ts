import { describe, expect, it } from "vitest"

import { parseTaskGraphSnapshotPackageRefs, taskGraphSnapshotCapacityValid } from "./task-graph-snapshot-capacity.js"
import type { ScheduledPipelineGraphNode } from "./scheduled-pipeline-graph-shape.js"

function node(key: string, templateId: string, depth: number, dependsOn: string[], packageRefs?: string[]): ScheduledPipelineGraphNode {
  return { key, templateId, depth, dependsOn, ...(packageRefs ? { packageRefs } : {}) }
}

function postGateGraph(): ScheduledPipelineGraphNode[] {
  const scouts = Array.from({ length: 4 }, (_, index) => node(`scout-${index + 1}`, "scout", 1, []))
  const analyst = node("analyst", "analyst", 2, scouts.map(item => item.key))
  const prepare = node("prepare", "prepare", 3, [analyst.key])
  const gate = node("gate", "gate", 4, [prepare.key])
  const executes = Array.from({ length: 3 }, (_, index) => node(`execute-${index + 1}`, "scheduled.application.execute", 5,
    [gate.key], [`job-${index + 1}`]))
  return [...scouts, analyst, prepare, gate, ...executes,
    node("scheduled.post_gate_audit", "scheduled.post_gate_audit", 6, executes.map(item => item.key))]
}

describe("TaskGraph snapshot capacity and package reference parsing", () => {
  it("keeps ordinary snapshots at eight and admits only a complete bounded post-Gate graph above eight", () => {
    expect(taskGraphSnapshotCapacityValid(Array.from({ length: 8 }, (_, index) => node(`ordinary-${index}`, "scout", 1, [])))).toBe(true)
    expect(taskGraphSnapshotCapacityValid(Array.from({ length: 9 }, (_, index) => node(`ordinary-${index}`, "scout", 1, [])))).toBe(false)
    expect(taskGraphSnapshotCapacityValid(postGateGraph())).toBe(true)
    const malformed = postGateGraph()
    malformed[10] = node("scheduled.post_gate_audit", "scheduled.post_gate_audit", 6, ["execute-1"])
    expect(taskGraphSnapshotCapacityValid(malformed)).toBe(false)
  })

  it("accepts packageRefs only on the specialized Execute persisted-node shape", () => {
    const execute = { key: "execute-1", templateId: "scheduled.application.execute", goal: "Prepare approved jobs",
      successCriteria: ["Each job is prepared"], dependsOn: ["gate"], depth: 5, taskId: "task-execute-1",
      verificationDisposition: "specialized", packageRefs: ["job-1"] }
    expect(parseTaskGraphSnapshotPackageRefs(execute)).toMatchObject({ valid: true, shape: true, packageRefs: ["job-1"] })
    expect(parseTaskGraphSnapshotPackageRefs({ ...execute, packageRefs: [] })).toMatchObject({ valid: true, packageRefs: [] })
    for (const invalid of [
      { ...execute, verificationDisposition: "legacy_unverified" },
      { ...execute, packageRefs: ["job-1", "job-1"] },
      { ...execute, packageRefs: [" job-1"] },
      { ...execute, packageRefs: Array.from({ length: 51 }, (_, index) => `job-${index}`) },
      { ...execute, packageRefs: undefined },
      { ...execute, templateId: "scout" },
      { ...execute, packageRefs: ["job-1"], extra: true },
    ]) expect(parseTaskGraphSnapshotPackageRefs(invalid)).toMatchObject({ valid: false })
    expect(parseTaskGraphSnapshotPackageRefs({ key: "scout", templateId: "scout" })).toMatchObject({ valid: true, shape: false })
  })
})
