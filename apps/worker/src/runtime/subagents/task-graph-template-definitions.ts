import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import type { TaskGraphTaskTemplate } from "./task-graph-command-port.js"

/** Registered task types are server-owned; a plan may select only these IDs. */
export const TASK_GRAPH_TEMPLATES = Object.freeze({
  scout: Object.freeze({
    role: "scout",
    taskType: "job_discovery",
    allowedActions: Object.freeze(["jobs.search", "jobs.get", "jobs.discover", "tool_results.read"]),
    constraints: Object.freeze(["Use approved job discovery and read tools only; do not submit applications or message employers."]),
    expectedOutputSchema: Object.freeze({ schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }),
  }),
  analyst: Object.freeze({
    role: "analyst",
    taskType: "job_analysis",
    allowedActions: Object.freeze(["jobs.search", "jobs.get", "persona.retrieve", "resume.get_base"]),
    constraints: Object.freeze(["Analyze permitted job, persona, and resume evidence only; do not write, submit, send, or message employers."]),
    expectedOutputSchema: Object.freeze({ schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst" }),
  }),
  prepare: Object.freeze({
    role: "prepare",
    taskType: "scheduled_application_prepare",
    allowedActions: Object.freeze(["scheduled.application.prepare"]),
    constraints: Object.freeze([
      "This is a specialized scheduled continuation; never select Prepare in the initial Scout/Analyst plan.",
      "Prepare only the jobs, 0–100 scores, and schedule settings bound by the server-owned persisted Analyze checkpoint and schedule snapshot.",
      "Treat job IDs and digests from tool results as correlation data; the server must rebind them to persisted owner, task, attempt, checkpoint, and snapshot evidence.",
      "Return only per-job status and immutable artifact references; never include scores, resume or letter bodies, user identity, or schedule configuration.",
      "Do not submit applications or message employers.",
    ]),
    expectedOutputSchema: Object.freeze({ schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare" }),
  }),
} satisfies Readonly<Record<string, TaskGraphTaskTemplate>>)
