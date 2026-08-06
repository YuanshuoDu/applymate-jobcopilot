import React from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentComposer } from './AgentComposer'

describe('AgentComposer', () => {
  it('exposes a mobile-safe composer root for the workspace scroll contract', () => {
    const html = renderToString(<AgentComposer
      waitingForAnswer={false}
      chips={[]}
      chatInput=""
      chatLoading={false}
      addMenuOpen={false}
      attachedFiles={[]}
      composerJobs={[]}
      composerResumes={[]}
      inputRef={React.createRef<HTMLTextAreaElement>()}
      fileInputRef={React.createRef<HTMLInputElement>()}
      onChatInputChange={vi.fn()}
      onAddMenuOpenChange={vi.fn()}
      onSendChat={vi.fn()}
      onRemoveAttachedFile={vi.fn()}
      onAddSelectedFiles={vi.fn()}
      onAddJobContext={vi.fn()}
      onAddResumeContext={vi.fn()}
      onAppendComposerContext={vi.fn()}
    />)

    expect(html).toContain('class="agent-composer"')
  })

  it('shows a locked advanced model entry without exposing an active model choice', () => {
    const html = renderToString(<AgentComposer
      waitingForAnswer={false}
      chips={[]}
      chatInput=""
      chatLoading={false}
      addMenuOpen={false}
      attachedFiles={[]}
      composerJobs={[]}
      composerResumes={[]}
      inputRef={React.createRef<HTMLTextAreaElement>()}
      fileInputRef={React.createRef<HTMLInputElement>()}
      onChatInputChange={vi.fn()}
      onAddMenuOpenChange={vi.fn()}
      onSendChat={vi.fn()}
      onRemoveAttachedFile={vi.fn()}
      onAddSelectedFiles={vi.fn()}
      onAddJobContext={vi.fn()}
      onAddResumeContext={vi.fn()}
      onAppendComposerContext={vi.fn()}
    />)

    expect(html).toContain('Model selection')
    expect(html).toContain('Advanced')
    expect(html).not.toContain('Claude Sonnet')
  })
})
