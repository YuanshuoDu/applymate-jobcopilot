import React from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SmartMessage } from './SmartMessage'

describe('SmartMessage', () => {
  it('escapes raw HTML while preserving lightweight markdown', () => {
    const html = renderToString(
      <SmartMessage text={'**Safe** <img src=x onerror=alert(1)> `code`'} />,
    )

    expect(html).toContain('<strong>Safe</strong>')
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('onerror=alert(1)>')
  })
})
