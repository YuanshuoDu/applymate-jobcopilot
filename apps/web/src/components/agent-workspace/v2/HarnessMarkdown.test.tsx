import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { HarnessMarkdown } from './HarnessMarkdown'

describe('HarnessMarkdown', () => {
  it('turns only exact markers present in the answer manifest into accessible controls', () => {
    const answerEvidence = {
      schemaVersion: 1 as const,
      sources: [{ key: 'S1', kind: 'job' as const, label: 'Senior Engineer', excerpt: 'A bounded preview.' }],
    }
    const html = renderToStaticMarkup(<HarnessMarkdown
      markdown="Supported [[source:S1]], unavailable [[source:S2]], malformed [[source:S9]] [[source:bad key]] [[source:unfinished"
      answerEvidence={answerEvidence} sourceDisclosureId="answer-evidence-1" onSourceSelect={vi.fn()} />)

    expect(html).toContain('data-agent-source-marker="S1"')
    expect(html).toContain('aria-label="Show source preview S1"')
    expect(html).toContain('aria-controls="answer-evidence-1"')
    expect(html).toContain('[S1]</button>')
    expect(html).not.toContain('[[source:S2]]')
    expect(html).not.toContain('[[source:S9]]')
    expect(html).not.toContain('[[source:bad key]]')
    expect(html).not.toContain('[[source:unfinished')
    expect(html).not.toContain('data-agent-source-marker="S2"')
    expect(html).not.toContain('data-agent-source-marker="S9"')
  })

  it('reports the shared disclosure state for every marker that controls it', () => {
    const answerEvidence = {
      schemaVersion: 1 as const,
      sources: [
        { key: 'S1', kind: 'job' as const, label: 'Role one', excerpt: 'First preview.' },
        { key: 'S2', kind: 'resume' as const, label: 'Experience', excerpt: 'Second preview.' },
      ],
    }
    const html = renderToStaticMarkup(<HarnessMarkdown markdown="One [[source:S1]], two [[source:S2]]."
      answerEvidence={answerEvidence} sourceDisclosureId="answer-evidence-1" sourceDisclosureOpen onSourceSelect={vi.fn()} />)

    expect(html.match(/aria-expanded="true"/g)).toHaveLength(2)
  })

  it('keeps source markers inert when no validated manifest is supplied', () => {
    const html = renderToStaticMarkup(<HarnessMarkdown markdown="Legacy answer [[source:S1]] and [[source:unfinished" />)

    expect(html).toContain('Legacy answer [[source:S1]] and [[source:unfinished')
    expect(html).not.toContain('data-agent-source-marker')
    expect(html).not.toContain('<button')
  })

  it('renders unsafe model Markdown as inert text', () => {
    const html = renderToStaticMarkup(<HarnessMarkdown markdown={'**Safe** <img src=x onerror="alert(1)"> [run](javascript:alert(1))'} />)

    expect(html).toContain('<strong>Safe</strong>')
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
    expect(html).toContain('[run](javascript:alert(1))')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('href="javascript:')
  })

  it('allows only ordinary HTTP(S) links', () => {
    const html = renderToStaticMarkup(<HarnessMarkdown markdown="[docs](https://example.com) [bad](data:text/html,attack) [external](//example.com)" />)

    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('[bad](data:text/html,attack)')
    expect(html).toContain('[external](//example.com)')
    expect(html).not.toContain('href="data:')
  })
})
