import type { PolicyRule, PolicySnapshot } from "@jobcopilot/agent-protocol"
import { PolicyEngine } from "@jobcopilot/agent-policy"
import { ROLE_RESULT_SCHEMA, type StructuredRole } from "./role-results.js"
import { getSubagentRolePolicy } from "./role-policy.js"
import { canManageChildrenWithWaitAction } from "./child-executor-admission.js"
import type { SubagentTaskRecord } from "./types.js"

const SCHEDULED_PREPARE_TOOL = "scheduled.application.prepare"
const SCHEDULED_PREPARE_TASK_TYPE = "scheduled_application_prepare"
const SUBAGENT_READ_RULE = {
  id: "canonical-subagent-read",
  roles: ["subagent"], risks: ["read"], requiredCapabilities: ["read"],
  outcome: "allow", reasonCode: "server_subagent_read_gate", reason: "The server enabled scoped child read tools",
} satisfies PolicyRule
const SUBAGENT_INTERNAL_WRITE_DENY = {
  id: "canonical-subagent-internal-write-deny", roles: ["subagent"], risks: ["internal_write"], outcome: "deny",
  reasonCode: "server_subagent_internal_write_denied", reason: "Subagents may use only the exact server-enabled discovery write",
} satisfies PolicyRule
const SCOUT_DISCOVERY_WRITE_RULE = {
  id: "canonical-scout-job-discovery-write", roles: ["subagent"], tools: ["jobs.discover"], toolVersions: ["1"],
  risks: ["internal_write"], domains: ["jobs"], requiredCapabilities: ["read"], outcome: "allow",
  reasonCode: "server_scout_job_discovery_write", reason: "The server enabled bounded provider discovery for a generic Scout",
} satisfies PolicyRule
const SCHEDULED_PREPARE_WRITE_RULE = {
  id: "canonical-scheduled-application-prepare-write",
  roles: ["subagent"], tools: [SCHEDULED_PREPARE_TOOL], toolVersions: ["1"],
  risks: ["draft_write"], domains: ["resume"], requiredCapabilities: ["read"], outcome: "allow",
  reasonCode: "server_scheduled_application_prepare_write",
  reason: "The server enabled the exact scheduled application preparation tool",
} satisfies PolicyRule
const SCHEDULED_PREPARE_VARIANT_DENY = {
  id: "canonical-scheduled-application-prepare-variant-deny",
  roles: ["subagent"], tools: [SCHEDULED_PREPARE_TOOL], outcome: "deny",
  reasonCode: "server_scheduled_application_prepare_variant_denied",
  reason: "Subagents may use only the exact server-enabled scheduled application preparation tool",
} satisfies PolicyRule
const DURABLE_CHILD_WAIT_ALLOW = {
  id: "canonical-durable-child-wait",
  roles: ["subagent"], tools: ["wait_subagents"], toolVersions: ["1"],
  risks: ["internal_write"], domains: ["coordination"], outcome: "allow",
  reasonCode: "server_durable_child_wait", reason: "The server enabled the exact durable child wait tool",
} satisfies PolicyRule

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function selectedJobPolicyRule(role: string, selectedJob: boolean): PolicyRule | undefined {
  if (!selectedJob) return undefined
  if (role === "writer") return {
    id: "canonical-selected-job-cover-letter-draft",
    roles: ["subagent"], tools: ["cover_letter.draft"], toolVersions: ["1"], risks: ["draft_write"], domains: ["resume"], requiredCapabilities: ["draft"],
    outcome: "allow", reasonCode: "server_selected_job_draft_gate", reason: "The server enabled the selected-job cover-letter draft tool",
  }
  if (role === "reviewer") return {
    id: "canonical-selected-job-artifact-review",
    roles: ["subagent"], tools: ["artifact.review"], toolVersions: ["1"], risks: ["draft_write"], domains: ["resume"], requiredCapabilities: ["review"],
    outcome: "allow", reasonCode: "server_selected_job_review_gate", reason: "The server enabled the bounded selected-job review receipt",
  }
  return undefined
}

export function createProductionChildPolicy(task: Pick<SubagentTaskRecord, "role" | "taskType" | "toolPolicySnapshot"> & Partial<Pick<SubagentTaskRecord, "allowedActions">>, selectedJob: boolean): PolicyEngine {
  const snapshot = record(task.toolPolicySnapshot)
  const hasMatrixField = Object.prototype.hasOwnProperty.call(snapshot, "version") || Object.prototype.hasOwnProperty.call(snapshot, "rules")
  const configured = typeof snapshot.version === "string" && Array.isArray(snapshot.rules)
    ? snapshot as unknown as PolicySnapshot
    : undefined
  if (hasMatrixField && !configured) return new PolicyEngine()
  const configuredRules = configured?.rules ?? []
  const explicitDiscoveryDenies = configuredRules.filter(rule => rule.outcome === "deny" && rule.roles.includes("subagent") && rule.tools?.includes("jobs.discover"))
  const explicitPrepareDenies = task.role === "prepare"
    ? configuredRules.filter(rule => rule.outcome === "deny" && rule.roles.includes("subagent")
      && (!rule.tools || rule.tools.includes(SCHEDULED_PREPARE_TOOL)))
    : []
  const explicitWaitDenies = configuredRules.filter(rule => rule.outcome === "deny" && rule.roles.includes("subagent")
    && rule.tools?.includes("wait_subagents"))
  const priorityDenies = [...new Set([...explicitDiscoveryDenies, ...explicitPrepareDenies, ...explicitWaitDenies])]
  const remainingConfiguredRules = configuredRules.filter(rule => !priorityDenies.includes(rule))
  const discoveryRule = task.role === "scout" && !selectedJob ? [SCOUT_DISCOVERY_WRITE_RULE] : []
  const prepareRule = task.role === "prepare" && task.taskType === SCHEDULED_PREPARE_TASK_TYPE ? [SCHEDULED_PREPARE_WRITE_RULE] : []
  const taskRule = selectedJobPolicyRule(task.role, selectedJob)
  const waitRule = canManageChildrenWithWaitAction(getSubagentRolePolicy(task.role), task.allowedActions) ? [DURABLE_CHILD_WAIT_ALLOW] : []
  const rules: PolicyRule[] = [
    ...priorityDenies, ...discoveryRule, ...waitRule, SUBAGENT_INTERNAL_WRITE_DENY,
    ...prepareRule, SCHEDULED_PREPARE_VARIANT_DENY,
    ...remainingConfiguredRules, SUBAGENT_READ_RULE, ...(taskRule ? [taskRule] : []),
  ]
  return new PolicyEngine({ snapshot: { version: configured?.version ?? "policy.v1", rules } })
}

/** Selects the structured output contract only when the lease marker is an exact server-owned role marker. */
export function expectedStructuredRole(value: unknown, leasedRole: string): StructuredRole | undefined {
  if (leasedRole !== "scout" && leasedRole !== "analyst" && leasedRole !== "writer" && leasedRole !== "reviewer" && leasedRole !== "prepare" || !value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const marker = value as Record<string, unknown>
    const prototype = Object.getPrototypeOf(value)
    if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length > 0) return undefined
    if (Object.keys(marker).length !== 2 || marker.schemaVersion !== ROLE_RESULT_SCHEMA || marker.role !== leasedRole) return undefined
    return leasedRole
  } catch {
    return undefined
  }
}
