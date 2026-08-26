import { describe, expect, it, vi } from 'vitest'
import { estimateNeonCost, parseNeonConsumption, parseNeonProjectDetails, readNeonUsage } from './neon-usage'

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('Neon usage', () => {
  it('sums supported consumption metrics across projects and periods', () => {
    expect(parseNeonConsumption({ projects: [{ periods: [{ period_plan: 'launch', consumption: [{ metrics: [{ metric_name: 'compute_unit_seconds', value: 3600 }, { metric_name: 'public_network_transfer_bytes', value: 100 }] }] }, { consumption: [{ metrics: [{ metric_name: 'compute_unit_seconds', value: '60' }, { metric_name: 'ignored', value: 9 }] }] }] }, { periods: [{ period_plan: 'launch', consumption: [{ metrics: [{ metric_name: 'public_network_transfer_bytes', value: 40 }] }] }] }] })).toEqual({ plan: 'launch', metrics: [{ name: 'compute_unit_seconds', value: 3660 }, { name: 'public_network_transfer_bytes', value: 140 }] })
  })

  it('reads current-month metrics with bearer auth and estimates documented rates', async () => {
    const request = vi.fn<(url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>>(async (_url) => response({ projects: [{ periods: [{ period_plan: 'launch', consumption: [{ metrics: [{ metric_name: 'compute_unit_seconds', value: 3600 }, { metric_name: 'public_network_transfer_bytes', value: 101_000_000_000 }] }] }] }] }))
    const snapshot = await readNeonUsage({ NEON_API_KEY: 'secret', NEON_ORG_ID: 'org-1', NEON_PROJECT_ID: 'project-1', NEON_COST_ALERT_USD: '0.20' }, request)
    expect(snapshot).toMatchObject({ available: true, source: 'neon_consumption_api', period: 'current_month', plan: 'launch', outputBytes: 101_000_000_000, estimatedCostUsd: 0.206, alertTriggered: true })
    expect(snapshot?.metrics).toEqual(expect.arrayContaining([
      { name: 'compute_unit_seconds', value: 3600, unit: 'cu_seconds', estimatedCostUsd: 0.106 },
      { name: 'public_network_transfer_bytes', value: 101_000_000_000, unit: 'bytes', estimatedCostUsd: 0.1 },
    ]))
    const [url, init] = request.mock.calls[0] ?? []
    expect(new URL(url).searchParams.get('metrics')).toContain('compute_unit_seconds')
    expect(new URL(url).searchParams.get('project_ids')).toBe('project-1')
    expect(init?.headers).toEqual({ Authorization: 'Bearer secret' })
  })

  it('follows Neon pagination when an organization has more than one page', async () => {
    const request = vi.fn<(url: string) => Promise<Response>>()
      .mockResolvedValueOnce(response({ projects: [{ periods: [{ period_plan: 'scale', consumption: [{ metrics: [{ metric_name: 'compute_unit_seconds', value: 3600 }] }] }] }], pagination: { cursor: 'next-page' } }))
      .mockResolvedValueOnce(response({ projects: [{ periods: [{ period_plan: 'scale', consumption: [{ metrics: [{ metric_name: 'compute_unit_seconds', value: 3600 }] }] }] }] }))
    await expect(readNeonUsage({ NEON_API_KEY: 'secret', NEON_ORG_ID: 'org-1' }, request)).resolves.toMatchObject({ plan: 'scale', metrics: [{ name: 'compute_unit_seconds', value: 7200 }], estimatedCostUsd: 0.444 })
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1]?.[0]).toContain('cursor=next-page')
  })

  it('falls back to project details and never calls without a server key', async () => {
    const request = vi.fn(async (url: string) => url.includes('consumption_history') ? response({}, 403) : response({ project: { data_transfer_bytes: 2_000_000_000 } }))
    await expect(readNeonUsage({ NEON_API_KEY: 'secret', NEON_ORG_ID: 'org-1', NEON_PROJECT_ID: 'project-1', NEON_PLAN: 'launch' }, request)).resolves.toMatchObject({ source: 'neon_project_details', period: 'current_billing_period', outputBytes: 2_000_000_000, estimatedCostUsd: 0, metrics: [{ name: 'public_network_transfer_bytes', estimatedCostUsd: 0 }] })
    expect(request).toHaveBeenCalledTimes(2)
    const noCredentials = vi.fn<typeof fetch>()
    await expect(readNeonUsage({}, noCredentials)).resolves.toBeNull()
    expect(noCredentials).not.toHaveBeenCalled()
  })

  it('returns no cost when the plan and rates are unknown', () => {
    expect(estimateNeonCost([{ name: 'compute_unit_seconds', value: 3600 }], {})).toBeNull()
    expect(parseNeonProjectDetails({ data_transfer_bytes: 'not-a-number' })).toBeNull()
  })
})
