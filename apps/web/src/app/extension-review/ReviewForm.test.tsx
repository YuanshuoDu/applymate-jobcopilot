import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ReviewForm from './ReviewForm'

describe('review application form', () => {
  it('provides accessible application controls while preventing native submissions before hydration', () => {
    const html = renderToStaticMarkup(<ReviewForm />)
    expect(html).toContain('role="form"')
    expect(html).toContain('for="first-name"')
    expect(html.match(/<input\b[^>]*\bid="email"[^>]*>/)?.[0]).toContain('type="email"')
    expect(html.match(/<input\b[^>]*\bname="resume"[^>]*>/)?.[0]).toContain('type="file"')
    expect(html).toContain('type="button"')
    expect(html).not.toMatch(/<form[\s>]|type="submit"|\saction=/)
  })

  it('clearly limits the exercise to fictional data and local checks', () => {
    const html = renderToStaticMarkup(<ReviewForm />)
    expect(html).toContain('alex.morgan@example.com')
    expect(html).toContain('Use fictional details')
    expect(html).toContain('does not upload the selected file')
    expect(html).toContain('no application submission action')
    expect(html).not.toMatch(/\svalue="[^\"]+"/)
  })
})
