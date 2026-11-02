import { describe, expect, it } from 'vitest'
import { filterSafeFormFields, filterSafeFormRevision, isSensitiveFormField, readStaticFormLabel } from './field-safety'
import type { FilledField, FormFieldSchema } from './types'

const field = (id: string, label: string, currentValue?: string): FormFieldSchema => ({
  id, label, currentValue, type: 'text', required: false, surroundingText: '',
})
const fill = (fieldId: string, value: string): FilledField => ({
  fieldId, value, confidence: 1, reasoning: '', skip: false,
})

describe('form data safety boundaries', () => {
  it.each([
    { type: 'PASSWORD', label: 'Your answer' },
    { autocomplete: 'one-time-code', label: 'Code' },
    { name: 'verification_code' },
    { name: 'access_token' },
    { autocomplete: 'cc-number' },
    { autocomplete: 'cc-exp' },
    { label: 'Bank account' },
    { label: 'IBAN' },
    { label: 'Social Security Number' },
    { placeholder: 'CVV' },
  ])('recognizes credential or payment metadata: %o', metadata => {
    expect(isSensitiveFormField(metadata)).toBe(true)
  })

  it.each(['Full name', 'Expected salary', 'Phone number', 'Work authorization', 'Notice period', 'Portfolio URL'])('keeps ordinary application field %s', label => {
    expect(isSensitiveFormField({ label })).toBe(false)
  })

  it('excludes sensitive current values from initial analysis payloads', () => {
    const safe = filterSafeFormFields([
      field('name', 'Full name', 'Candidate'),
      field('password', 'Password', 'secret-before-ai'),
      { ...field('otp', 'Answer', 'secret-otp'), groupName: 'verification_code' },
    ])
    expect(safe.map(item => item.id)).toEqual(['name'])
    expect(JSON.stringify({ fields: safe })).not.toContain('secret-')
  })

  it('excludes both field schemas and previous answers before revision leaves the extension', () => {
    const safe = filterSafeFormRevision([
      field('frame|0|name', 'Full name', 'Candidate'),
      field('frame|7|password', 'Password', 'secret-password'),
      field('frame|7|card', 'Card number', 'secret-card'),
    ], [
      fill('frame|0|name', 'Candidate'),
      fill('frame|7|password', 'secret-password'),
      fill('frame|7|card', 'secret-card'),
      fill('not-a-scanned-field', 'secret-unknown'),
    ])
    expect(safe.fields.map(item => item.id)).toEqual(['frame|0|name'])
    expect(safe.previousFill.map(item => item.fieldId)).toEqual(['frame|0|name'])
    expect(JSON.stringify(safe)).not.toContain('secret-')
  })

  it('reads label text without traversing excluded value subtrees', () => {
    const excluded = {
      nodeType: 1,
      closest: () => excluded,
      get childNodes() { throw new Error('A value subtree must not be inspected') },
    }
    const label = {
      closest: () => null,
      childNodes: [{ nodeType: 3, nodeValue: 'First name' }, excluded],
      get textContent() { throw new Error('Mixed label text must not be read') },
    } as unknown as Element
    expect(readStaticFormLabel(label).trim()).toBe('First name')
  })
})
