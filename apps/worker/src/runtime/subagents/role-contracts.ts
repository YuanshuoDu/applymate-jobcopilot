export type SubagentRole = "writer" | "reviewer"

export type SubagentAction =
  | "artifact.read"
  | "artifact.draft.create"
  | "artifact.draft.replace"
  | "artifact.review"

export type SubagentRoleContract = {
  readonly role: SubagentRole
  readonly allowedActions: readonly SubagentAction[]
  readonly draftOnly: boolean
  readonly reviewOnly: boolean
  readonly canCreateDraft: boolean
  readonly canReview: boolean
  readonly canMutateArtifacts: boolean
  readonly canExecute: boolean
}

const CONTRACTS: Readonly<Record<SubagentRole, SubagentRoleContract>> = {
  writer: {
    role: "writer",
    allowedActions: ["artifact.read", "artifact.draft.create", "artifact.draft.replace"],
    draftOnly: true,
    reviewOnly: false,
    canCreateDraft: true,
    canReview: false,
    canMutateArtifacts: true,
    canExecute: false,
  },
  reviewer: {
    role: "reviewer",
    allowedActions: ["artifact.read", "artifact.review"],
    draftOnly: false,
    reviewOnly: true,
    canCreateDraft: false,
    canReview: true,
    canMutateArtifacts: false,
    canExecute: false,
  },
}

export class RoleContractError extends Error {
  constructor(readonly code: "invalid_role" | "action_denied" | "scope_denied", message: string) {
    super(message)
    this.name = "RoleContractError"
  }
}

export function roleContract(role: string): SubagentRoleContract {
  if (role !== "writer" && role !== "reviewer") throw new RoleContractError("invalid_role", `Unsupported subagent role: ${role}`)
  return CONTRACTS[role]
}

export function assertRoleAction(role: string, action: SubagentAction): void {
  const contract = roleContract(role)
  if (!contract.allowedActions.includes(action)) {
    throw new RoleContractError("action_denied", `${role} cannot perform ${action}`)
  }
}

export function assertTaskRole(taskRole: string, expected: SubagentRole): void {
  if (taskRole !== expected) throw new RoleContractError("scope_denied", `Expected a ${expected} task, received ${taskRole}`)
}

export function isSubagentRole(value: string): value is SubagentRole {
  return value === "writer" || value === "reviewer"
}
