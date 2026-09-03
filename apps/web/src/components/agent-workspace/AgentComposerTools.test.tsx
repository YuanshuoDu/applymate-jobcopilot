import React from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentComposerTools } from './AgentComposerTools'

describe('AgentComposerTools', () => {
  it('keeps context and advanced model controls available', () => {
    const html = renderToString(<AgentComposerTools
      addMenuOpen={false}
      composerJobs={[]}
      composerResumes={[]}
      fileInputRef={React.createRef<HTMLInputElement>()}
      onAddMenuOpenChange={vi.fn()}
      onAddSelectedFiles={vi.fn()}
      onAddJobContext={vi.fn()}
      onAddResumeContext={vi.fn()}
      onAppendComposerContext={vi.fn()}
    />)
    expect(html).toContain('Advanced model settings')
    expect(html).toContain('Add context')
  })
})
