import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./AgentUnifiedStreamComposer.tsx', import.meta.url), 'utf8')

describe('Agent unified stream composer', () => {
  it('uses the active V2 turn composer and creates a session for a new draft', () => {
    expect(source).toContain('turnComposer.send(outgoing)')
    expect(source).toContain("fetch('/api/agent/sessions'")
    expect(source).toContain("sendAgentTurnMessage(recordedSessionId, outgoing, 'steer'")
    expect(source).not.toContain('streamAgentChat')
  })

  it('preserves job, resume, file, and quick-thinking composer context', () => {
    expect(source).toContain('jobComposerContext(job)')
    expect(source).toContain('resumeComposerContext(resume)')
    expect(source).toContain('attachmentComposerContext(attachedFiles)')
    expect(source).toContain("t('agent.quickThinkingPrompt')")
  })

  it('offers explicit objectives only outside an active Turn and keeps ordinary sends independent', () => {
    expect(source).toContain("!turnComposer && !objectiveFormOpen")
    expect(source).toContain("!turnComposer && objectiveFormOpen")
    expect(source).toContain("admissionOwnerRef.current === 'objective'")
    expect(source).toContain('attachedFiles={attachedFiles}')
    expect(source).toContain('setAttachedFiles([])')
    expect(source).toContain("sendAgentTurnMessage(recordedSessionId, outgoing, 'steer'")
  })
})
