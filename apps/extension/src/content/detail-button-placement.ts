export const DETAIL_ACTION_HOST_SELECTORS = [
  '.jobs-unified-top-card__content--two-pane .jobs-s-apply',
  '.jobs-unified-top-card__content .jobs-s-apply',
  '.jobs-details__main-content .jobs-s-apply',
  '.jobs-apply-button--top-card',
  '.jobs-save-button',
]

export function findDetailActionHost(doc: Pick<Document, 'querySelector'>): HTMLElement | null {
  for (const selector of DETAIL_ACTION_HOST_SELECTORS) {
    const el = doc.querySelector(selector)
    if (!(el instanceof HTMLElement)) continue
    return el.parentElement ?? el
  }
  return null
}

export function mountDetailButtonContainer(wrap: HTMLElement, doc: Document = document) {
  const host = findDetailActionHost(doc)

  if (host) {
    host.appendChild(wrap)
    return 'inline'
  }

  doc.body.appendChild(wrap)
  return 'floating'
}
