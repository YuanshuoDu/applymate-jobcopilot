import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ReviewFramePage, { metadata } from './page'

describe('embedded review form', () => {
  it('provides independently named fields without navigation or submission actions', () => {
    const html = renderToStaticMarkup(<ReviewFramePage />)
    expect(metadata.robots).toEqual({ index: false, follow: false })
    expect(html).toContain('name="workAuthorisation"')
    expect(html).toContain('name="noticePeriod"')
    expect(html).toContain('name="exampleProject"')
    expect(html).toContain('No submission')
    expect(html).not.toMatch(/<form[\s>]|<script|type="submit"|name="email"/)
  })
})
