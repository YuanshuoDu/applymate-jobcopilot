import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findCurrentField, isSafeLiveField, readCurrentFieldValues } from './live-fields'
import { fillField, fillFields, openUploadPicker, setElementValue } from './auto-fill'
import { generateId } from './form-scanner'
import type { FormFieldSchema } from './types'

class Control {
  tagName = 'INPUT'
  attrs: Record<string, string>
  ownerDocument!: Document
  isConnected = true
  style: Record<string, string> = {}
  computed = { display: 'block', visibility: 'visible', opacity: '1' }
  nested: Control[] = []
  childNodes: Node[] = []
  storedValue = 'Candidate'
  valueReads = 0
  valueWrites = 0
  checked = false
  forbidRead = false
  click = vi.fn()
  addEventListener = vi.fn()
  dispatchEvent = vi.fn()
  constructor(attrs: Record<string, string> = {}) { this.attrs = { name: 'first_name', type: 'text', ...attrs } }
  get value() { this.valueReads++; if (this.forbidRead) throw new Error('Sensitive value read'); return this.storedValue }
  set value(value: string) { this.valueWrites++; this.storedValue = value }
  get type() { return this.attrs.type ?? '' }
  get name() { return this.attrs.name ?? '' }
  getAttribute(name: string) { return this.attrs[name] ?? null }
  setAttribute(name: string, value: string) { this.attrs[name] = value }
  closest(selector: string) { return selector.includes('[hidden]') && ('hidden' in this.attrs || this.attrs['aria-hidden'] === 'true') ? this : null }
  matches(selector: string) {
    if (selector.includes(':disabled')) return 'disabled' in this.attrs || this.attrs['aria-disabled'] === 'true' || ['hidden', 'submit', 'button', 'reset'].includes(this.type)
    return ['INPUT', 'TEXTAREA', 'SELECT'].includes(this.tagName) || 'contenteditable' in this.attrs || ['textbox', 'combobox'].includes(this.attrs.role)
  }
  getClientRects() { return [{}] }
  querySelectorAll() { return this.nested }
  querySelector() { return this.nested.find(el => ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) ?? null }
}

let mainFields: Control[]
let childFields: Control[]
let doc: Document
let childDoc: Document
let iframeReads: number

function addField(attrs: Record<string, string> = {}, child = false): Control {
  const field = new Control(attrs)
  field.ownerDocument = child ? childDoc : doc
  ;(child ? childFields : mainFields).push(field)
  return field
}
function asElement(control: Control) { return control as unknown as HTMLElement }
function schemaFor(control: Control): FormFieldSchema {
  return { id: `frame|0|${generateId(asElement(control))}`, type: 'text', label: 'First name', required: false, surroundingText: '' }
}

