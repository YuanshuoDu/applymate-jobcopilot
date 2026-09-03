import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { HarnessMarkdown } from './HarnessMarkdown'

describe('HarnessMarkdown', () => {
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
