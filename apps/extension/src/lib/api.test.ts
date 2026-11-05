import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionSettings } from './types'

const storage = vi.hoisted(() => ({ getSettings: vi.fn(), getCurrentResumeId: vi.fn() }))
vi.mock('./storage', () => storage)
import { savePersonaFields } from './api'

const original: ExtensionSettings = {
  apiBaseUrl: 'https://applymate.site', apiToken: 'old-test-token',
  userEmail: 'account-a@example.invalid', userName: 'Sample A', autoSave: false,
}
const fields = [{ key: 'sample_name', category: 'personal', label: 'Name', value: 'Account A sample', confidence: 1, source: 'manual', updatedAt: '2026-11-02T00:00:00Z' }]
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('window', {})
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn().mockResolvedValue({ ok: true }) } })
})
afterEach(() => vi.unstubAllGlobals())

describe('API refresh preserves request account identity', () => {
  it('does not resend one account’s profile data after switching to another account', async () => {
    storage.getSettings.mockResolvedValue({ ...original, apiToken: 'account-b-token', userEmail: 'account-b@example.invalid' })
    await expect(savePersonaFields(original, fields)).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not replay an authenticated write to another API origin', async () => {
    storage.getSettings.mockResolvedValue({ ...original, apiToken: 'new-token', apiBaseUrl: 'http://localhost:3000' })
    await expect(savePersonaFields(original, fields)).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refreshes once for the same normalized account and preserves the write body', async () => {
    storage.getSettings.mockResolvedValue({ ...original, apiToken: 'new-token', userEmail: ' ACCOUNT-A@example.invalid ' })
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ fields }), { status: 200 }))
    await expect(savePersonaFields(original, fields)).resolves.toEqual({ fields })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      headers: { Authorization: 'Bearer new-token' }, body: JSON.stringify({ fields }),
    })
  })

  it('does not infer account continuity when the original account identity is missing', async () => {
    storage.getSettings.mockResolvedValue({ ...original, apiToken: 'new-token' })
    await expect(savePersonaFields({ ...original, userEmail: '' }, fields)).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
