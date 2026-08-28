import { describe, expect, it, vi } from 'vitest'
import { azureKeyVaultCostAlert, azureKeyVaultUsageConfig, parseAzureCostManagement, parseAzureMonitorMetrics, readAzureKeyVaultUsage } from './azure-key-vault-usage'

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const resourceId = '/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/applymate/providers/Microsoft.KeyVault/vaults/applymate'

describe('Azure Key Vault usage', () => {
  it('parses monitor operation, result, and latency metrics', () => {
    expect(parseAzureMonitorMetrics({ value: [
      { name: { value: 'ServiceApiHit' }, timeseries: [{ data: [{ total: 3 }, { total: '2' }] }] },
      { name: { value: 'ServiceApiResult' }, timeseries: [{ data: [{ total: 5 }] }] },
      { name: { value: 'ServiceApiLatency' }, timeseries: [{ data: [{ average: 8 }, { average: 12 }] }] },
    ] })).toMatchObject({ totalOperations: 5, totalResults: 5, avgLatencyMs: 10 })
  })

  it('parses actual cost and rejects mixed currencies', () => {
    expect(parseAzureCostManagement({ properties: { columns: [{ name: 'PreTaxCost' }, { name: 'Currency' }], rows: [[1.25, 'USD'], ['0.75', 'USD']] } })).toEqual({ cost: 2, currency: 'USD' })
    expect(parseAzureCostManagement({ properties: { columns: [{ name: 'PreTaxCost' }, { name: 'Currency' }], rows: [[1, 'USD'], [1, 'EUR']] } })).toBeNull()
  })

  it('combines current-month monitor metrics with Cost Management billing', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).includes('CostManagement')
      ? response({ properties: { columns: [{ name: 'PreTaxCost' }, { name: 'Currency' }], rows: [[2.5, 'USD']] } })
      : response({ value: [{ name: { value: 'ServiceApiHit' }, timeseries: [{ data: [{ total: 9 }] }] }] }))
    const snapshot = await readAzureKeyVaultUsage({ AZURE_KEY_VAULT_RESOURCE_ID: resourceId, AZURE_SUBSCRIPTION_ID: '11111111-1111-4111-8111-111111111111', AZURE_COST_ALERT_USD: '2', AZURE_MAX_BUDGET_USD: '10' }, request, async () => 'arm-token')
    expect(snapshot).toMatchObject({ source: 'azure_cost_management', totalOperations: 9, cost: 2.5, currency: 'USD', alertTriggered: true, maxBudget: 10 })
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls.find(([url]) => String(url).includes('CostManagement'))?.[1]).toMatchObject({ method: 'POST' })
  })

  it('does not call Azure when the resource scope is not configured', async () => {
    const request = vi.fn<typeof fetch>()
    await expect(readAzureKeyVaultUsage({}, request, async () => 'token')).resolves.toBeNull()
    expect(request).not.toHaveBeenCalled()
    expect(azureKeyVaultUsageConfig({ AZURE_KEY_VAULT_RESOURCE_ID: '/subscriptions/not-valid' })).toBeNull()
    expect(azureKeyVaultCostAlert({ AZURE_COST_ALERT_USD: '5' })).toBe(5)
  })
})
