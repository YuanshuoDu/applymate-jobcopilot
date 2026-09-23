import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./useAgentPlaygroundRun.ts', import.meta.url), 'utf8')

describe('Agent playground run controller', () => {
  it('retains policy-derived legacy run setup and the event listener boundary', () => {
    expect(source).toContain("fetch('/api/agent/scout', { method: 'POST' })")
    expect(source).toContain("query.set('autonomous', 'true')")
    expect(source).toContain("query.set('sessionId', requestedSessionId)")
    expect(source).toContain('attachAgentRunEventListeners(es, isCurrentRun')
  })

  it('cancels only the page run stream and keeps the existing session execution endpoint', () => {
    expect(source).toContain('runIdRef.current += 1')
    expect(source).toContain('esRef.current?.close()')
    expect(source).toContain('`/api/agent/executions?sessionId=${encodeURIComponent(sessionId)}`')
    expect(source).toContain("window.dispatchEvent(new Event('applymate:sessions-changed'))")
  })
})
