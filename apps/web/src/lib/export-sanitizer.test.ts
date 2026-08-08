import { describe, expect, it } from 'vitest'
import { sanitizeExportValue } from './export-sanitizer'

describe('sanitizeExportValue', () => {
  it('redacts credential fields and tokens embedded in logs', () => {
    const result = sanitizeExportValue({
      log: { authorization: 'Bearer top-secret-token', apiKey: 'key-123456789012345' },
      text: 'request failed with Bearer another-secret-token',
      jsonLog: '{"apiKey":"raw-secret-value"}',
      normal: 'keep this',
    }) as Record<string, unknown>
    expect(JSON.stringify(result)).not.toContain('top-secret-token')
    expect(JSON.stringify(result)).not.toContain('another-secret-token')
    expect(JSON.stringify(result)).not.toContain('raw-secret-value')
    expect(result.normal).toBe('keep this')
  })
})
