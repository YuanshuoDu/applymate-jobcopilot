import { describe, expect, it } from 'vitest'
import {
  DETAIL_ACTION_CONTROL_SELECTORS,
  DETAIL_ACTION_HOST_SELECTORS,
  LINKEDIN_NATIVE_SAVE_CONTROL_SELECTOR,
  findLinkedInNativeSaveActionRow,
} from '../src/content/detail-button-placement'

function fakeElement(text = '', ariaLabel: string | null = null): HTMLElement {
  return {
    parentElement: null,
    innerText: text,
    textContent: text,
    getAttribute: (name: string) => name === 'aria-label' ? ariaLabel : null,
    querySelectorAll: () => [],
  } as unknown as HTMLElement
}

describe('detail button placement', () => {
  it('targets LinkedIn job detail action controls before falling back', () => {
    expect(DETAIL_ACTION_CONTROL_SELECTORS[0]).toContain('jobs-s-apply')
    expect(DETAIL_ACTION_CONTROL_SELECTORS).toContain('.jobs-details__main-content .jobs-apply-button')
    expect(DETAIL_ACTION_CONTROL_SELECTORS).toContain('.jobs-save-button')
  })

  it('uses the LinkedIn Apply/Saved action row for the native Unsave control', () => {
    const savedControl = fakeElement('', 'Unsave the job')
    const savedWrapper = fakeElement('Saved')
    const actionRow = fakeElement('ApplySaved')
    savedControl.parentElement = savedWrapper
    savedWrapper.parentElement = actionRow

    expect(LINKEDIN_NATIVE_SAVE_CONTROL_SELECTOR).toContain('button[aria-label="Unsave the job"]')
    expect(findLinkedInNativeSaveActionRow(savedControl)).toBe(actionRow)
  })

  it('mounts beside the Indeed detail-page apply controls', () => {
    expect(DETAIL_ACTION_HOST_SELECTORS).toContain('#viewJobButtonLinkContainer')
    expect(DETAIL_ACTION_HOST_SELECTORS).toContain('#applyButtonLinkContainer')
    expect(DETAIL_ACTION_CONTROL_SELECTORS).toContain('#indeedApplyButton')
  })
})
