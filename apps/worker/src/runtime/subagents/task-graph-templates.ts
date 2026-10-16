import type pg from "pg"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import type { TaskGraphCommandPort, TaskGraphTaskTemplate } from "./task-graph-command-port.js"
import { loadSelectedJobPreparation, type SelectedJobPreparation } from "../selected-job-preparation.js"
import { loadApplicationFillPreparation, type ApplicationFillPreparation } from "../application-fill-preparation.js"
import type { TurnLease } from "../turns/lease.js"

const APPLICATION_FILL_TEMPLATE_ID = "application_filler"
const SCHEDULED_AUTOMATION_SNAPSHOT_SCHEMA_VERSION = "agent-harness.v2.scheduled-automation-snapshot.v1"
const APPLICATION_FILL_TEMPLATE: TaskGraphTaskTemplate = Object.freeze({
  role: "application_filler",
  taskType: "application_fill_for_review",
  allowedActions: Object.freeze([]),
  constraints: Object.freeze([
    "Fill only the application bound to the server-owned current Turn.",
    "Do not submit or contact the employer; stop for user review.",
  ]),
})

type ScheduledAutomationCriteria = Readonly<{
  targetRoles: readonly string[]
  targetLocations: readonly string[]
  minScore: number
}>

const SCHEDULED_AUTOMATION_SNAPSHOT_KEYS = Object.freeze([
  "schemaVersion", "targetRoles", "targetLocations", "minScore", "dailyCap", "requireApproval", "autoApply",
])

function ownDataRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return undefined
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined
      record[key] = descriptor.value
    }
    return record
  } catch {
    return undefined
  }
}

function exactSnapshotRecord(value: unknown): Record<string, unknown> | undefined {
  const record = ownDataRecord(value)
  if (!record || Object.keys(record).length !== SCHEDULED_AUTOMATION_SNAPSHOT_KEYS.length ||
    SCHEDULED_AUTOMATION_SNAPSHOT_KEYS.some(key => !Object.prototype.hasOwnProperty.call(record, key))) return undefined
  return record
}

function boundedSnapshotList(value: unknown, minItems: number, maxItems: number): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) return undefined
  try {
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== value.length + 1 || ownKeys.some(key => key !== "length" &&
      (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) return undefined
  } catch {
    return undefined
  }
  const result: string[] = []
  for (let index = 0; index < value.length; index++) {
    const entry: unknown = value[index]
    if (typeof entry !== "string" || !entry.trim() || entry.length > 160) return undefined
    result.push(entry.trim())
  }
  return Object.freeze(result)
}

function scheduledAutomationCriteria(turnInput: unknown): ScheduledAutomationCriteria | undefined {
  const input = ownDataRecord(turnInput)
  const snapshot = exactSnapshotRecord(input?.scheduledAutomationSnapshot)
  if (!snapshot || snapshot.schemaVersion !== SCHEDULED_AUTOMATION_SNAPSHOT_SCHEMA_VERSION) return undefined
  const targetRoles = boundedSnapshotList(snapshot.targetRoles, 1, 8)
  const targetLocations = boundedSnapshotList(snapshot.targetLocations, 0, 8)
  const minScore = snapshot.minScore
  const dailyCap = snapshot.dailyCap
  if (!targetRoles || !targetLocations || typeof minScore !== "number" || !Number.isInteger(minScore) || minScore < 0 || minScore > 100 ||
    typeof dailyCap !== "number" || !Number.isInteger(dailyCap) || dailyCap < 1 || dailyCap > 50 ||
    typeof snapshot.requireApproval !== "boolean" || typeof snapshot.autoApply !== "boolean") return undefined
  return Object.freeze({ targetRoles, targetLocations, minScore })
}

function taskGraphTemplatesForScheduledAutomation(
  templates: Readonly<Record<string, TaskGraphTaskTemplate>> | undefined,
  criteria: ScheduledAutomationCriteria,
): Readonly<Record<string, TaskGraphTaskTemplate>> | undefined {
  const scout = templates?.scout
  if (!templates || !scout) return templates
  const existingContext = ownDataRecord(scout.context)
  const context = Object.freeze({
    ...(existingContext ?? {}),
    scheduledAutomationCriteria: criteria,
  })
  return Object.freeze({ ...templates, scout: Object.freeze({ ...scout, context }) })
}

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
} satisfies Readonly<Record<string, TaskGraphTaskTemplate>>)

