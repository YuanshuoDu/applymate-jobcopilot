import type { FilledField, FormFieldSchema } from './types'

/** Shared by the packaged scanner and the self-contained injected scanner. */
export const SENSITIVE_FIELD_PATTERN = String.raw`password|passwd|passcode|one[-\s_]?time|otp|token|secret|security[\s_-]?code|verification[\s_-]?code|cvv|cvc|card[\s_-]?(?:number|holder|expiry|expiration)|(?:credit|debit)[\s_-]?card|\bcc[-\s_](?:name|number|exp|csc)|\biban\b|bank[\s_-]?(?:account|routing)|social[\s_-]?security|\bssn\b|\bpin\b`
const sensitiveField = new RegExp(SENSITIVE_FIELD_PATTERN, 'i')

/** Form values must not become another field's label or contextual text. */
export const FORM_VALUE_TEXT_SELECTOR = 'input, textarea, select, option, output, button, [contenteditable], [role="textbox"], [role="searchbox"], [role="combobox"], [role="listbox"], [role="spinbutton"], [role="slider"], [role="button"], script, style, template, noscript, [hidden], [aria-hidden="true"], [inert]'

export function readStaticFormLabel(element: Element | null): string {
  if (!element || element.closest(FORM_VALUE_TEXT_SELECTOR)) return ''
  return Array.from(element.childNodes).map(node => {
    if (node.nodeType === 3) return node.nodeValue ?? ''
    return node.nodeType === 1 ? readStaticFormLabel(node as Element) : ''
  }).join(' ')
}

/** Read an editor's own text, excluding nested controls and hidden subtrees. */
export function readFormValueText(element: Element): string {
  const read = (node: Node): string => {
    if (node.nodeType === 3) return node.nodeValue ?? ''
    if (node.nodeType !== 1 || (node as Element).matches(FORM_VALUE_TEXT_SELECTOR)) return ''
    return Array.from(node.childNodes).map(read).join('')
  }
  return Array.from(element.childNodes).map(read).join('')
}

interface FieldMetadata {
  type?: string
  label?: string
  placeholder?: string
  name?: string
  id?: string
  autocomplete?: string
  ariaLabel?: string
  groupName?: string
}

export function isSensitiveFormField(field: FieldMetadata): boolean {
  return field.type?.toLowerCase() === 'password' || sensitiveField.test([
    field.label, field.placeholder, field.name, field.id,
    field.autocomplete, field.ariaLabel, field.groupName,
  ].filter(Boolean).join(' '))
}

/** Defense in depth before initial analysis and before revision payloads. */
export function filterSafeFormFields(fields: FormFieldSchema[]): FormFieldSchema[] {
  return fields.filter(field => !isSensitiveFormField(field))
}

export function filterSafeFormRevision(fields: FormFieldSchema[], previousFill: FilledField[]) {
  const safeFields = filterSafeFormFields(fields)
  const safeIds = new Set(safeFields.map(field => field.id))
  return {
    fields: safeFields,
    previousFill: previousFill.filter(field => safeIds.has(field.fieldId)),
  }
}

/** Remote responses provide values only for the safe field IDs we supplied. */
export function mergeSafeFormAnswers(fields: FormFieldSchema[], previous: FilledField[], updates: unknown): FilledField[] {
  const safe = filterSafeFormRevision(fields, previous)
  const ids = new Set(safe.fields.map(field => field.id))
  const answers = new Map(safe.previousFill.map(answer => [answer.fieldId, answer]))
  for (const update of Array.isArray(updates) ? updates as unknown[] : []) {
    if (!update || typeof update !== 'object') continue
    const answer = update as Record<string, unknown>
    if (typeof answer.fieldId !== 'string' || !ids.has(answer.fieldId) || typeof answer.value !== 'string') continue
    answers.set(answer.fieldId, {
      fieldId: answer.fieldId, value: answer.value,
      confidence: typeof answer.confidence === 'number' && Number.isFinite(answer.confidence) ? Math.max(0, Math.min(1, answer.confidence)) : 0,
      reasoning: typeof answer.reasoning === 'string' ? answer.reasoning : '',
      skip: answer.skip === true, personaRelevant: answer.personaRelevant === true,
    })
  }
  return safe.fields.flatMap(field => answers.has(field.id) ? [answers.get(field.id)!] : [])
}
