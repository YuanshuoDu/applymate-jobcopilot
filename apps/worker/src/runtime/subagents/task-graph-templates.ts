import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import type { TaskGraphCommandPort, TaskGraphTaskTemplate } from "./task-graph-command-port.js"

/** Registered task types are server-owned; a plan may select only these IDs. */
export const TASK_GRAPH_TEMPLATES = Object.freeze({
  scout: Object.freeze({
    role: "scout",
    taskType: "job_discovery",
    allowedActions: Object.freeze(["jobs.search", "jobs.get"]),
    constraints: Object.freeze(["Use approved job search and read tools only; do not submit applications or message employers."]),
    expectedOutputSchema: Object.freeze({ schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }),
  }),
  analyst: Object.freeze({
    role: "analyst",
    taskType: "job_analysis",
    allowedActions: Object.freeze(["jobs.search", "jobs.get", "persona.retrieve", "resume.get_base"]),
    constraints: Object.freeze(["Analyze permitted job, persona, and resume evidence only; do not write, submit, send, or message employers."]),
    expectedOutputSchema: Object.freeze({ schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst" }),
  }),
} satisfies Readonly<Record<string, TaskGraphTaskTemplate>>)

/** Options passed by production composition to the canonical TaskGraph runtime. */
export function taskGraphRuntimeOptions(commandPort: TaskGraphCommandPort): {
  taskGraphCommandPort: TaskGraphCommandPort
  taskGraphTemplates: typeof TASK_GRAPH_TEMPLATES
}
export function taskGraphRuntimeOptions(commandPort: undefined): Record<string, never>
export function taskGraphRuntimeOptions(commandPort: TaskGraphCommandPort | undefined): {
  taskGraphCommandPort: TaskGraphCommandPort
  taskGraphTemplates: typeof TASK_GRAPH_TEMPLATES
} | Record<string, never>
export function taskGraphRuntimeOptions(commandPort: TaskGraphCommandPort | undefined) {
  return commandPort
    ? { taskGraphCommandPort: commandPort, taskGraphTemplates: TASK_GRAPH_TEMPLATES }
    : {}
}
