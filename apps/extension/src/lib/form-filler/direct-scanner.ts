import type { FormFieldSchema } from './types'

/** Chrome serializes this function: keep every runtime dependency inside it. */
export function scanDocumentFields(sensitivePattern: string, valueTextSelector: string): FormFieldSchema[] {
  if (!sensitivePattern || !valueTextSelector) return []
  const sensitiveField = new RegExp(sensitivePattern, 'i')
  const hash = (value: string) => {
    let result = 0
    for (let index = 0; index < value.length; index++) {
      result = ((result << 5) - result) + value.charCodeAt(index)
      result |= 0
    }
    return Math.abs(result).toString(36)
  }
  const clean = (value: string) => value.replace(/\s+/g, ' ').replace(/\*/g, '').trim()
  const humanize = (value: string) => clean(value
    .replace(/[-_.:[\]]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2'))
  // Match readStaticFormLabel without a module closure: this function is
  // serialized into the page. Never read textContent on a mixed label/value subtree.
  const labelText = (element: Element | null): string => {
    if (!element || element.closest(valueTextSelector)) return ''
    return Array.from(element.childNodes).map(node => {
      if (node.nodeType === 3) return node.nodeValue ?? ''
      return node.nodeType === 1 ? labelText(node as Element) : ''
    }).join(' ')
  }
  const labelFor = (element: HTMLElement) => {
    const id = element.getAttribute('id')
    if (id) {
      const label = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`)
      const text = labelText(label)
      if (text.trim()) return clean(text)
    }
    const aria = element.getAttribute('aria-label')
    if (aria) return clean(aria)
    const labelledBy = element.getAttribute('aria-labelledby')
    if (labelledBy) {
      const label = document.getElementById(labelledBy.split(/\s+/)[0])
      const text = labelText(label)
      if (text.trim()) return clean(text)
    }
    const container = element.closest(
      '[data-automation-id^="formField-"], label, fieldset, [class*="form-field"], [class*="fieldWrapper"]',
    )
    const nearbyLabel = container?.querySelector('label, legend, [data-automation-id*="label"]')
    const nearbyText = labelText(nearbyLabel ?? null)
    if (nearbyText.trim()) return clean(nearbyText)
    const name = element.getAttribute('name')
    if (name) return humanize(name)
    const placeholder = element.getAttribute('placeholder')
    return placeholder ? clean(placeholder) : ''
  }

  const selector =
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), ' +
    'textarea, select, [contenteditable="true"], [role="combobox"], [role="textbox"], ' +
    '[role="radiogroup"], [role="checkbox"], [role="switch"]'
  const elements = Array.from(document.querySelectorAll<HTMLElement>(selector))
  const seen = new Set<string>()

  return elements.flatMap(element => {
    // Reject inaccessible controls before reading their values, including
    // descendants of hidden/disabled containers and CSS-hidden elements.
    if (element.matches(':disabled, [disabled], [aria-disabled="true"]') ||
        element.closest('[hidden], [aria-hidden="true"], [inert], [aria-disabled="true"]')) return []
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' ||
        style.visibility === 'collapse' || style.opacity === '0' || element.getClientRects().length === 0) return []

    const tag = element.tagName.toLowerCase()
    const inputType = (element.getAttribute('type') ?? '').toLowerCase()
    const role = (element.getAttribute('role') ?? '').toLowerCase()
    const label = labelFor(element)
    const name = element.getAttribute('name') ?? ''
    const elementId = element.getAttribute('id') ?? ''
    const metadata = [label, name, elementId, element.getAttribute('autocomplete'),
      element.getAttribute('placeholder'), element.getAttribute('aria-label')].filter(Boolean).join(' ')
    // Preserve the real input type for this check; password must never become
    // a generic text field or enter currentValue, preview, or an AI payload.
    if (inputType === 'password' || sensitiveField.test(metadata)) return []

    const rawId = name
      ? `n-${hash(name)}`
      : `l-${hash([elementId, label, inputType || tag].filter(Boolean).join('|'))}`
    if (seen.has(rawId)) return []
    seen.add(rawId)

    let type: FormFieldSchema['type'] = 'text'
    if (tag === 'textarea' || role === 'textbox' || element.getAttribute('contenteditable') === 'true') type = 'textarea'
    else if (tag === 'select' || role === 'combobox') type = 'select'
    else if (role === 'radiogroup' || inputType === 'radio') type = 'radio'
    else if (role === 'checkbox' || role === 'switch' || inputType === 'checkbox') type = 'checkbox'
    else if (['email', 'tel', 'url', 'number', 'date', 'file'].includes(inputType)) type = inputType as FormFieldSchema['type']

    let options: string[] | undefined
    if (tag === 'select') {
      options = Array.from((element as HTMLSelectElement).options)
        .map(option => clean(option.textContent ?? option.value))
        .filter(Boolean)
    } else if (inputType === 'radio' && name) {
      options = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
        .filter(input => input.name === name)
        .map(input => labelFor(input) || input.value)
        .filter(Boolean)
    }

    const input = element as HTMLInputElement
    const currentValue = inputType === 'file' ? undefined
      : inputType === 'checkbox' || inputType === 'radio'
        ? (input.checked ? input.value || 'true' : undefined)
        : (input.value || element.textContent?.trim() || undefined)

    return [{
      id: rawId,
      type,
      label,
      placeholder: element.getAttribute('placeholder') ?? undefined,
      options,
      required: element.hasAttribute('required') || element.getAttribute('aria-required') === 'true',
      // Wide containers can contain sibling passwords/OTP rich-text values.
      // Labels, placeholders and options provide context without collecting them.
      surroundingText: '',
      groupName: name || undefined,
      currentValue,
    }]
  })
}
