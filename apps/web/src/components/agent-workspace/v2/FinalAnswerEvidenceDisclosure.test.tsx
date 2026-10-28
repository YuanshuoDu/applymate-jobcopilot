import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { FinalAnswerEvidenceDisclosure } from './FinalAnswerEvidenceDisclosure'

const evidence = {
  schemaVersion: 1,
  sources: [{ key: 'S1', kind: 'job', label: 'Senior Engineer', excerpt: 'Literal **Markdown** and <script>text</script>.' }],
}

describe('FinalAnswerEvidenceDisclosure', () => {
  it('shows the model-attribution disclaimer and renders the bounded preview as plain text', () => {
    const html = renderToStaticMarkup(<FinalAnswerEvidenceDisclosure id="answer-evidence" evidence={evidence} open selectedKey="S1" onOpenChange={vi.fn()} />)

    expect(html).toContain('aria-label="Answer source previews"')
    expect(html).toContain('Agent context snapshot')
    expect(html).toContain('Agent-linked source. This reference was selected by the model; its support for the claim has not been independently verified.')
    expect(html).toContain('S1 · Senior Engineer')
    expect(html).toContain('Literal **Markdown** and &lt;script&gt;text&lt;/script&gt;.')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<strong>Markdown</strong>')
    expect(html).toContain('data-selected="true"')
    expect(html).not.toContain('<a ')
  })

  it('localizes the disclosure warning for Chinese users', () => {
    const html = renderToStaticMarkup(<FinalAnswerEvidenceDisclosure id="answer-evidence" evidence={evidence} open={false} onOpenChange={vi.fn()} lang="zh" />)

    expect(html).toContain('来源预览（1）')
    expect(html).toContain('Agent 上下文快照')
    expect(html).toContain('Agent 关联来源。此引用由模型选择；它对相关声明的支持尚未经过独立验证。')
  })

  it('synchronizes manual summary open and close events with the shared disclosure state', () => {
    const onOpenChange = vi.fn()
    const element = FinalAnswerEvidenceDisclosure({ id: 'answer-evidence', evidence, open: false, onOpenChange })
    if (!element || !React.isValidElement(element)) throw new Error('Expected an evidence disclosure element')
    const { onToggle } = (element as React.ReactElement<{ onToggle: (event: { currentTarget: { open: boolean } }) => void }>).props

    onToggle({ currentTarget: { open: true } })
    onToggle({ currentTarget: { open: false } })

    expect(onOpenChange.mock.calls).toEqual([[true], [false]])
  })

  it('fails closed for a manifest outside the strict display contract', () => {
    const html = renderToStaticMarkup(<FinalAnswerEvidenceDisclosure id="answer-evidence" evidence={{ ...evidence, rawOutput: 'PRIVATE_OUTPUT' }} open onOpenChange={vi.fn()} />)

    expect(html).toBe('')
    expect(html).not.toContain('PRIVATE_OUTPUT')
  })
})
