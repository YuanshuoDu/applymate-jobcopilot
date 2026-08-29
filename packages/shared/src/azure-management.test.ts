import { describe, expect, it, vi } from 'vitest'
import { getAzureManagementToken } from './azure-management'

describe('Azure management token helper', () => {
  it('requests the ARM scope and returns only the token value', async () => {
    const getToken = vi.fn(async (scope: string) => ({ token: scope === 'https://management.azure.com/.default' ? 'arm-token' : '' }))
    await expect(getAzureManagementToken({ credential: { getToken } })).resolves.toBe('arm-token')
    expect(getToken).toHaveBeenCalledWith('https://management.azure.com/.default')
  })

  it('fails open when the deployment identity cannot obtain a token', async () => {
    const getToken = vi.fn(async () => { throw new Error('identity unavailable') })
    await expect(getAzureManagementToken({ credential: { getToken } })).resolves.toBeNull()
  })

  it('does not return blank tokens', async () => {
    await expect(getAzureManagementToken({ credential: { getToken: async () => ({ token: '  ' }) } })).resolves.toBeNull()
  })
})

