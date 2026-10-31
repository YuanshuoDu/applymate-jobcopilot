import { Type } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"
import { redactSensitiveText } from "@jobcopilot/shared"
import { TASK_GRAPH_LIMITS, type TaskGraphProposal } from "../planning/task-graph.js"
import {
  TaskGraphProposalInputSchema,
  buildTaskGraphProposalInputSchema,
  normalizeTaskGraphPlanningNodes,
  parseTaskGraphPlanningReplacementModes,
  type TaskGraphProposalInput,
} from "./task-graph-planning-input.js"
import { TASK_GRAPH_VERIFICATION_LIMITS, TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import type { TaskGraphObjectiveCoverageRejection } from "../planning/task-graph-objective-coverage.js"
import type { RootTaskVerificationRequirementsResolution } from "../context/root-task-objective.js"
import type {
  TaskGraphCommandPort,
  TaskGraphScheduleReceipt,
  TaskGraphTaskTemplate,
} from "../subagents/task-graph-command-port.js"
import { normalizeRootPlanCriteria } from "../subagents/root-plan-criteria.js"

import { ToolExecutionError, type RuntimeToolDefinition, type ToolExecutionContext } from "./types.js"
import { createSteeringReconciliationTool, steeringReconciliationOperation, type ReconciliationFenceOptions } from "./steering-reconciliation.js"
export { TaskGraphProposalInputSchema }

export type { TaskGraphProposalInput } from "./task-graph-planning-input.js"

export type PlanningExecutorOptions = ReconciliationFenceOptions & Readonly<{
  commandPort: TaskGraphCommandPort
  templates: Readonly<Record<string, TaskGraphTaskTemplate>>
  verificationRequirements?: RootTaskVerificationRequirementsResolution
}>

export type PlanningRegistrationOptions = ReconciliationFenceOptions & Readonly<{
  commandPort?: TaskGraphCommandPort
  templates?: Readonly<Record<string, TaskGraphTaskTemplate>>
  verificationRequirements?: RootTaskVerificationRequirementsResolution
}>
export type TaskGraphToolRegistry = Readonly<{ register?(definition: RuntimeToolDefinition): void }>
const MAX_PROPOSAL_BYTES = TASK_GRAPH_LIMITS.maxProposalBytes
const MIN_CONTINUATION_STEPS = 2

const Id = Type.String({ minLength: 1, maxLength: 256 })
const TaskStatusSchema = Type.Union([
  Type.Literal("queued"), Type.Literal("waiting"),
])
const ReceiptSchema = Type.Object({
  status: Type.Union([Type.Literal("accepted"), Type.Literal("duplicate")]),
  revision: Type.Integer({ minimum: 0 }),
  nodes: Type.Array(Type.Object({ key: Id, taskId: Id, status: TaskStatusSchema }, { additionalProperties: false })),
  readyTaskIds: Type.Array(Id),
}, { additionalProperties: false })

function scheduleErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(error.code)) {
    return error.code
  }
  return "task_graph_schedule_failed"
}

function safeCoverageRequirements(value: unknown): readonly TaskGraphObjectiveCoverageRejection[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > TASK_GRAPH_VERIFICATION_LIMITS.maxCriteria) return undefined
  const safe: TaskGraphObjectiveCoverageRejection[] = []
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined
    const row = item as Record<string, unknown>
    const kind = row.kind
    const role = kind === "candidate_count_gte" ? "scout" : kind === "finding_count_gte" ? "analyst" : undefined
    if (!role || Object.keys(row).sort().join(",") !== "id,kind,minimum,role" || typeof row.id !== "string"
      || !/^[a-z][a-z0-9._-]{0,63}$/.test(row.id) || row.role !== role
      || !Number.isSafeInteger(row.minimum) || typeof row.minimum !== "number" || row.minimum < 1
      || row.minimum > TASK_GRAPH_VERIFICATION_LIMITS.maxItems) return undefined
    safe.push({ id: row.id, kind: kind as TaskGraphObjectiveCoverageRejection["kind"], role, minimum: row.minimum })
  }
  return safe
}

