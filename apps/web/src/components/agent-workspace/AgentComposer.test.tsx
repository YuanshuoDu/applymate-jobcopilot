import React from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentComposer } from './AgentComposer'
import { AgentTurnComposerProvider, type TurnComposerController } from './agent-turn-commands'

describe('AgentComposer', () => {
  it('defaults to accessible Chat and exposes a keyboard-operable Task choice', () => {
    const html = renderToString(<AgentComposer
      waitingForAnswer={false} chips={[]} chatInput="" chatLoading={false} addMenuOpen={false}
      attachedFiles={[]} composerJobs={[]} composerResumes={[]}
      inputRef={React.createRef<HTMLTextAreaElement>()} fileInputRef={React.createRef<HTMLInputElement>()}
      onChatInputChange={vi.fn()} onAddMenuOpenChange={vi.fn()} onSendChat={vi.fn()}
      onRemoveAttachedFile={vi.fn()} onAddSelectedFiles={vi.fn()} onAddJobContext={vi.fn()}
      onAddResumeContext={vi.fn()} onAppendComposerContext={vi.fn()}
      taskModeAvailable onComposerModeChange={vi.fn()} onStartTask={vi.fn()}
    />)

    expect(html).toContain('role="group" aria-label="Composer mode"')
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="composer-mode-chat"/)
    expect(html).toMatch(/aria-pressed="false"[^>]*data-testid="composer-mode-task"/)
    expect(html).toContain('Chat is the default.')
    expect(html).toContain('type="button"')
  })

  it('keeps the shared objective draft and attached files visible while Task start is blocked', () => {
    const html = renderToString(<AgentComposer
      waitingForAnswer={false} chips={[]} chatInput="Keep this objective" chatLoading={false} addMenuOpen={false}
      attachedFiles={[{ id: 'resume-file', name: 'resume.pdf', size: 420, type: 'application/pdf' }]}
      composerJobs={[]} composerResumes={[]}
      inputRef={React.createRef<HTMLTextAreaElement>()} fileInputRef={React.createRef<HTMLInputElement>()}
      onChatInputChange={vi.fn()} onAddMenuOpenChange={vi.fn()} onSendChat={vi.fn()}
      onRemoveAttachedFile={vi.fn()} onAddSelectedFiles={vi.fn()} onAddJobContext={vi.fn()}
      onAddResumeContext={vi.fn()} onAppendComposerContext={vi.fn()}
      composerMode="task" taskModeAvailable onComposerModeChange={vi.fn()} onStartTask={vi.fn()}
    />)

    expect(html).toContain('Keep this objective</textarea>')
    expect(html).toContain('resume.pdf')
    expect(html).toContain('Task start supports text only. Remove attached files to start; they will remain attached until then.')
    expect(html).toMatch(/data-testid="composer-mode-send"[^>]*disabled/)
  })

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

  it('keeps advanced model settings behind a compact model control', () => {
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

    expect(html).toContain('Model')
    expect(html).toContain('title="Advanced model settings"')
    expect(html).not.toContain('Claude Sonnet')
  })

  it('renders explicit delivery, command states, and a real Stop control for an active Turn', () => {
    const controller: TurnComposerController = {
      sessionId: 'session_1',
      activeTurn: { id: 'turn_1', status: 'in_progress', revision: 2 },
      delivery: 'steer',
      setDelivery: vi.fn(),
      chatInput: 'Keep working',
      setChatInput: vi.fn(),
      sending: false,
      messages: [
        { clientMessageId: 'sending', text: 'One', delivery: 'steer', status: 'sending' },
        { clientMessageId: 'accepted', text: 'Two', delivery: 'follow_up', status: 'accepted' },
        { clientMessageId: 'consumed', text: 'Three', delivery: 'steer', status: 'consumed' },
        { clientMessageId: 'failed', text: 'Four', delivery: 'steer', status: 'failed', error: '409 Turn changed' },
      ],
      commandError: null,
      send: vi.fn(),
      interrupt: vi.fn(),
      interrupting: false,
    }
    const html = renderToString(
      <AgentTurnComposerProvider value={controller}>
        <AgentComposer
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
        />
      </AgentTurnComposerProvider>,
    )

    expect(html).toContain('Update this run')
    expect(html).toContain('Send after this run')
    expect(html).toContain('data-testid="interrupt-turn"')
    expect(html).toContain('Sending')
    expect(html).toContain('Accepted')
    expect(html).toContain('Consumed')
    expect(html).toContain('Failed')
  })
})
