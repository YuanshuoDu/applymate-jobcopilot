import type { SubagentRole } from "./role-contracts.js"

export type RoleModelProfile = {
  readonly provider: string
  readonly model: string
  readonly temperature: number
  readonly maxOutputTokens: number
}

export type RoleContextProfile = {
  readonly sources: readonly ("task" | "constraints" | "artifact" | "findings" | "evidence")[]
  readonly maxInputTokens: number
  readonly allowUntrustedArtifactText: boolean
}

export type SubagentRoleProfile = {
  readonly role: SubagentRole
  readonly model: RoleModelProfile
  readonly context: RoleContextProfile
}

const PROFILES: Readonly<Record<SubagentRole, SubagentRoleProfile>> = {
  writer: {
    role: "writer",
    model: { provider: "platform", model: "writer-default", temperature: 0.4, maxOutputTokens: 4096 },
    context: { sources: ["task", "constraints", "artifact"], maxInputTokens: 12_000, allowUntrustedArtifactText: true },
  },
  reviewer: {
    role: "reviewer",
    model: { provider: "platform", model: "reviewer-default", temperature: 0.1, maxOutputTokens: 3072 },
    context: { sources: ["task", "constraints", "artifact", "findings", "evidence"], maxInputTokens: 16_000, allowUntrustedArtifactText: true },
  },
}

export function roleProfile(role: SubagentRole): SubagentRoleProfile {
  const profile = PROFILES[role]
  return {
    ...profile,
    model: { ...profile.model },
    context: { ...profile.context, sources: [...profile.context.sources] },
  }
}
