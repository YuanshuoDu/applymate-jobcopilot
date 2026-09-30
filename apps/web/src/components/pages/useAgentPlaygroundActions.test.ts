import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./useAgentPlaygroundActions.ts', import.meta.url), 'utf8')

describe('Agent playground review actions', () => {
  it('preserves the existing approval-answer and email actions', () => {
    expect(source).toContain("field === '_send_email'")
    expect(source).toContain("apiMutate('/api/gmail/send-draft', 'POST', emailData)")
    expect(source).toContain("apiMutate('/api/agent', 'PATCH', { [field]: value })")
    expect(source).toContain("type: 'question_answered'")
  })

  it('keeps orchestrator answer submission and application review marking', () => {
    expect(source).toContain("apiMutate('/api/agent/answer', 'POST', { questionId, answer })")
    expect(source).toContain('setWaitingQuestion(null)')
    expect(source).toContain('`/api/jobs/${jobId}/apply`')
    expect(source).toContain('`_applied_${j.url}`')
  })
})
