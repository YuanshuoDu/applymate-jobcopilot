import { generateId, extractLabel } from './form-scanner'
import { isSensitiveFormField, readFormValueText } from './field-safety'
import type { FormFieldSchema } from './types'

const FIELD_SELECTOR = 'input, textarea, select, [contenteditable="true"], [role="combobox"], [role="textbox"]'

function hasSensitiveMetadata(el: HTMLElement): boolean {
  return isSensitiveFormField({
    type: el.getAttribute('type') ?? '', name: el.getAttribute('name') ?? '',
    id: el.getAttribute('id') ?? '', autocomplete: el.getAttribute('autocomplete') ?? '',
    placeholder: el.getAttribute('placeholder') ?? '', ariaLabel: el.getAttribute('aria-label') ?? '',
    label: extractLabel(el),
  })
}

/** Revalidate the actual DOM immediately before reading, filling, or opening a picker. */
export function isSafeLiveField(el: HTMLElement): boolean {
  if (el.ownerDocument !== document || !el.isConnected ||
      el.matches(':disabled, [disabled], [aria-disabled="true"], [type="hidden"], [type="submit"], [type="button"], [type="reset"]') ||
      el.closest('[hidden], [aria-hidden="true"], [inert], [aria-disabled="true"]')) return false
  const style = getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
      style.opacity === '0' || el.getClientRects().length === 0 || hasSensitiveMetadata(el)) return false
  // A wrapper must not expose or overwrite a nested password/OTP control.
  return !Array.from(el.querySelectorAll<HTMLElement>(FIELD_SELECTOR)).some(hasSensitiveMetadata)
}

/** Every content-script instance owns one document. Never search child iframes. */
export function findCurrentField(fieldId: string, schema?: FormFieldSchema): HTMLElement | null {
  const cleanId = fieldId.replace(/^frame\|\d+\|/, '')
  if (cleanId.startsWith('iframe|')) return null // Legacy iframe IDs have no document identity.
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(FIELD_SELECTOR))
  const exact = candidates.filter(el => generateId(el) === cleanId)
  if (exact.length) return exact.every(isSafeLiveField) ? exact[0] : null
  if (!schema?.label) return null
  // Workday may rebuild a control with a new generated ID. Only resolve one
  // unambiguous safe label match inside the same document.
  const matches = candidates.filter(el => isSafeLiveField(el) && extractLabel(el).toLowerCase() === schema.label.toLowerCase())
  return matches.length === 1 ? matches[0] : null
}

function readLiveValue(el: HTMLElement): string {
  if (!isSafeLiveField(el)) return ''
  const tag = el.tagName.toLowerCase()
  const input = el as HTMLInputElement
  if (input.type === 'file') return ''
  if (tag === 'select') {
    const select = el as HTMLSelectElement
    return select.options[select.selectedIndex]?.text ?? select.value
  }
  if (input.type === 'checkbox') return input.checked ? 'true' : 'false'
  if (input.type === 'radio') {
    const checked = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
      .find(radio => radio.name === input.name && radio.checked && isSafeLiveField(radio))
    return checked?.value ?? ''
  }
  if (el.getAttribute('contenteditable') === 'true') return readFormValueText(el)
  const nested = el.querySelector<HTMLElement>('input, textarea, select')
  if (nested) return readLiveValue(nested)
  if (el.getAttribute('role') === 'textbox') return readFormValueText(el)
  return input.value ?? ''
}

/** Only requested, currently safe controls in this document may enter Persona refresh. */
export function readCurrentFieldValues(fieldIds: string[]): Array<{ fieldId: string; value: string }> {
  return [...new Set(fieldIds)].flatMap(fieldId => {
    const el = findCurrentField(fieldId)
    return el ? [{ fieldId, value: readLiveValue(el) }] : []
  })
}