beforeEach(() => {
  mainFields = []; childFields = []; iframeReads = 0
  childDoc = { querySelectorAll: () => childFields } as unknown as Document
  const iframe = { get contentDocument() { iframeReads++; return childDoc } }
  doc = {
    querySelector: () => null,
    querySelectorAll: (selector: string) => selector === 'iframe' ? [iframe] : selector === 'input[type="radio"]' ? mainFields.filter(field => field.type === 'radio') : mainFields,
  } as unknown as Document
  vi.stubGlobal('document', doc)
  vi.stubGlobal('CSS', { escape: (text: string) => text })
  vi.stubGlobal('getComputedStyle', (control: Control) => control.computed)
  vi.stubGlobal('HTMLInputElement', Control)
  vi.stubGlobal('FocusEvent', Event)
  vi.useFakeTimers()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('current document reads', () => {
  it('reads a normal field without visiting a same-origin iframe with the same field ID', () => {
    const normal = addField()
    const password = addField({ type: 'password' }, true)
    password.forbidRead = true
    const id = schemaFor(normal).id
    expect(readCurrentFieldValues([id])).toEqual([{ fieldId: id, value: 'Candidate' }])
    expect(iframeReads).toBe(0)
    expect(password.valueReads).toBe(0)
  })

  it('does not recover a removed main-page field from an iframe', () => {
    const normal = addField()
    const id = schemaFor(normal).id
    mainFields.length = 0
    const password = addField({ type: 'password' }, true)
    password.forbidRead = true
    expect(readCurrentFieldValues([id])).toEqual([])
    expect(iframeReads).toBe(0)
    expect(password.valueReads).toBe(0)
  })

  it.each([
    { type: 'password' }, { 'aria-label': 'OTP' }, { autocomplete: 'one-time-code' },
    { placeholder: 'Security code' }, { disabled: '' }, { hidden: '' },
  ])('revalidates changed DOM metadata before reading: %o', changed => {
    const normal = addField()
    const id = schemaFor(normal).id
    Object.assign(normal.attrs, changed)
    normal.forbidRead = true
    expect(readCurrentFieldValues([id])).toEqual([])
    expect(normal.valueReads).toBe(0)
  })

  it('excludes controls hidden with CSS after scanning', () => {
    const normal = addField()
    const id = schemaFor(normal).id
    normal.computed.display = 'none'
    normal.forbidRead = true
    expect(readCurrentFieldValues([id])).toEqual([])
    expect(normal.valueReads).toBe(0)
  })

  it('does not read a contenteditable container carrying a nested OTP field', () => {
    const editor = addField({ contenteditable: 'true', role: 'textbox' })
    editor.tagName = 'DIV'
    const id = schemaFor(editor).id
    const otp = new Control({ 'aria-label': 'OTP' })
    otp.ownerDocument = doc
    otp.forbidRead = true
    editor.nested = [otp]
    Object.defineProperty(editor, 'childNodes', { get() { throw new Error('Sensitive editor subtree read') } })
    expect(readCurrentFieldValues([id])).toEqual([])
    expect(otp.valueReads).toBe(0)
  })

  it('requires the actual current document even for a direct helper call', () => {
    const child = addField({}, true)
    expect(isSafeLiveField(asElement(child))).toBe(false)
  })
})

describe('current document fill and picker boundaries', () => {
  it('fills an ordinary reviewed field in the selected document', () => {
    const normal = addField()
    const schema = schemaFor(normal)
    const result = fillFields([{ fieldId: schema.id, value: 'Updated', skip: false, confidence: 1, reasoning: '' }], [schema])
    expect(result).toEqual({ success: true, failed: [], filled: 1 })
    expect(normal.storedValue).toBe('Updated')
    expect(iframeReads).toBe(0)
  })

  it('does not fill a same-name iframe field when the main field was removed', () => {
    const normal = addField()
    const schema = schemaFor(normal)
    mainFields.length = 0
    const child = addField({}, true)
    expect(fillField(schema, 'Reviewed private answer').success).toBe(false)
    expect(child.valueWrites).toBe(0)
    expect(iframeReads).toBe(0)
  })

  it('keeps same-document label recovery for a rebuilt Workday control', () => {
    const normal = addField({ 'aria-label': 'First name' })
    const schema = schemaFor(normal)
    normal.attrs.name = 'rebuilt_name_control'
    expect(fillField(schema, 'Updated').success).toBe(true)
    expect(normal.storedValue).toBe('Updated')
  })

  it('refuses unknown remote field IDs without a reviewed schema', () => {
    const normal = addField()
    const id = schemaFor(normal).id
    expect(fillFields([{ fieldId: id, value: 'Unreviewed', skip: false, confidence: 1, reasoning: '' }], [])).toEqual({ success: false, failed: [id], filled: 0 })
    expect(normal.valueWrites).toBe(0)
  })

  it.each([{ type: 'password' }, { 'aria-label': 'OTP' }, { autocomplete: 'cc-number' }, { disabled: '' }])('refuses changed sensitive/disabled controls during filling: %o', changed => {
    const normal = addField()
    const schema = schemaFor(normal)
    Object.assign(normal.attrs, changed)
    expect(fillField(schema, 'Reviewed answer').success).toBe(false)
    expect(normal.valueWrites).toBe(0)
    expect(() => setElementValue(asElement(normal), 'Direct answer', schema)).toThrow(/not safe/)
  })

  it('does not use old ambiguous iframe-prefixed IDs', () => {
    const normal = addField()
    const id = `iframe|https://company.test/embedded|${generateId(asElement(normal))}`
    expect(findCurrentField(id, { ...schemaFor(normal), id })).toBeNull()
  })

  it('opens only a current-document reviewed upload field', () => {
    const upload = addField({ name: 'resume_upload', type: 'file' })
    const id = schemaFor(upload).id
    expect(openUploadPicker(id, () => {}).success).toBe(true)
    expect(upload.click).toHaveBeenCalledOnce()
    mainFields.length = 0
    const child = addField({ name: 'resume_upload', type: 'file' }, true)
    expect(openUploadPicker(id, () => {}).success).toBe(false)
    expect(child.click).not.toHaveBeenCalled()
    expect(iframeReads).toBe(0)
  })
})
