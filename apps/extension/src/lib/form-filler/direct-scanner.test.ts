import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { scanDocumentFields } from './direct-scanner'
import { filterSafeFormRevision, FORM_VALUE_TEXT_SELECTOR, SENSITIVE_FIELD_PATTERN } from './field-safety'
import type { FormFieldSchema } from './types'

interface FixtureOptions {
  tag?: string
  attributes?: Record<string, string | undefined>
  value?: string
  checked?: boolean
  disabled?: boolean
  hiddenAncestor?: boolean
  noLayout?: boolean
  style?: Partial<CSSStyleDeclaration>
  options?: Array<{ textContent: string; value: string }>
  rejectValueRead?: boolean
}

function control(options: FixtureOptions = {}) {
  const attributes = options.attributes ?? {}
  const readValue = vi.fn(() => {
    if (options.rejectValueRead) throw new Error('Sensitive value was accessed')
    return options.value ?? ''
  })
  return {
    tagName: (options.tag ?? 'input').toUpperCase(),
    getAttribute: (name: string) => attributes[name] ?? null,
    hasAttribute: (name: string) => name in attributes,
    matches: () => options.disabled ?? false,
    closest: (selector: string) => selector.startsWith('[hidden]') && options.hiddenAncestor ? {} : null,
    getClientRects: () => options.noLayout ? [] : [{}],
    textContent: '',
    name: attributes.name,
    checked: options.checked ?? false,
    options: options.options ?? [],
    style: { display: 'block', visibility: 'visible', opacity: '1', ...options.style },
    get value() { return readValue() },
    readValue,
  }
}

/** Exercise the serialized function exactly as executeScript does, without module closures. */
function injectScan(elements: ReturnType<typeof control>[], documentOverrides: Record<string, unknown> = {}): FormFieldSchema[] {
  return runInNewContext(`(${scanDocumentFields.toString()})(pattern, valueTextSelector)`, {
    pattern: SENSITIVE_FIELD_PATTERN,
    valueTextSelector: FORM_VALUE_TEXT_SELECTOR,
    document: {
      querySelector: () => null,
      getElementById: () => null,
      querySelectorAll: (selector: string) => selector === 'input[type="radio"]'
        ? elements.filter(element => element.getAttribute('type') === 'radio') : elements,
      ...documentOverrides,
    },
    CSS: { escape: (value: string) => value },
    getComputedStyle: (element: ReturnType<typeof control>) => element.style,
  }) as FormFieldSchema[]
}

