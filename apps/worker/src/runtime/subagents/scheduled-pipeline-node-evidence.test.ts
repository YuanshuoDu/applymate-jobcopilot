import { describe, expect, it } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, type TaskGraphVerificationCheck } from "../planning/task-graph-verification-contract.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { isScheduledAnalystNode, isScheduledScoutNode, type ScheduledPipelineNodeEvidence } from "./scheduled-pipeline-node-evidence.js"

const scout = (key: string) => ({ node: { key, templateId: "scout", dependsOn: [], verificationDisposition: "typed", verification: { role: "scout" } },
  task: { role: "scout", taskType: TASK_GRAPH_TEMPLATES.scout.taskType, expectedOutputSchema: TASK_GRAPH_TEMPLATES.scout.expectedOutputSchema,
    allowedActions: TASK_GRAPH_TEMPLATES.scout.allowedActions } }) as unknown as ScheduledPipelineNodeEvidence
const analyst = (keys: string[], check: TaskGraphVerificationCheck) => ({ node: { key: "analyst", templateId: "analyst", dependsOn: keys,
  verificationDisposition: "typed", verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [{ id: "source", check }] } },
  task: { role: "analyst", taskType: TASK_GRAPH_TEMPLATES.analyst.taskType, expectedOutputSchema: TASK_GRAPH_TEMPLATES.analyst.expectedOutputSchema,
    allowedActions: TASK_GRAPH_TEMPLATES.analyst.allowedActions } }) as unknown as ScheduledPipelineNodeEvidence

describe("scheduled multi-Scout typed graph eligibility", () => {
  it("requires an explicit union membership check covering every direct Scout", () => {
    const scouts = [scout("scout-a"), scout("scout-b")]
    expect(isScheduledAnalystNode(analyst(["scout-b", "scout-a"], { kind: "findings_from_scout_union", dependencyNodeKeys: ["scout-a", "scout-b"] }), scouts)).toBe(true)
    expect(isScheduledAnalystNode(analyst(["scout-a", "scout-b"], { kind: "findings_from_scout_union", dependencyNodeKeys: ["scout-a"] }), scouts)).toBe(false)
    expect(isScheduledAnalystNode(analyst(["scout-a", "scout-b"], { kind: "findings_cover_scout_candidate_union_gte",
      dependencyNodeKeys: ["scout-a", "scout-b"], minimumPercent: 100 }), scouts)).toBe(false)
  })

  it("preserves the single-Scout scalar membership contract", () => {
    const source = scout("scout-a")
    expect(isScheduledScoutNode(source)).toBe(true)
    expect(isScheduledAnalystNode(analyst(["scout-a"], { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout-a" }), [source])).toBe(true)
  })
})
