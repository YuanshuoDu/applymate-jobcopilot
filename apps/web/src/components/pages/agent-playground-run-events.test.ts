import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./agent-playground-run-events.ts', import.meta.url), 'utf8')

describe('agent-playground-run-events', () => {
  it('ignores stale run events and preserves the existing lifecycle event set', () => {
    expect(source).toContain('if (!isCurrentRun()) return')
    for (const event of ['role_start', 'orchestrator_question', 'application_queued', 'done', 'error']) {
      expect(source).toContain(`listen('${event}'`)
    }
  })

  it('keeps question answers and queued applications in their existing state channels', () => {
    expect(source).toContain('handlers.setWaitingQuestion({ id: d.id')
    expect(source).toContain('handlers.setRunLog(prev => prev.map')
    expect(source).toContain('handlers.setApplyQueue(prev => prev.some')
  })
})
