import type { PolicyDomain, PolicyRole } from "@jobcopilot/agent-protocol"

import type { RuntimeToolDefinition, ToolRisk } from "../tools/types.js"

export type HarnessSubagentRole = "scout" | "analyst" | "writer" | "reviewer" | "auditor" | "executor"

export type SubagentRolePolicy = {
  readonly role: HarnessSubagentRole
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
  | "role_risk_denied"
  | "role_domain_denied"
  | "role_capability_denied"
  | "external_write_disabled"
  | "external_write_receipt_missing"
  | "external_write_receipt_invalid"

export type ToolVisibility = {
  readonly visible: boolean
  readonly reason: ToolVisibilityReason
}

type RoleToolMetadata = Pick<RuntimeToolDefinition, "name" | "risk" | "domain" | "requiredCapabilities"> & {
  readonly capabilities?: readonly string[]
}

const READ_DOMAINS: readonly PolicyDomain[] = ["jobs", "persona", "resume", "application", "coordination", "unknown"]

const POLICIES: Readonly<Record<HarnessSubagentRole, SubagentRolePolicy>> = {
  scout: { role: "scout", actorRole: "subagent", capabilities: ["read"], allowedRisks: ["read"], allowedDomains: ["jobs"], canManageChildren: false, externalWritesEnabled: false },
  analyst: { role: "analyst", actorRole: "subagent", capabilities: ["read"], allowedRisks: ["read"], allowedDomains: ["jobs", "persona", "resume"], canManageChildren: false, externalWritesEnabled: false },
  writer: { role: "writer", actorRole: "subagent", capabilities: ["read", "draft"], allowedRisks: ["read", "draft_write"], allowedDomains: ["resume"], canManageChildren: false, externalWritesEnabled: false },
  reviewer: { role: "reviewer", actorRole: "subagent", capabilities: ["read", "review"], allowedRisks: ["read"], allowedDomains: READ_DOMAINS, canManageChildren: false, externalWritesEnabled: false },
  auditor: { role: "auditor", actorRole: "subagent", capabilities: ["read", "auditEvidence"], allowedRisks: ["read"], allowedDomains: READ_DOMAINS, canManageChildren: false, externalWritesEnabled: false },
  executor: { role: "executor", actorRole: "subagent", capabilities: ["read", "preflight"], allowedRisks: ["read"], allowedDomains: ["application", "resume", "jobs", "persona", "unknown"], canManageChildren: false, externalWritesEnabled: false },
}

export function getSubagentRolePolicy(role: string): SubagentRolePolicy | null {
  return isHarnessSubagentRole(role) ? POLICIES[role] : null
}

export function isHarnessSubagentRole(role: string): role is HarnessSubagentRole {
  return role in POLICIES
}

export function visibleToolPolicy(
  role: string,
  tool: RoleToolMetadata,
  receipt?: ApprovalReceiptHint,
): ToolVisibility {
  const policy = getSubagentRolePolicy(role)
  if (!policy) return { visible: false, reason: "role_risk_denied" }
  if (tool.risk === "external_write" || tool.capabilities?.includes("external_write") || looksLikeExternalAction(tool.name)) {
    if (!policy.externalWritesEnabled) return { visible: false, reason: "external_write_disabled" }
    if (!receipt) return { visible: false, reason: "external_write_receipt_missing" }
    if (receipt.consumed || Date.parse(receipt.expiresAt) <= Date.now()) return { visible: false, reason: "external_write_receipt_invalid" }
  }
  if (!policy.allowedRisks.includes(tool.risk)) return { visible: false, reason: "role_risk_denied" }
  if (!policy.allowedDomains.includes(tool.domain)) return { visible: false, reason: "role_domain_denied" }
  if (tool.requiredCapabilities.some(capability => !policy.capabilities.includes(capability))) return { visible: false, reason: "role_capability_denied" }
  return { visible: true, reason: "role_allowed" }
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
