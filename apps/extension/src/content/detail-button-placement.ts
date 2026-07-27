/** Containers that already own the native job-detail action row. */
export const DETAIL_ACTION_HOST_SELECTORS = [
  // Indeed split-view and standalone job detail pages.
  '#viewJobButtonLinkContainer',
  '[data-testid="viewJobButtonLinkContainer"]',
  '#applyButtonLinkContainer',
  // LinkedIn action groups (class names vary between rollout cohorts).
  '.jobs-unified-top-card__content--two-pane .jobs-unified-top-card__actions',
  '.jobs-unified-top-card__content .jobs-unified-top-card__actions',
]

/** Native controls whose parent is the action-row host. */
export const DETAIL_ACTION_CONTROL_SELECTORS = [
  '.jobs-unified-top-card__content--two-pane .jobs-s-apply',
  '.jobs-unified-top-card__content .jobs-s-apply',
  '.jobs-details__main-content .jobs-s-apply',
  '.jobs-details__main-content .jobs-apply-button',
  '.jobs-unified-top-card__content .jobs-apply-button',
  '[data-live-test-job-apply-button]',
  '.jobs-apply-button--top-card',
  '.jobs-save-button',
  '#indeedApplyButton',
  '.jobsearch-IndeedApplyButton',
]

/**
 * LinkedIn's current Saved button does not consistently keep any of the
 * historical `jobs-*` classes.  Its accessible label is stable, though.
 * Keep this separate from the generic control selectors because its immediate
 * parent is only the Saved-button wrapper; the action row is one level higher.
 */
export const LINKEDIN_NATIVE_SAVE_CONTROL_SELECTOR = [
  'button[aria-label="Unsave the job"]',
  'button[aria-label="Save the job"]',
  '[role="button"][aria-label="Unsave the job"]',
  '[role="button"][aria-label="Save the job"]',
].join(', ')

const LINKEDIN_DETAIL_SCOPE_SELECTOR = [
  '.jobs-search__job-details--container',
  '.scaffold-layout__detail',
  '.job-view-layout',
  '.jobs-details__main-content',
].join(', ')

const INDEED_DETAIL_SCOPE_SELECTOR = [
  '#jobsearch-ViewjobPaneWrapper',
  '.jobsearch-ViewJobLayout--embedded',
  '.jobsearch-JobComponent',
  '#vjs-container',
  '#vjs-details',
  '#viewJobSSRRoot',
].join(', ')

function actionText(el: HTMLElement): string {
  return [
    el.getAttribute('aria-label'),
    el.innerText,
    el.textContent,
  ].filter(Boolean).join(' ').trim()
}

function looksLikeApplyAction(el: HTMLElement): boolean {
  return /\b(?:easy\s+)?apply(?:\s+now)?\b/i.test(actionText(el))
}

function looksLikeIndeedAction(el: HTMLElement): boolean {
  return /\b(?:apply|save|saved|bookmark|share|dislike|not\s+interested)\b/i.test(actionText(el))
}

/** Find Indeed's shared Apply/bookmark/dislike/share row across UI rollouts. */
export function findIndeedNativeActionRow(doc: Document): HTMLElement | null {
  const scope = doc.querySelector(INDEED_DETAIL_SCOPE_SELECTOR)
  if (!(scope instanceof HTMLElement)) return null

  const controls = Array.from(scope.querySelectorAll<HTMLElement>('button, a, [role="button"]'))
    .filter(looksLikeIndeedAction)
  const anchor = controls.find((control) => /\b(?:save|saved|bookmark|share|dislike|not\s+interested)\b/i.test(actionText(control)))
    ?? controls.find((control) => looksLikeApplyAction(control))
  if (!anchor) return null

  let candidate: HTMLElement | null = anchor
  for (let depth = 0; candidate && depth < 6; depth += 1) {
    const rowControls = Array.from(candidate.querySelectorAll<HTMLElement>('button, a, [role="button"]'))
    const actionCount = rowControls.filter(looksLikeIndeedAction).length
    if (actionCount >= 2) return candidate
    candidate = candidate.parentElement
  }
  return anchor.parentElement ?? anchor
}

/** @internal Exported for the action-row regression test. */
export function findLinkedInNativeSaveActionRow(saveControl: HTMLElement): HTMLElement {
  let candidate = saveControl.parentElement

  // LinkedIn currently renders:
  //   button[aria-label="Unsave the job"] → Saved wrapper → Apply/Saved row.
  // Prefer the smallest ancestor that owns both actions rather than attaching
  // to the Saved wrapper (or, worse, the document body).
  for (let depth = 0; candidate && depth < 4; depth += 1) {
    const text = actionText(candidate)
    if (/apply\s*(?:un)?saved?/i.test(text)) return candidate

    const controls = Array.from(candidate.querySelectorAll<HTMLElement>('button, a, [role="button"]'))
    if (controls.some((control) => control !== saveControl && looksLikeApplyAction(control))) {
      return candidate
    }
    candidate = candidate.parentElement
  }

  // The known two-wrapper structure is still a better inline anchor than a
  // body fallback if LinkedIn removes the Apply sibling while loading.
  return saveControl.parentElement?.parentElement ?? saveControl.parentElement ?? saveControl
}

function findLinkedInNativeSaveActionHost(doc: Document): HTMLElement | null {
  const controls = Array.from(doc.querySelectorAll<HTMLElement>(LINKEDIN_NATIVE_SAVE_CONTROL_SELECTOR))
  if (controls.length === 0) return null

  // If a results list also contains a Saved button, choose the one in the
  // visible detail pane. If LinkedIn exposes only one matching control, it is
  // safe to use it even during a class-name rollout.
  const detailControl = controls.find((control) => control.closest(LINKEDIN_DETAIL_SCOPE_SELECTOR))
  return findLinkedInNativeSaveActionRow(detailControl ?? controls[0])
}

export function findDetailActionHost(doc: Document): HTMLElement | null {
  const indeedNativeHost = findIndeedNativeActionRow(doc)
  if (indeedNativeHost) return indeedNativeHost

  const linkedInNativeHost = findLinkedInNativeSaveActionHost(doc)
  if (linkedInNativeHost) return linkedInNativeHost

  for (const selector of DETAIL_ACTION_HOST_SELECTORS) {
    const el = doc.querySelector(selector)
    if (!(el instanceof HTMLElement)) continue
    return el
  }

  for (const selector of DETAIL_ACTION_CONTROL_SELECTORS) {
    const el = doc.querySelector(selector)
    if (!(el instanceof HTMLElement)) continue
    return el.parentElement ?? el
  }

  // Last-resort semantic lookup, intentionally constrained to a job-detail
  // pane so a list-card "Apply"/"Saved" control cannot become the host.
  const detailScopes = [
    '.jobs-details__main-content',
    '.jobs-unified-top-card__content',
    '#jobsearch-ViewjobPaneWrapper',
    '#vjs-container',
  ]
  for (const scopeSelector of detailScopes) {
    const scope = doc.querySelector(scopeSelector)
    if (!(scope instanceof HTMLElement)) continue
    const controls = scope.querySelectorAll<HTMLElement>('button, a')
    for (const control of controls) {
      const label = (control.innerText || control.getAttribute('aria-label') || '').trim()
      if (/^(easy apply|apply|apply now|apply on company site|continue to apply|save|saved)\b/i.test(label)) {
        return control.parentElement ?? control
      }
    }
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
