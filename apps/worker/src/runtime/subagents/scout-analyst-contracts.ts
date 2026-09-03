import type { ToolCapability, ToolRisk } from "@jobcopilot/agent-protocol"

export const MIGRATED_ROLES = ["scout", "analyst"] as const
export type MigratedRole = (typeof MIGRATED_ROLES)[number]

export const ROLE_TOOL_NAMES = [
  "jobs.search", "jobs.get", "persona.retrieve", "resume.get_base", "application.get_state",
] as const
export type RoleToolName = (typeof ROLE_TOOL_NAMES)[number]

export type RoleToolContract = {
  readonly name: RoleToolName
  readonly risk: "read"
  readonly domain: "jobs" | "persona" | "resume" | "application"
  readonly capabilities: readonly ["read"]
}

export type RoleContract = {
  readonly role: MigratedRole
  readonly capabilities: readonly ["read"]
  readonly allowedTools: readonly RoleToolName[]
  readonly forbiddenCapabilities: readonly ["write", "external_write", "browser"]
  readonly forbiddenRisks: readonly ["draft_write", "internal_write", "external_write"]
  readonly forbiddenTools: readonly string[]
}

const readTool = (name: RoleToolName, domain: RoleToolContract["domain"]): RoleToolContract => ({
  name, risk: "read", domain, capabilities: ["read"],
})

export const ROLE_TOOL_CONTRACTS: Readonly<Record<RoleToolName, RoleToolContract>> = {
  "jobs.search": readTool("jobs.search", "jobs"),
  "jobs.get": readTool("jobs.get", "jobs"),
  "persona.retrieve": readTool("persona.retrieve", "persona"),
  "resume.get_base": readTool("resume.get_base", "resume"),
  "application.get_state": readTool("application.get_state", "application"),
}

const commonContract = (role: MigratedRole, allowedTools: readonly RoleToolName[]): RoleContract => ({
  role,
  capabilities: ["read"],
  allowedTools,
  forbiddenCapabilities: ["write", "external_write", "browser"],
  forbiddenRisks: ["draft_write", "internal_write", "external_write"],
  forbiddenTools: [
    "application.draft", "application.submit", "resume.draft", "cover_letter.draft",
    "browser.fill", "browser.submit", "gmail.send", "send_message", "spawn_subagent", "wait_subagents",
  ],
})

export const SCOUT_ROLE_CONTRACT = commonContract("scout", ["jobs.search", "jobs.get"])
export const ANALYST_ROLE_CONTRACT = commonContract("analyst", [
  "jobs.search", "jobs.get", "persona.retrieve", "resume.get_base",
])

export function roleContract(role: MigratedRole): RoleContract {
  return role === "scout" ? SCOUT_ROLE_CONTRACT : ANALYST_ROLE_CONTRACT
}

export class RoleCapabilityError extends Error {
  constructor(readonly code: "role_unknown" | "tool_not_allowed" | "capability_denied" | "risk_denied", message: string) {
    super(message)
    this.name = "RoleCapabilityError"
  }
}

export function assertMigratedRole(role: string): asserts role is MigratedRole {
  if (!MIGRATED_ROLES.includes(role as MigratedRole)) throw new RoleCapabilityError("role_unknown", `Unsupported migrated role: ${role}`)
}

export function assertRoleToolAllowed(role: MigratedRole, tool: RoleToolContract): void {
  const contract = roleContract(role)
  if (!contract.allowedTools.includes(tool.name)) throw new RoleCapabilityError("tool_not_allowed", `${role} cannot use ${tool.name}`)
  if (tool.risk !== "read") throw new RoleCapabilityError("risk_denied", `${role} may only use read tools`)
  if (!tool.capabilities.every(capability => capability === "read")) {
    throw new RoleCapabilityError("capability_denied", `${role} may only use read capability tools`)
  }
}

export function assertRoleActionAllowed(role: MigratedRole, action: { readonly name: string; readonly risk: ToolRisk; readonly capabilities: readonly ToolCapability[] }): void {
  if (!ROLE_TOOL_NAMES.includes(action.name as RoleToolName)) throw new RoleCapabilityError("tool_not_allowed", `${role} cannot use ${action.name}`)
  if (action.risk !== "read") throw new RoleCapabilityError("risk_denied", `${role} may only use read tools`)
  if (!action.capabilities.every(capability => capability === "read")) throw new RoleCapabilityError("capability_denied", `${role} may only use read capability tools`)
  assertRoleToolAllowed(role, ROLE_TOOL_CONTRACTS[action.name as RoleToolName])
}
