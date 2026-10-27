import { describe, expect, it } from "vitest"
import { TASK_GRAPH_SNAPSHOT_VERSION, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { projectScheduledAnalyzePrefix } from "./scheduled-analyze-prefix.js"
import type { TaskGraphCurrentState } from "./task-graph-command-port.js"

const nodes: TaskGraphSnapshot["nodes"] = [
  ...["source-a", "source-b"].map((key, index) => ({ key, templateId: "scout" as const, depth: 1,
    taskId: `task-${index}`, goal: "Discover jobs", successCriteria: ["Return matching jobs"], dependsOn: [] })),
  { key: "analyst", templateId: "analyst", depth: 2, taskId: "analyst-task", goal: "Analyze jobs",
    successCriteria: ["Return findings"], dependsOn: ["source-a", "source-b"] },
]
const snapshot: TaskGraphSnapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes }
const tasks = [
  { id: "task-0", role: TASK_GRAPH_TEMPLATES.scout.role, taskType: TASK_GRAPH_TEMPLATES.scout.taskType, status: "completed", attemptCount: 1,
    failureReason: null, expectedOutputSchema: TASK_GRAPH_TEMPLATES.scout.expectedOutputSchema, allowedActions: TASK_GRAPH_TEMPLATES.scout.allowedActions },
  { id: "task-1", role: TASK_GRAPH_TEMPLATES.scout.role, taskType: TASK_GRAPH_TEMPLATES.scout.taskType, status: "completed", attemptCount: 1,
    failureReason: null, expectedOutputSchema: TASK_GRAPH_TEMPLATES.scout.expectedOutputSchema, allowedActions: TASK_GRAPH_TEMPLATES.scout.allowedActions },
  { id: "analyst-task", role: TASK_GRAPH_TEMPLATES.analyst.role, taskType: TASK_GRAPH_TEMPLATES.analyst.taskType, status: "completed", attemptCount: 1,
    failureReason: null, expectedOutputSchema: TASK_GRAPH_TEMPLATES.analyst.expectedOutputSchema, allowedActions: TASK_GRAPH_TEMPLATES.analyst.allowedActions },
]
const current = { revision: 3, nodes: [{}, {}, {}] } as unknown as TaskGraphCurrentState

describe("scheduled Analyze prefix projection", () => {
  it("retains all current typed Scouts with the Analyst before later suffix nodes", () => {
    expect(projectScheduledAnalyzePrefix(snapshot, current, tasks)?.snapshot.nodes.map(node => node.key)).toEqual(["source-a", "source-b", "analyst"])
  })

  it("fails closed when a direct Scout has no unique current task binding", () => {
    expect(projectScheduledAnalyzePrefix(snapshot, current, tasks.slice(1))).toBeNull()
  })
})
