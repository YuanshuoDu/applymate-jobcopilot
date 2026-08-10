import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  featureEnabled: vi.fn(),
  loadPolicy: vi.fn(),
  canUsePolicy: vi.fn(),
  detectFlow: vi.fn(),
}))

vi.mock('../admin/runtime-feature-flags.js', () => ({ isWorkerFeatureEnabled: mocks.featureEnabled }))
vi.mock('../admin/ats-policy.js', () => ({
  loadEffectiveAtsPolicy: mocks.loadPolicy,
  canUseAtsSource: mocks.canUsePolicy,
}))
vi.mock('../flows/index.js', () => ({ detectFlow: mocks.detectFlow }))

describe('unattended apply control', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.featureEnabled.mockResolvedValue(true)
    mocks.loadPolicy.mockResolvedValue({ configured: true, sourceKey: 'greenhouse' })
    mocks.canUsePolicy.mockReturnValue(true)
    mocks.detectFlow.mockReturnValue('greenhouse')
  })

  it('blocks before policy lookup when the platform control is disabled', async () => {
    mocks.featureEnabled.mockResolvedValueOnce(false)
    const { evaluateUnattendedApplyControl } = await import('./unattended-apply-control.js')

    await expect(evaluateUnattendedApplyControl({ query: vi.fn() } as never, 'https://boards.greenhouse.io/apply', 'user-1'))
      .resolves.toMatchObject({ allowed: false, flow: 'greenhouse', message: expect.stringContaining('temporarily unavailable') })

    expect(mocks.loadPolicy).not.toHaveBeenCalled()
  })

  it('blocks a known ATS when its configured policy disallows auto apply', async () => {
    mocks.canUsePolicy.mockReturnValueOnce(false)
    const { evaluateUnattendedApplyControl } = await import('./unattended-apply-control.js')

    await expect(evaluateUnattendedApplyControl({ query: vi.fn() } as never, 'https://boards.greenhouse.io/apply', 'user-1'))
      .resolves.toMatchObject({ allowed: false, flow: 'greenhouse' })

    expect(mocks.loadPolicy).toHaveBeenCalledWith(expect.anything(), 'greenhouse')
    expect(mocks.canUsePolicy).toHaveBeenCalledWith(expect.anything(), 'user-1', 'auto_apply')
  })

  it('fails closed when a control lookup is unavailable', async () => {
    mocks.featureEnabled.mockRejectedValueOnce(new Error('database unavailable'))
    const { evaluateUnattendedApplyControl } = await import('./unattended-apply-control.js')

    await expect(evaluateUnattendedApplyControl({ query: vi.fn() } as never, 'https://boards.greenhouse.io/apply', 'user-1'))
      .resolves.toMatchObject({ allowed: false, flow: 'greenhouse' })
  })
})
