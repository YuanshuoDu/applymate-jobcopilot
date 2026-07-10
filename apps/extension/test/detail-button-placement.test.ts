import { describe, expect, it } from 'vitest'
import { DETAIL_ACTION_HOST_SELECTORS } from '../src/content/detail-button-placement'

describe('detail button placement', () => {
  it('targets LinkedIn job detail action controls before falling back', () => {
    expect(DETAIL_ACTION_HOST_SELECTORS[0]).toContain('jobs-s-apply')
    expect(DETAIL_ACTION_HOST_SELECTORS).toContain('.jobs-save-button')
  })
})
