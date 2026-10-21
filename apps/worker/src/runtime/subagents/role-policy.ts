import type { PolicyDomain, PolicyRole } from "@jobcopilot/agent-protocol"

import type { RuntimeToolDefinition, ToolRisk } from "../tools/types.js"

export type HarnessSubagentRole = "scout" | "analyst" | "prepare" | "writer" | "reviewer" | "auditor" | "executor"
export const APPLICATION_FILLER_ROLE = "application_filler" as const
export const APPLICATION_FILLER_TASK_TYPE = "application_fill_for_review" as const
export const APPLICATION_FILLER_TEMPLATE_ID = APPLICATION_FILLER_ROLE
type RegisteredSubagentRole = HarnessSubagentRole | typeof APPLICATION_FILLER_ROLE

export type SubagentRolePolicy = {
  readonly role: RegisteredSubagentRole
  readonly actorRole: PolicyRole
  readonly capabilities: readonly string[]
  readonly allowedRisks: readonly ToolRisk[]
  readonly allowedDomains: readonly PolicyDomain[]
  readonly canManageChildren: boolean
  readonly externalWritesEnabled: false
}

export type ApprovalReceiptHint = {
  readonly toolName: string
  readonly toolVersion: string
  readonly expiresAt: string
  readonly consumed?: boolean
}

export type ToolVisibilityReason =
  | "role_allowed"
  | "bounded_review_receipt_allowed"
  | "role_risk_denied"
  | "role_domain_denied"
  | "role_capability_denied"
  | "external_write_disabled"
  | "external_write_receipt_missing"
  | "external_write_receipt_invalid"
  | "coordination_disabled"
  | "root_only_tool"

export type ToolVisibility = {
  readonly visible: boolean
  readonly reason: ToolVisibilityReason
}

type RoleToolMetadata = Pick<RuntimeToolDefinition, "name" | "version" | "risk" | "domain" | "requiredCapabilities"> & {
  readonly capabilities?: readonly string[]
}

const READ_DOMAINS: readonly PolicyDomain[] = ["jobs", "persona", "resume", "application", "coordination", "unknown"]
const COORDINATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "spawn_subagent", "agent.spawn", "agent.followup",
  "send_message", "agent.send", "wait_subagents", "agent.wait",
  "list_subagents", "agent.list", "interrupt_subagent", "agent.interrupt",
  "close_subagent", "agent.close",
])

const POLICIES: Readonly<Record<RegisteredSubagentRole, SubagentRolePolicy>> = {
  scout: { role: "scout", actorRole: "subagent", capabilities: ["read"], allowedRisks: ["read"], allowedDomains: ["jobs"], canManageChildren: false, externalWritesEnabled: false },
  analyst: { role: "analyst", actorRole: "subagent", capabilities: ["read"], allowedRisks: ["read"], allowedDomains: ["jobs", "persona", "resume"], canManageChildren: false, externalWritesEnabled: false },
  prepare: { role: "prepare", actorRole: "subagent", capabilities: ["read"], allowedRisks: [], allowedDomains: ["resume"], canManageChildren: false, externalWritesEnabled: false },
  writer: { role: "writer", actorRole: "subagent", capabilities: ["read", "draft"], allowedRisks: ["read", "draft_write"], allowedDomains: ["resume"], canManageChildren: false, externalWritesEnabled: false },
  reviewer: { role: "reviewer", actorRole: "subagent", capabilities: ["read", "review"], allowedRisks: ["read"], allowedDomains: READ_DOMAINS, canManageChildren: false, externalWritesEnabled: false },
  auditor: { role: "auditor", actorRole: "subagent", capabilities: ["read", "auditEvidence"], allowedRisks: ["read"], allowedDomains: READ_DOMAINS, canManageChildren: false, externalWritesEnabled: false },
  executor: { role: "executor", actorRole: "subagent", capabilities: ["read", "preflight"], allowedRisks: ["read"], allowedDomains: ["application", "resume", "jobs", "persona", "unknown"], canManageChildren: false, externalWritesEnabled: false },
  application_filler: { role: APPLICATION_FILLER_ROLE, actorRole: "subagent", capabilities: [], allowedRisks: [], allowedDomains: [], canManageChildren: false, externalWritesEnabled: false },
}

export function getSubagentRolePolicy(role: string): SubagentRolePolicy | null {
  return Object.prototype.hasOwnProperty.call(POLICIES, role) ? POLICIES[role as RegisteredSubagentRole] : null
}

export function isHarnessSubagentRole(role: string): role is HarnessSubagentRole {
  return role !== APPLICATION_FILLER_ROLE && Object.prototype.hasOwnProperty.call(POLICIES, role)
}

export function isApplicationFillerTemplate(templateId: string, role: string, taskType: string): boolean {
  return templateId === APPLICATION_FILLER_TEMPLATE_ID
    && role === APPLICATION_FILLER_ROLE && taskType === APPLICATION_FILLER_TASK_TYPE
}