function safeScheduleError(error: unknown, code: string): Readonly<{ code: string; currentRevision?: number; requirements?: readonly TaskGraphObjectiveCoverageRejection[] }> {
  if (code === "task_graph_objective_coverage_incomplete") {
    const requirements = error && typeof error === "object" && "requirements" in error
      ? safeCoverageRequirements(error.requirements) : undefined
    return requirements ? { code, requirements } : { code }
  }
  if (code !== "revision_mismatch" && code !== "task_graph_revision_mismatch") return { code }
  if (!error || typeof error !== "object" || !("currentRevision" in error)) return { code }
  const currentRevision = error.currentRevision
  return Number.isSafeInteger(currentRevision) && typeof currentRevision === "number" && currentRevision >= 0
    ? { code, currentRevision }
    : { code }
}

export function createTaskGraphPlanningTool(options: PlanningExecutorOptions): RuntimeToolDefinition {
  const templates = Object.entries(options.templates).sort(([left], [right]) => left.localeCompare(right))
  if (templates.length === 0) throw new Error("task_graph_templates_unavailable")
  const templateIdSchema = Type.Union(templates.map(([templateId]) => Type.Literal(templateId)))
  const templateCatalog = templates.map(([templateId, template]) => {
    const actions = template.allowedActions.map(action => JSON.stringify(action)).join(", ") || "none"
    return `- ${JSON.stringify(templateId)}: role ${JSON.stringify(template.role)}; allowed actions: ${actions}`
  }).join("\n")
  const selectedJobWriterGuidance = templates.some(([id, template]) => id === "cover_letter_writer" && template.role === "writer")
    && templates.some(([id, template]) => id === "cover_letter_reviewer" && template.role === "reviewer")
    ? " Writer and Reviewer nodes use their specialized gates and omit verification and repairOf. For a selected-job cover letter, plan one cover_letter_writer first. If its completed Reviewer dependency reports needs_revision, you may append exactly one cover_letter_writer directly after that Reviewer in a later plan; do not loop or reuse that review for a second successful revision. A fresh review is required after the revision. Root decides whether to plan this follow-up; the Worker does not schedule it automatically."
    : ""
  const execute: RuntimeToolDefinition["execute"] = async (context, value) => {
    const remainingSteps = context.remainingTurnSteps
    if (remainingSteps === undefined || !Number.isSafeInteger(remainingSteps) || remainingSteps < MIN_CONTINUATION_STEPS) {
      // Preserve one root step to establish the durable wait and one to evaluate results after wake.
      const code = "task_graph_continuation_budget_required"
      throw new ToolExecutionError(code, "The Turn needs two remaining steps to supervise a TaskGraph plan", { code, requiredSteps: MIN_CONTINUATION_STEPS })
    }
    const input = value as TaskGraphProposalInput
    const parsedModes = parseTaskGraphPlanningReplacementModes(input)
    if (!parsedModes.ok) {
      throw new ToolExecutionError(parsedModes.code, "Choose one valid replacement mode and provide its exact source mapping", { code: parsedModes.code })
    }
    const modes = parsedModes.value
    const rootSuccessCriteria = normalizeRootPlanCriteria(input.rootSuccessCriteria)
    if (rootSuccessCriteria === null) {
      const code = "task_graph_root_criteria_invalid"
      throw new ToolExecutionError(code, "Additional root acceptance criteria must be one to four bounded, non-empty statements", { code })
    }
    const encoded = JSON.stringify(input)
    if (!encoded || Buffer.byteLength(encoded, "utf8") > MAX_PROPOSAL_BYTES) {
      throw new ToolExecutionError("task_graph_proposal_too_large", "TaskGraph proposal exceeds the bounded request size", { code: "task_graph_proposal_too_large", maxBytes: MAX_PROPOSAL_BYTES })
    }
    if (input.nodes.some(node => redactSensitiveText(node.key) !== node.key)) {
      throw new ToolExecutionError("task_graph_sensitive_key_rejected", "TaskGraph keys cannot contain contact or credential data")
    }
    const reconciliation = steeringReconciliationOperation(context, options, "revise", input.expectedRevision)
    const operation = {
      ...reconciliation,
      ...(modes.replaceUnstarted ? { replaceUnstartedNodeKey: modes.replaceUnstarted.nodeKey } : {}),
      ...(modes.replaceBranch ? { replaceBranch: modes.replaceBranch } : {}),
      ...(modes.replaceOperationalFailure ? { replaceOperationalFailure: modes.replaceOperationalFailure } : {}),
    }
    const scope = operation.scope
    const normalizedNodes = normalizeTaskGraphPlanningNodes(input.nodes, scope.rootTaskId)
    if (!normalizedNodes.ok) throw new ToolExecutionError("task_graph_repair_root_mismatch",
      "The repair target does not belong to the active root task", { code: "task_graph_repair_root_mismatch" })
    const proposal: TaskGraphProposal = { expectedRevision: input.expectedRevision, nodes: normalizedNodes.nodes }
    try {
      if (typeof options.commandPort.appendAndScheduleWithReconciliation !== "function") {
        throw new ToolExecutionError("steering_reconciliation_unavailable", "TaskGraph revision requires an atomic reconciliation-capable port")
      }
      const receipt = await options.commandPort.appendAndScheduleWithReconciliation({
        scope,
        proposal,
        ...(rootSuccessCriteria === undefined ? {} : { rootSuccessCriteria }),
        templates: options.templates,
        verificationRequirements: options.verificationRequirements ?? { status: "absent" },
        ...(modes.replaceUnstarted ? {
          replaceUnstarted: { nodeKey: modes.replaceUnstarted.nodeKey },
        } : {}),
        ...(modes.replaceBranch ? { replaceBranch: modes.replaceBranch } : {}),
        ...(modes.replaceOperationalFailure ? { replaceOperationalFailure: modes.replaceOperationalFailure } : {}),
      }, operation)
      return receipt
    } catch (error: unknown) {
      if (error instanceof ToolExecutionError) throw error
      const code = scheduleErrorCode(error)
      throw new ToolExecutionError(code, "TaskGraph proposal could not be durably scheduled", safeScheduleError(error, code))
    }
  }
  return {
    schemaVersion,
    name: "agent.plan",
    version: "1",
    description: `For non-trivial goals, call agent.plan before executing child work. Optional rootSuccessCriteria adds one to four bounded, untrusted acceptance requirements; the server prepends the complete original human objective as a mandatory criterion. Omitting the field preserves current behavior; it grants no proof, permission, or completion authority.
Scout and Analyst nodes must include verification {schemaVersion:"${TASK_GRAPH_VERIFICATION_SCHEMA_VERSION}",role,criteria:[{id,check}]}; IDs are stable lowercase identifiers. Allowed checks: candidate_count_gte, finding_count_gte, evidence_count_gte, all_candidates_have_evidence, all_findings_have_evidence, reported_score_gte, findings_from_scout_dependency, findings_cover_scout_candidates_gte, findings_from_scout_union, findings_cover_scout_candidate_union_gte, findings_cover_each_scout_candidates_gte. Use only checks allowed for that role.
findings_from_scout_dependency is Analyst-only and names a direct Scout dependency by dependencyNodeKey. findings_cover_scout_candidates_gte is Analyst-only; use it only when the plan explicitly declares a cohort percentage, with a direct Scout dependency and minimumPercent from 1 to 100. Omitting it preserves normal top-N selection; do not infer a percentage or require processing of every candidate. findings_from_scout_union is Analyst-only and selects 2 to 8 unique direct typed Scout keys; it requires nonempty findings and a nonempty deduplicated candidate union, and every finding must belong to that selected group. findings_cover_scout_candidate_union_gte uses its own selected group and requires nonempty findings and a nonempty deduplicated candidate union; minimumPercent is 1 to 100. Each union criterion selects its own group, and coverage is aggregate across unique candidates; it does not guarantee contribution from each source. findings_cover_each_scout_candidates_gte is Analyst-only and optional; it selects 2 to 8 unique direct typed Scouts and applies the declared 1 to 100 integer minimumPercent independently to each source. Use it only when the goal explicitly requires per-source coverage; do not infer or impose source quotas for a general goal. Every selected source must have candidates; a shared candidate counts for each source that returned it, so this measures candidate-ID coverage rather than distinct source provenance; every finding must belong to the selected union. Coverage uses exact integer cross-multiplication without rounding. Neither coverage check proves score correctness. Never use an unselected Scout to satisfy a criterion. For the canonical scheduled flow, use 2 to 4 direct typed Scouts followed by one Analyst; its membership check must list every direct Scout. Reserve four graph slots for Analyst, Prepare, Gate, and Audit. With maxFanOut=4, propose four Scouts first and append the Analyst in a later plan. Keep every Scout's scheduled roles and locations unchanged; source, page-size, and cursor selectors may differ. The full deduplicated source union is proof metadata up to 200 candidates, while only the explicit Analyst-selected set of at most 50 job IDs is used for Analyze and Prepare. An all-empty multi-Scout union is unsupported.
A repair uses repairOf={nodeKey,taskId,criterionIds} for a prior typed same-template node; omit graphRootTaskId because the server binds the active Root. A matching legacy graphRootTaskId is accepted, but a mismatch is rejected. Repeat exactly those criteria and checks, and must not add the target to dependsOn; this relation does not pass the target or alter its verdict. successCriteria prose is explanatory and never proof. reported_score_gte checks an Analyst-reported number, not its correctness. ${selectedJobWriterGuidance}
When new information changes an unstarted Scout/Analyst approach, refresh the owner-scoped current TaskGraph and current Step agenda; use that graph revision as expectedRevision. For a branch of at least two sources, send replaceBranch: { root: { nodeKey, taskId }, sources: [{ nodeKey, taskId, replacementKey }, ...] }.
For a server-reported resume_state_unavailable failure on a fixed typed read-only Scout or Analyst, use replaceOperationalFailure: { root: { nodeKey, taskId }, sources: [{ nodeKey, taskId, replacementKey }, ...] }. Include the failed root and its complete transitive descendant closure, even for a failed leaf (one source); propose exactly one fresh same-template typed node per mapping. Only pristine unstarted read-only descendants can be replaced. Preserve each source's successCriteria and exact verification IDs/checks; keep successCriteria canonical and each check's IDs, kinds, thresholds, and aggregations unchanged; you may update its goal. In replacement nodes, remap dependsOn edges, scalar dependencyNodeKey selectors, and each mapped key in dependencyNodeKeys arrays. Preserve selector-array order and references outside the source-to-replacement mapping. The server proves the failure and cancels eligible descendants; never supply a failure reason, status, proof, or claim that the old work passed. Replacements inherit no evidence or authorization, and consumed usage is not refunded.
For a server-reported execution_deadline_exceeded cue for an eligible started typed Scout or Analyst, you may make the same explicit replaceOperationalFailure proposal. The cue is advisory only and grants no authority; the server independently verifies the current owner, attempt, lifecycle, durable receipt, persisted deadline, and budget before accepting it. The cue itself is not proof. Never supply a failure reason, status, or proof.
List the exact root and every node in its transitive dependsOn descendant closure in sources, mapping each source once to a fresh replacementKey and providing one fresh node per mapping. For replaceBranch, you may revise node goals and explanatory criteria; preserve topology, registered roles, exact typed verification IDs/checks, and retained edges; remap scalar dependencyNodeKey selectors and internal dependencyNodeKeys array entries, preserving authored order and references outside the mapping. Keep canonical Root criteria unchanged.
replaceBranch, replaceUnstarted, and replaceOperationalFailure are mutually exclusive. For ordinary unstarted replanning, every source must be queued or dependency-waiting with attemptCount=0 and no lease, execution, wait condition, result, artifact, evidence, or reservation; never include running, completed, attempted, or genuinely waiting work.
To retire a failed strategy, use one explicit complete branch request only when its root is a persisted failed ordinary typed Scout and every descendant is queued or dependency-waiting with attemptCount=0 and no lease, execution, wait condition, result, or evidence. The server preserves the failed Scout and atomically cancels eligible descendants as part of this plan before scheduling fresh mapped replacements; failure alone does not cancel them. Use repairOf for an ordinary criterion retry when the strategy remains sound; this branch operation is for changing the failed approach. Every ancestor outside the closure must be an ordinary typed node completed and verified before the Scout failure; repairOf ancestors are unsupported. Do not use this for intentional/user cancellation, Root-failure cleanup, ordinary criterion repair, or ambiguous provenance; the server derives eligibility from persisted task/event history, not a model-supplied failure label. Old task rows and results remain history, replacements inherit no evidence, and consumed execution usage is not refunded; reused slots are current-snapshot capacity only.
A distinct replan uses a fresh model Step with the current graph and agenda revision; after new information, it does not require another human message. The server still requires two Root steps for the durable wait/result cycle.
TaskGraph maxNodes is an eight-node limit on the current graph snapshot, including retained terminal nodes, not a lifetime task-creation cap; it is separate from active-child maxFanOut. At most seven Scout nodes plus one Analyst fit before counting any other retained nodes, so leave capacity for the rest of the graph. Read current owner-scoped task_graph_current.nodeCapacity: remaining is current-snapshot space; ordinaryRemaining is the ordinary-addition budget while reserveActive is true. Existing cumulative Root execution usage and reservations remain in force; canceled work never refunds consumed usage.
Before the first accepted typed repair, preserve one global final current-snapshot slot for a valid failed-target criterion repair. A proposal containing that exact repair may use the reserve in any node order but must fit remaining; the server validates the current failed target and unresolved criteria. An accepted repair consumes the reserve even while queued or if it later fails; it does not pass a criterion or promise another retry. Refresh current state and use remaining honestly; do not spend the reserve with agent.spawn or agent.followup.
If agent.plan returns task_graph_repair_conflict, inspect or refresh the current owner-scoped graph. If an overlapping repair is active, wait for it to become terminal and retry only if the criterion remains unresolved and capacity permits; if none is active, correct the rejected batch so each target/criterion has only one proposed attempt. An active repair is not evidence of success.
Wait for children, inspect their evidence, then replan or complete the goal. Registered templates:
${templateCatalog}`,
    capabilities: ["coordination"],
    inputSchema: buildTaskGraphProposalInputSchema(templateIdSchema, templates),
    outputSchema: ReceiptSchema,
    risk: "internal_write",
    domain: "coordination",
    idempotency: "idempotent",
    timeoutMs: 30_000,
    requiredCapabilities: ["coordination", "canManageChildren"],
    execute,
  }
}
export function registerTaskGraphPlanningTool(
  registry: TaskGraphToolRegistry,
  enabled: boolean,
  options: PlanningRegistrationOptions,
): void {
  if (!enabled) return
  if (!options.commandPort || !options.templates || Object.keys(options.templates).length === 0 || !registry.register) throw new Error("task_graph_runtime_dependencies_unavailable")
  registry.register(createTaskGraphPlanningTool({ ...options, commandPort: options.commandPort, templates: options.templates }))
  if (typeof options.commandPort.reconcileSteering === "function") {
    registry.register(createSteeringReconciliationTool(options.commandPort, options))
  }
}
