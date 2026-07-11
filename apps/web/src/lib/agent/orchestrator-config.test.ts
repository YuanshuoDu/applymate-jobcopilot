import { describe, expect, it } from 'vitest'
import {
  agentConfigPatchFrom,
  applyAgentConfigPatch,
  prismaAgentConfigPatch,
} from './orchestrator-config'
import type { AgentConfigFull } from './types'

function baseConfig(): AgentConfigFull {
  return {
    id: 'cfg_1',
    userId: 'user_1',
    isRunning: false,
    dailyLimit: 10,
    minMatchScore: 75,
    autoApply: false,
    requireApproval: true,
    targetLocations: [],
    targetRoles: [],
    excludeCompanies: [],
    priorityCompanies: [],
    autoCoverLetter: false,
    coverTone: 'professional',
    useTailoredCV: false,
    model: 'claude-test',
    throttleMs: 300,
  }
}

describe('orchestrator config helpers', () => {
  it('keeps only supported fields with valid value types', () => {
    expect(agentConfigPatchFrom({
      dailyLimit: 20,
      minMatchScore: '90',
      autoApply: true,
      targetRoles: ['SWE'],
      unknown: 'ignored',
    })).toEqual({
      dailyLimit: 20,
      autoApply: true,
      targetRoles: ['SWE'],
    })
  })

  it('applies valid patches to in-memory pipeline config', () => {
    const config = baseConfig()
    const changes = applyAgentConfigPatch(config, {
      dailyLimit: 22,
      coverTone: 'direct',
      throttleMs: 100,
    })

    expect(changes).toEqual([
      'dailyLimit=22',
      'coverTone="direct"',
      'throttleMs=100',
    ])
    expect(config.dailyLimit).toBe(22)
    expect(config.coverTone).toBe('direct')
    expect(config.throttleMs).toBe(100)
  })

  it('omits runtime-only throttleMs from Prisma writes', () => {
    expect(prismaAgentConfigPatch({
      dailyLimit: 12,
      throttleMs: 150,
    })).toEqual({ dailyLimit: 12 })
  })
})