describe('injected direct form scanner', () => {
  it.each([
    { type: 'password', 'aria-label': 'Answer', name: 'answer' },
    { type: 'text', name: 'otp', 'aria-label': 'Answer' },
    { type: 'text', autocomplete: 'one-time-code', 'aria-label': 'Answer' },
    { type: 'text', autocomplete: 'current-password', 'aria-label': 'Answer' },
    { type: 'text', autocomplete: 'cc-number', 'aria-label': 'Number' },
    { type: 'text', autocomplete: 'cc-exp', 'aria-label': 'Expiry' },
    { type: 'text', id: 'access_token', 'aria-label': 'Answer' },
    { type: 'text', name: 'bank_account', 'aria-label': 'Answer' },
    { type: 'text', 'aria-label': 'SSN' },
  ])('rejects a sensitive control before reading value: %o', attributes => {
    const secret = control({ attributes, rejectValueRead: true })
    expect(injectScan([secret])).toEqual([])
    expect(secret.readValue).not.toHaveBeenCalled()
  })

  it.each([
    { disabled: true },
    { hiddenAncestor: true },
    { noLayout: true },
    { style: { display: 'none' } },
    { style: { visibility: 'hidden' } },
    { style: { visibility: 'collapse' } },
    { style: { opacity: '0' } },
  ])('rejects hidden or disabled controls before reading value: %o', hidden => {
    const element = control({ ...hidden, attributes: { name: 'answer' }, rejectValueRead: true })
    expect(injectScan([element])).toEqual([])
    expect(element.readValue).not.toHaveBeenCalled()
  })

  it('preserves ordinary application fields, options, values and stable IDs', () => {
    const elements = [
      control({ attributes: { name: 'fullName', required: '' }, value: 'Candidate' }),
      control({ attributes: { name: 'email', type: 'email' }, value: 'candidate@example.com' }),
      control({ tag: 'select', attributes: { name: 'location' }, value: 'IE', options: [{ textContent: 'Ireland', value: 'IE' }] }),
      control({ attributes: { name: 'available', type: 'checkbox' }, checked: true, value: 'yes' }),
      control({ attributes: { name: 'resume', type: 'file' }, rejectValueRead: true }),
    ]
    const result = injectScan(elements)
    expect(result.map(item => [item.label, item.type, item.currentValue])).toEqual([
      ['full Name', 'text', 'Candidate'], ['email', 'email', 'candidate@example.com'],
      ['location', 'select', 'IE'], ['available', 'checkbox', 'yes'], ['resume', 'file', undefined],
    ])
    expect(result[0].required).toBe(true)
    expect(result[2].options).toEqual(['Ireland'])
    expect(result.map(item => item.id)).toEqual(injectScan(elements).map(item => item.id))
  })

  it('never carries a password through scan, preview values and the revision payload', () => {
    const scanned = injectScan([
      control({ attributes: { type: 'password', name: 'answer', 'aria-label': 'Your answer' }, value: 'must-not-leave-browser', rejectValueRead: true }),
      control({ attributes: { name: 'fullName' }, value: 'Candidate' }),
    ]).map(field => ({ ...field, id: `frame|4|${field.id}`, frameId: 4 }))
    const revision = filterSafeFormRevision(scanned, scanned.map(field => ({
      fieldId: field.id, value: field.currentValue ?? '', confidence: 1, reasoning: '', skip: false,
    })))
    expect(revision.fields).toHaveLength(1)
    expect(revision.fields[0].frameId).toBe(4)
    expect(JSON.stringify(revision)).not.toContain('must-not-leave-browser')
  })

  it('does not read a sibling OTP from a shared fieldset as another field’s context', () => {
    const name = control({ attributes: { name: 'first_name' }, value: 'Candidate' })
    const otp = control({ tag: 'div', attributes: { name: 'otp', 'aria-label': 'OTP', contenteditable: 'true', role: 'textbox' }, rejectValueRead: true })
    const readOtpText = vi.fn(() => 'opaque-user-secret')
    Object.defineProperty(otp, 'textContent', { get: readOtpText })
    const readSharedText = vi.fn(() => `First name ${otp.textContent}`)
    const sharedFieldset = {
      querySelector: () => null,
      get textContent() { return readSharedText() },
    }
    for (const element of [name, otp]) {
      Object.assign(element, { closest: (selector: string) => selector.startsWith('[hidden]') ? null : sharedFieldset })
    }
    const scanned = injectScan([name, otp])
    const revision = filterSafeFormRevision(scanned, scanned.map(field => ({
      fieldId: field.id, value: field.currentValue ?? '', confidence: 1, reasoning: '', skip: false,
    })))
    expect(scanned).toHaveLength(1)
    expect(scanned[0]).toMatchObject({ label: 'first name', surroundingText: '', currentValue: 'Candidate' })
    expect(readSharedText).not.toHaveBeenCalled()
    expect(readOtpText).not.toHaveBeenCalled()
    expect(otp.readValue).not.toHaveBeenCalled()
    expect(JSON.stringify(revision)).not.toContain('opaque-user-secret')
  })

  it.each(['for', 'aria-labelledby'])('does not take editable values from a mixed %s label subtree', source => {
    const name = control({ attributes: { name: 'first_name', ...(source === 'for' ? { id: 'name' } : { 'aria-labelledby': 'name-label' }) }, value: 'Candidate' })
    const readSecretNodes = vi.fn(() => { throw new Error('Editable subtree was read as label') })
    const editable = {
      nodeType: 1,
      closest: () => editable,
      get childNodes() { return readSecretNodes() },
    }
    const label = {
      closest: () => null,
      childNodes: [{ nodeType: 3, nodeValue: 'First name' }, editable],
      get textContent() { throw new Error('Unfiltered mixed label was read') },
    }
    const scanned = injectScan([name], {
      querySelector: () => source === 'for' ? label : null,
      getElementById: () => source === 'aria-labelledby' ? label : null,
    })
    expect(scanned[0]).toMatchObject({ label: 'First name', currentValue: 'Candidate', surroundingText: '' })
    expect(readSecretNodes).not.toHaveBeenCalled()
  })
})
