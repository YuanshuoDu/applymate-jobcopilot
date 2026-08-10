import { describe, expect, it } from 'vitest'
import { isSafeAiEndpoint } from './safe-ai-endpoint.js'

describe('isSafeAiEndpoint', () => {
  it('accepts public HTTPS endpoints', () => {
    expect(isSafeAiEndpoint('https://api.example.com/v1')).toBe(true)
  })

  it('rejects private and non-HTTPS destinations', () => {
    expect(isSafeAiEndpoint('http://api.example.com/v1')).toBe(false)
    expect(isSafeAiEndpoint('https://127.0.0.1/v1')).toBe(false)
    expect(isSafeAiEndpoint('https://10.0.0.8/v1')).toBe(false)
    expect(isSafeAiEndpoint('https://metadata.google.internal/v1')).toBe(false)
  })
})