export function visibleToolPolicy(
  role: string,
  tool: RoleToolMetadata,
  receipt?: ApprovalReceiptHint,
): ToolVisibility {
  if (tool.name === "application.outcomes_summary") return { visible: false, reason: "root_only_tool" }
  const policy = getSubagentRolePolicy(role)
  if (!policy) return { visible: false, reason: "role_risk_denied" }
  if (COORDINATION_TOOL_NAMES.has(tool.name)) {
    return { visible: false, reason: "coordination_disabled" }
  }
  if (tool.risk === "external_write" || tool.capabilities?.includes("external_write") || looksLikeExternalAction(tool.name)) {
    if (!policy.externalWritesEnabled) return { visible: false, reason: "external_write_disabled" }
    if (!receipt) return { visible: false, reason: "external_write_receipt_missing" }
    if (receipt.consumed || Date.parse(receipt.expiresAt) <= Date.now()) return { visible: false, reason: "external_write_receipt_invalid" }
  }
  const boundedReviewReceipt = role === "reviewer" && tool.name === "artifact.review" && tool.version === "1"
    && tool.risk === "draft_write" && tool.domain === "resume"
    && exactCapabilities(tool.capabilities, ["read", "write"])
    && tool.requiredCapabilities.length === 0
  const boundedScheduledPrepareWrite = isExactScheduledPrepareWrite(role, tool)
  if (tool.name === "artifact.review" && !boundedReviewReceipt) return { visible: false, reason: "role_risk_denied" }
  const boundedDiscoveryWrite = isExactScoutDiscoveryWrite(role, tool)
  if (tool.name === "jobs.discover" && !boundedDiscoveryWrite) return { visible: false, reason: "role_risk_denied" }
  if (tool.name === "scheduled.application.prepare" && !boundedScheduledPrepareWrite) return { visible: false, reason: "role_risk_denied" }
  if (!policy.allowedRisks.includes(tool.risk) && !boundedReviewReceipt && !boundedDiscoveryWrite && !boundedScheduledPrepareWrite) return { visible: false, reason: "role_risk_denied" }
  if (!policy.allowedDomains.includes(tool.domain)) return { visible: false, reason: "role_domain_denied" }
  if (tool.requiredCapabilities.some(capability => !policy.capabilities.includes(capability))) return { visible: false, reason: "role_capability_denied" }
  return { visible: true, reason: boundedReviewReceipt ? "bounded_review_receipt_allowed" : "role_allowed" }
}

export function visibleSubagentTools(
  role: string,
  tools: readonly RuntimeToolDefinition[],
  receipt?: ApprovalReceiptHint,
): RuntimeToolDefinition[] {
  return tools.filter(tool => visibleToolPolicy(role, tool, receipt).visible)
}

export type PreflightDecision = {
  readonly role: string
  readonly toolName: string
  readonly toolVersion: string
  readonly allowed: boolean
  readonly execute: false
  readonly externalWriteBlocked: boolean
  readonly receiptPresent: boolean
  readonly reasonCode: ToolVisibilityReason
}

export function preflightSubagentTool(
  role: string,
  tool: (RoleToolMetadata & Pick<RuntimeToolDefinition, "version">) | null,
  receipt?: ApprovalReceiptHint,
): PreflightDecision {
  const decision = tool ? visibleToolPolicy(role, tool, receipt) : { visible: false, reason: "role_risk_denied" as const }
  return {
    role,
    toolName: tool?.name ?? "unknown",
    toolVersion: tool?.version ?? "unknown",
    allowed: decision.visible,
    execute: false,
    externalWriteBlocked: tool?.risk === "external_write" || tool?.capabilities?.includes("external_write") || looksLikeExternalAction(tool?.name ?? "") || false,
    receiptPresent: Boolean(receipt),
    reasonCode: decision.reason,
  }
}

function looksLikeExternalAction(name: string): boolean {
  return /(?:^|[._-])(submit|send|publish|delete|mutate|execute)(?:$|[._-])/i.test(name)
}

function isExactScoutDiscoveryWrite(role: string, tool: RoleToolMetadata): boolean {
  return role === "scout" && tool.name === "jobs.discover" && tool.version === "1"
    && tool.risk === "internal_write" && tool.domain === "jobs"
    && exactCapabilities(tool.capabilities, ["read", "write"])
    && exactCapabilities(tool.requiredCapabilities, ["read"])
}

function isExactScheduledPrepareWrite(role: string, tool: RoleToolMetadata): boolean {
  return role === "prepare" && tool.name === "scheduled.application.prepare" && tool.version === "1"
    && tool.risk === "draft_write" && tool.domain === "resume"
    && exactCapabilities(tool.capabilities, ["read", "write"])
    && tool.requiredCapabilities.length === 0
}

function exactCapabilities(actual: readonly string[] | undefined, expected: readonly string[]): boolean {
  return Boolean(actual && actual.length === expected.length && expected.every(capability => actual.includes(capability)))
}
