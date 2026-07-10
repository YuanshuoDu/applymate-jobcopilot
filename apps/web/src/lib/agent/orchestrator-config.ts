import type { Prisma } from '@prisma/client'
import type { AgentConfigFull } from './types'

const NUMBER_FIELDS = ['dailyLimit', 'minMatchScore', 'throttleMs'] as const
const BOOLEAN_FIELDS = ['autoApply', 'requireApproval', 'autoCoverLetter', 'useTailoredCV'] as const
const STRING_FIELDS = ['model', 'coverTone'] as const
const STRING_ARRAY_FIELDS = ['targetLocations', 'targetRoles', 'excludeCompanies', 'priorityCompanies'] as const

export type AgentConfigPatch = Partial<Pick<AgentConfigFull,
  | typeof NUMBER_FIELDS[number]
  | typeof BOOLEAN_FIELDS[number]
  | typeof STRING_FIELDS[number]
  | typeof STRING_ARRAY_FIELDS[number]
>>

export function agentConfigPatchFrom(input: Record<string, unknown>): AgentConfigPatch {
  const patch: AgentConfigPatch = {}

  for (const field of NUMBER_FIELDS) {
    const value = input[field]
    if (typeof value === 'number' && Number.isFinite(value)) patch[field] = value
  }
  for (const field of BOOLEAN_FIELDS) {
    const value = input[field]
    if (typeof value === 'boolean') patch[field] = value
  }
  for (const field of STRING_FIELDS) {
    const value = input[field]
    if (typeof value === 'string') patch[field] = value
  }
  for (const field of STRING_ARRAY_FIELDS) {
    const value = input[field]
    if (Array.isArray(value) && value.every(item => typeof item === 'string')) patch[field] = value
  }

  return patch
}

export function applyAgentConfigPatch(agentCfg: AgentConfigFull, patch: AgentConfigPatch): string[] {
  const changes: string[] = []
  for (const [key, value] of Object.entries(patch) as Array<[keyof AgentConfigPatch, AgentConfigPatch[keyof AgentConfigPatch]]>) {
    if (value === undefined) continue
    Object.assign(agentCfg, { [key]: value })
    changes.push(`${String(key)}=${JSON.stringify(value)}`)
  }
  return changes
}

export function prismaAgentConfigPatch(patch: AgentConfigPatch): Prisma.AgentConfigUpdateManyMutationInput {
  const { throttleMs: _throttleMs, ...persisted } = patch
  return persisted
}
