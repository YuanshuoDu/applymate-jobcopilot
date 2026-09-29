import type pg from "pg"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import type { TaskGraphCommandPort, TaskGraphTaskTemplate } from "./task-graph-command-port.js"
import { loadSelectedJobPreparation, type SelectedJobPreparation } from "../selected-job-preparation.js"
import type { TurnLease } from "../turns/lease.js"

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

/** Add job-draft capabilities only for a server-validated selected-job Turn. */
export function taskGraphTemplatesForSelectedJob(
  selectedJobPreparation: SelectedJobPreparation | undefined,
): Readonly<Record<string, TaskGraphTaskTemplate>> {
  if (!selectedJobPreparation) return TASK_GRAPH_TEMPLATES
  const context = Object.freeze({ selectedJobPreparation: Object.freeze({ jobId: selectedJobPreparation.jobId }) })
  return Object.freeze({
    ...TASK_GRAPH_TEMPLATES,
    cover_letter_writer: Object.freeze({
      role: "writer",
      taskType: "cover_letter_draft",
      allowedActions: Object.freeze(["jobs.get", "persona.retrieve", "resume.get_base", "cover_letter.draft"]),
      constraints: Object.freeze([
        "Use the server-selected job in selectedJobPreparation; do not substitute a job from goal text.",
        "Use confirmed resume and profile evidence. Save the draft with cover_letter.draft and return only its artifact reference.",
        "Do not submit applications, send messages, or manage children.",
      ]),
      context,
      expectedOutputSchema: Object.freeze({ schemaVersion: ROLE_RESULT_SCHEMA, role: "writer" }),
    }),
    cover_letter_reviewer: Object.freeze({
      role: "reviewer",
      taskType: "cover_letter_review",
      allowedActions: Object.freeze(["artifact.version.read", "artifact.review"]),
      constraints: Object.freeze([
        "Review only the exact artifact reference supplied by the completed Writer dependency.",
        "Read the immutable version through artifact.version.read, then record a hash-bound review with artifact.review.",
        "Return only the persisted artifact reference and review receipt; never include draft text or findings in the final result.",
        "Do not create drafts, submit applications, send messages, or manage children.",
      ]),
      context,
      expectedOutputSchema: Object.freeze({ schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer" }),
    }),
  })
}

export async function taskGraphRuntimeForTurn(input: {
  enabled: boolean
  pool: Pick<pg.Pool, "connect">
  lease: TurnLease
  now: () => Date
  selectedJobPreparationLoader?: (pool: Pick<pg.Pool, "connect">, lease: TurnLease, now: Date) => Promise<SelectedJobPreparation | undefined>
  taskGraphTemplates?: Readonly<Record<string, TaskGraphTaskTemplate>>
}): Promise<{ enabled: boolean; templates: Readonly<Record<string, TaskGraphTaskTemplate>> | undefined }> {
  if (!input.enabled) return { enabled: false, templates: input.taskGraphTemplates }
  const preparation = await (input.selectedJobPreparationLoader ?? loadSelectedJobPreparation)(input.pool, input.lease, input.now())
  return { enabled: true, templates: preparation ? taskGraphTemplatesForSelectedJob(preparation) : input.taskGraphTemplates }
}

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
