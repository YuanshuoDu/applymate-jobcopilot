import { describe, expect, it, vi } from 'vitest'
import { seedAiConfiguration } from './seed-ai'

describe('seedAiConfiguration', () => {
  it('upserts the platform catalogue without storing secret values', async () => {
    const providerUpsert = vi.fn().mockResolvedValue({ id: 'provider_1' })
    const modelUpsert = vi.fn().mockResolvedValue({ id: 'model_1' })
    const routeUpsert = vi.fn().mockResolvedValue({ id: 'route_1' })
    await seedAiConfiguration({ aiProviderConfig: { upsert: providerUpsert }, aiModelConfig: { upsert: modelUpsert }, aiRouteConfig: { upsert: routeUpsert } })
    expect(providerUpsert).toHaveBeenCalled()
    expect(modelUpsert).toHaveBeenCalled()
    expect(routeUpsert).toHaveBeenCalled()
    expect(JSON.stringify(providerUpsert.mock.calls)).not.toContain('sk-')
    expect(providerUpsert.mock.calls[0][0]).toMatchObject({
      create: { apiBase: 'https://api.minimax.io/v1' },
    })
  })
})
