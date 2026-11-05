import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ExtensionReviewPage, { metadata } from './page'

describe('public extension review page', () => {
  it('keeps the fictional job out of search indexes and exposes usable JobPosting data', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false })
    const html = renderToStaticMarkup(<ExtensionReviewPage />)
    const json = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)?.[1]
    expect(json).toBeDefined()
    expect(JSON.parse(json!).hiringOrganization.name).toContain('fictional')
    expect(html).toContain('no employer submission endpoint')
  })

  it('uses ordinary sign-in and a fixed same-site frame without a submission endpoint', () => {
    const html = renderToStaticMarkup(<ExtensionReviewPage />)
    expect(html).toContain('/login?callbackUrl=%2Fextension-review')
    expect(html).toContain('src="/extension-review/frame"')
    expect(html).toContain('title="Fictional embedded application questions"')
    expect(html).not.toMatch(/<form[\s>]|type="submit"|src="https?:/)
  })
})
