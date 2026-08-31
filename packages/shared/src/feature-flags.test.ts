import { describe, expect, it } from 'vitest'
import {
  AGENT_HARNESS_FEATURES,
  evaluateAgentHarnessFeature,
  evaluateManagedFeature,
  getAgentHarnessFeatureHealth,
  isAgentHarnessFeatureKey,
  isManagedFeatureKey,
} from './feature-flags.js'

describe('managed platform feature flags', () => {
  it('keeps the current product behavior when no active override exists', () => {
    expect(evaluateManagedFeature('unattended_apply', {
      environment: 'production',
      userId: 'user-1',
      plan: 'pro',
      flag: null,
    })).toBe(true)
  })

  it('applies a global disabled override before any rollout target', () => {
    expect(evaluateManagedFeature('worker_discovery', {
      environment: 'production',
      userId: 'user-1',
      plan: 'pro',
      flag: {
        enabled: false,
        rolloutPercent: 100,
        targetPlans: [],
        targetUserIds: ['user-1'],
        status: 'active',
        rollbackAt: null,
      },
    })).toBe(false)
  })

  it('allows only registered operational keys', () => {
    expect(isManagedFeatureKey('unattended_apply')).toBe(true)
    expect(isManagedFeatureKey('fantasticjobs_shadow')).toBe(true)
    expect(isManagedFeatureKey('new_feature')).toBe(false)
  })

  it('keeps Fantastic.jobs Shadow disabled until explicitly rolled out', () => {
    expect(evaluateManagedFeature('fantasticjobs_shadow', {
      environment: 'production',
      userId: 'user-1',
      plan: 'pro',
      flag: null,
    })).toBe(false)
  })

  it('declares the complete V2 catalog with every default disabled', () => {
    expect(Object.keys(AGENT_HARNESS_FEATURES)).toHaveLength(11)
    expect(Object.values(AGENT_HARNESS_FEATURES).every((feature) => feature.defaultEnabled === false)).toBe(true)
    expect(isAgentHarnessFeatureKey('AGENT_SUBAGENTS_V2')).toBe(true)
    expect(isAgentHarnessFeatureKey('AGENT_UNKNOWN_V2')).toBe(false)
  })

  it('uses the safe default for unknown or missing V2 controls', () => {
    const input = { environment: 'staging' as const, userId: 'user-1', plan: 'pro', flag: null }
    expect(evaluateAgentHarnessFeature('AGENT_PROTOCOL_V2_DUAL_WRITE', input)).toBe(false)
    expect(evaluateAgentHarnessFeature('AGENT_UNKNOWN_V2', input)).toBe(false)
  })

  it('only enables a V2 control through an active reviewed override', () => {
    const input = {
      environment: 'staging' as const,
      userId: 'user-1',
      plan: 'pro',
      flag: {
        enabled: true,
        rolloutPercent: 100,
        targetPlans: [],
        targetUserIds: [],
        status: 'active',
        rollbackAt: null,
      },
    }
    expect(evaluateAgentHarnessFeature('AGENT_TOOL_KERNEL_V2', input)).toBe(true)
    expect(evaluateAgentHarnessFeature('AGENT_TOOL_KERNEL_V2', { ...input, flag: { ...input.flag, status: 'draft' } })).toBe(false)
  })

  it('publishes a non-sensitive health snapshot with safe defaults', () => {
    const snapshot = getAgentHarnessFeatureHealth('staging')
    expect(snapshot).toMatchObject({ environment: 'staging', source: 'safe_defaults', allDefaultOff: true })
    expect(Object.values(snapshot.flags)).toHaveLength(11)
    expect(Object.values(snapshot.flags).every((flag) => flag.enabled === false && flag.defaultEnabled === false)).toBe(true)
  })
})
