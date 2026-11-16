import { describe, expect, it } from "vitest"
import { ROLE_RESULT_SCHEMA, type ArtifactVersionReference } from "./role-results.js"
import { reduceTaskGraphFinalSummary } from "./task-graph-final-summary.js"
import type { TaskGraphFinalSummaryBinding, TaskGraphFinalSummaryMember } from "./task-graph-final-summary-binding.js"
import { parseTaskGraphSnapshot, TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"
import { validateTaskGraphFollowUpBinding } from "./task-graph-follow-up-validation.js"

const hash = (value: string) => `sha256:${value.repeat(64)}`
const ref = (artifactId: string): ArtifactVersionReference => ({ artifactId, version: 1, contentHash: hash("a"), sourceDigest: hash("b") })

function preparedBinding(materialRef: ArtifactVersionReference): TaskGraphFinalSummaryBinding {
  const summary = reduceTaskGraphFinalSummary({ graphRevision: 3, nodes: [{ kind: "business", taskId: "prepare-task-1", role: "prepare", taskStatus: "completed", attemptCount: 1,
    structuredResult: { schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare", status: "completed", taskId: "prepare-task-1", attemptCount: 1,
      snapshotDigest: hash("c"), checkpointDigest: "d".repeat(64), jobs: [{ jobId: "job-1", status: "prepared" }],
      materials: [{ jobId: "job-1", kind: "resume", artifactRef: materialRef }] } }] })
  const members: TaskGraphFinalSummaryMember[] = [{ nodeIndex: 0, nodeKey: "prepare-node", templateId: "prepare", taskId: "prepare-task-1",
    role: "prepare", taskType: "prepare_task", taskStatus: "completed", kind: "business" }]
  return { rootTaskId: "root-task-1", graphItemId: "graph-item-1", graphRevision: 3, members, summary }
}

describe("TaskGraph follow-up binding validation", () => {
  it("accepts current Prepare facts with material references nested under their prepared job", () => {
    const materialRef = ref("artifact-current")
    const current = preparedBinding(materialRef)

    expect(current.summary.prepareResults[0]?.jobs).toEqual([{ jobId: "job-1", status: "prepared", materials: [{ kind: "resume", artifactRef: materialRef }] }])
    expect(validateTaskGraphFollowUpBinding(current)).not.toBeNull()
  })

  it("accepts a bounded space-containing node key accepted by the current snapshot parser", () => {
    const current = preparedBinding(ref("artifact-current"))
    const snapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{ key: "search jobs", templateId: "prepare",
      goal: "Prepare materials", successCriteria: ["Save a material"], dependsOn: [], depth: 1, taskId: "prepare-task-1" }] })
    const bindingWithValidKey = { ...current, members: current.members?.map(member => ({ ...member, nodeKey: snapshot.nodes[0]!.key })) }

    expect(snapshot.nodes[0]?.key).toBe("search jobs")
    expect(validateTaskGraphFollowUpBinding(bindingWithValidKey)).not.toBeNull()
  })

  it("rejects outer-level materials or a nested reference inconsistent with the artifact summary", () => {
    const current = preparedBinding(ref("artifact-current"))
    const prepareRow = current.summary.prepareResults[0]!
    const job = prepareRow.jobs[0]!
    const outerMaterials = { ...current, summary: { ...current.summary, prepareResults: [{ ...prepareRow,
      jobs: [{ ...job, materials: [] }], materials: job.materials }] } } as unknown as TaskGraphFinalSummaryBinding
    const wrongRef = ref("artifact-other")
    const mismatchedNestedRef = { ...current, summary: { ...current.summary, prepareResults: [{ ...prepareRow,
      jobs: [{ ...job, materials: [{ kind: "resume" as const, artifactRef: wrongRef }] }] }] } } as unknown as TaskGraphFinalSummaryBinding
    const missingArtifactSummary = { ...current, summary: { ...current.summary, counts: { ...current.summary.counts,
      artifactReferences: { coverage: "complete" as const, knownCount: 0 } }, artifactReferences: [] } } as unknown as TaskGraphFinalSummaryBinding

    expect(validateTaskGraphFollowUpBinding(outerMaterials)).toBeNull()
    expect(validateTaskGraphFollowUpBinding(mismatchedNestedRef)).toBeNull()
    expect(validateTaskGraphFollowUpBinding(missingArtifactSummary)).toBeNull()
  })
})
