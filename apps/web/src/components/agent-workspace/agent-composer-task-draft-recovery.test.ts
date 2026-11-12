import { describe, expect, it } from 'vitest'
import { takeDeferredTaskDraft } from './agent-composer-task-draft-recovery'

describe('Task draft recovery', () => {
  it('keeps a failed draft bound to its Session and restores it only when that target is ready and empty', () => {
    const drafts = new Map<string | null, string>([['session-a', 'Keep this task on A']])
    expect(takeDeferredTaskDraft(drafts, 'session-b', '', true)).toBeNull()
    expect(drafts.get('session-a')).toBe('Keep this task on A')
    expect(takeDeferredTaskDraft(drafts, 'session-a', 'A different draft', true)).toBeNull()
    expect(takeDeferredTaskDraft(drafts, 'session-a', '', false)).toBeNull()
    expect(takeDeferredTaskDraft(drafts, 'session-a', '', true)).toBe('Keep this task on A')
    expect(drafts.has('session-a')).toBe(false)
  })

  it('keeps blank-workspace drafts separate from Session drafts', () => {
    const drafts = new Map<string | null, string>([[null, 'Start from blank']])
    expect(takeDeferredTaskDraft(drafts, 'session-a', '', true)).toBeNull()
    expect(takeDeferredTaskDraft(drafts, null, '', true)).toBe('Start from blank')
  })
})
