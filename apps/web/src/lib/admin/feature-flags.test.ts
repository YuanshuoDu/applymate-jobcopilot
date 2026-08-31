import { describe, expect, it } from 'vitest'
import { parseFeatureFlag } from './feature-flags'

describe('parseFeatureFlag', () => {
  it('rejects unregistered controls so an arbitrary key cannot look active', () => {
    expect(parseFeatureFlag({ key: 'new_feature', environment: 'development', enabled: true, rolloutPercent: 100, targetPlans: [], targetUserIds: [] })).toBeNull()
  })

  it('requires a future rollback for high-risk production controls', () => {
    expect(parseFeatureFlag({ key: 'unattended_apply', environment: 'production', enabled: true, rolloutPercent: 10, targetPlans: [], targetUserIds: [] })).toBeNull()
    expect(parseFeatureFlag({ key: 'unattended_apply', environment: 'production', enabled: true, rolloutPercent: 10, targetPlans: ['pro'], targetUserIds: [], rollbackAt: '2099-01-01T00:00:00.000Z' })).toEqual(expect.objectContaining({ environment: 'production', targetPlans: ['pro'] }))
  })

  it('accepts typed V2 controls while requiring rollback protection for risky ones', () => {
    expect(parseFeatureFlag({ key: 'AGENT_PROTOCOL_V2_DUAL_WRITE', environment: 'staging', enabled: true, rolloutPercent: 1, targetPlans: [], targetUserIds: [] })).toEqual(expect.objectContaining({ key: 'AGENT_PROTOCOL_V2_DUAL_WRITE' }))
    expect(parseFeatureFlag({ key: 'AGENT_BROWSER_TOOL_V2', environment: 'production', enabled: true, rolloutPercent: 1, targetPlans: [], targetUserIds: [] })).toBeNull()
    expect(parseFeatureFlag({ key: 'AGENT_BROWSER_TOOL_V2', environment: 'production', enabled: true, rolloutPercent: 1, targetPlans: [], targetUserIds: [], rollbackAt: '2099-01-01T00:00:00.000Z' })).toEqual(expect.objectContaining({ key: 'AGENT_BROWSER_TOOL_V2' }))
  })
})