/** Add job-draft capabilities only for a server-validated selected-job Turn. */
export function taskGraphTemplatesForSelectedJob(
  selectedJobPreparation: SelectedJobPreparation | undefined,
): Readonly<Record<string, TaskGraphTaskTemplate>> {
  if (!selectedJobPreparation) return TASK_GRAPH_TEMPLATES
  const context = Object.freeze({ selectedJobPreparation: Object.freeze({ jobId: selectedJobPreparation.jobId }) })
  return Object.freeze({
    scout: Object.freeze({
      ...TASK_GRAPH_TEMPLATES.scout,
      allowedActions: Object.freeze(["jobs.get"]),
      constraints: Object.freeze([
        "Read evidence only for the server-selected job in selectedJobPreparation; do not search or substitute another job.",
        "Do not submit applications or message employers.",
      ]),
      context,
    }),
    analyst: Object.freeze({
      ...TASK_GRAPH_TEMPLATES.analyst,
      allowedActions: Object.freeze(["jobs.get", "persona.retrieve", "resume.get_base"]),
      constraints: Object.freeze([
        "Read evidence only for the server-selected job in selectedJobPreparation, the server-selected base resume, and cover-letter-approved persona facts.",
        "Do not search or substitute another job, resume, or persona use case; do not write, submit, send, or message employers.",
      ]),
      context,
    }),
    cover_letter_writer: Object.freeze({
      role: "writer",
      taskType: "cover_letter_draft",
      allowedActions: Object.freeze(["cover_letter.draft"]),
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

/** App-fill capability is reserved and appears only after its exact DB binding is confirmed. */
export function taskGraphTemplatesForApplicationFill(
  templates: Readonly<Record<string, TaskGraphTaskTemplate>> | undefined,
  preparation: ApplicationFillPreparation | undefined,
): Readonly<Record<string, TaskGraphTaskTemplate>> | undefined {
  const base = templates && Object.prototype.hasOwnProperty.call(templates, APPLICATION_FILL_TEMPLATE_ID)
    ? Object.freeze(Object.fromEntries(Object.entries(templates).filter(([key]) => key !== APPLICATION_FILL_TEMPLATE_ID)))
    : templates
  return preparation ? Object.freeze({ ...(base ?? {}), [APPLICATION_FILL_TEMPLATE_ID]: APPLICATION_FILL_TEMPLATE }) : base
}

export async function taskGraphRuntimeForTurn(input: {
  enabled: boolean
  turnSource?: string
  automationRunMode?: "scheduled" | "manual"
  turnInput?: unknown
  pool: Pick<pg.Pool, "connect">
  lease: TurnLease
  now: () => Date
  selectedJobPreparationLoader?: (pool: Pick<pg.Pool, "connect">, lease: TurnLease, now: Date) => Promise<SelectedJobPreparation | undefined>
  applicationFillPreparationLoader?: (pool: Pick<pg.Pool, "connect">, lease: TurnLease, now: Date) => Promise<ApplicationFillPreparation | undefined>
  taskGraphTemplates?: Readonly<Record<string, TaskGraphTaskTemplate>>
}): Promise<{ enabled: boolean; selectedJobMode: boolean; selectedJobPreparation: SelectedJobPreparation | undefined; templates: Readonly<Record<string, TaskGraphTaskTemplate>> | undefined }> {
  if (!input.enabled) return {
    enabled: false, selectedJobMode: false, selectedJobPreparation: undefined,
    templates: taskGraphTemplatesForApplicationFill(input.taskGraphTemplates, undefined),
  }
  let automationCriteria: ScheduledAutomationCriteria | undefined
  if (input.turnSource === "automation") {
    if (input.automationRunMode === "scheduled") {
      automationCriteria = scheduledAutomationCriteria(input.turnInput)
      if (!automationCriteria) throw new Error("scheduled_automation_context_invalid")
    } else if (input.automationRunMode !== "manual") {
      throw new Error("scheduled_automation_context_invalid")
    }
  }
  const now = input.now()
  const [preparation, applicationFill] = await Promise.all([
    (input.selectedJobPreparationLoader ?? loadSelectedJobPreparation)(input.pool, input.lease, now),
    (input.applicationFillPreparationLoader ?? loadApplicationFillPreparation)(input.pool, input.lease, now),
  ])
  const templates = preparation ? taskGraphTemplatesForSelectedJob(preparation)
    : automationCriteria ? taskGraphTemplatesForScheduledAutomation(input.taskGraphTemplates, automationCriteria)
      : input.taskGraphTemplates
  if (automationCriteria && !preparation && !templates?.scout) throw new Error("scheduled_automation_context_invalid")
  return {
    enabled: true, selectedJobMode: Boolean(preparation), selectedJobPreparation: preparation,
    templates: taskGraphTemplatesForApplicationFill(templates, applicationFill),
  }
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
