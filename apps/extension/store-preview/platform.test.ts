import { describe, expect, it } from 'vitest'
import { createPreviewPlatform } from './platform'

describe('preview platform boundary', () => {
  it('never grants browser permissions or executes page scripts', async () => {
    const platform = createPreviewPlatform()
    expect(await platform.permissions.request()).toBe(false)
    expect(await platform.permissions.getAll()).toEqual({ origins: [], permissions: [] })
    await expect(platform.scripting.executeScript()).rejects.toThrow('requires the installed extension')
    await expect(platform.tabs.create()).rejects.toThrow('external navigation is disabled')
  })

  it('keeps sample storage isolated between preview sessions', async () => {
    const first = createPreviewPlatform()
    await first.storage.local.set({ privateDraft: 'test' })
    expect((await first.storage.local.get('privateDraft')).privateDraft).toBe('test')
    expect((await createPreviewPlatform().storage.local.get('privateDraft')).privateDraft).toBeUndefined()
  })
})
