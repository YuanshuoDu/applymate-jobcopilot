import { describe, expect, it, vi } from 'vitest'
import { analyzeForm, downloadApplicationPack, getDashboard, getPersonaFields, openApplicationPackPrint } from './api'

describe('preview API isolation', () => {
  it('serves independent fixture copies without network access', async () => {
    const fetchMock = vi.fn(() => { throw new Error('Unexpected network') })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const dashboard = await getDashboard()
      dashboard.stats.total = 99
      expect((await getDashboard()).stats.total).toBe(4)
      expect((await getPersonaFields()).fields).toHaveLength(3)
      expect(fetchMock).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })

  it('rejects AI and real downloads instead of simulating success', async () => {
    await expect(analyzeForm()).rejects.toThrow('Component preview only')
    await expect(downloadApplicationPack()).rejects.toThrow('Component preview only')
    await expect(openApplicationPackPrint()).rejects.toThrow('Component preview only')
  })
})
