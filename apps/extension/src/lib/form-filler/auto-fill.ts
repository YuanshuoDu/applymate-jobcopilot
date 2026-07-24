/**
 * Auto-Fill Engine — reliably sets values on form fields across
 * native HTML, React, Vue, Svelte, Angular, and custom components.
 */
import type { FormFieldSchema, FilledField } from './types'
import { generateId, extractLabel } from './form-scanner'

export interface FillResult {
  fieldId: string
  success: boolean
  error?: string
}

export function fillField(field: FormFieldSchema, value: string): FillResult {
  const el = resolveElement(field)
  if (!el) return { fieldId: field.id, success: false, error: 'Element not found' }

  try {
    setElementValue(el, value, field)
    highlightElement(el)
    return { fieldId: field.id, success: true }
  } catch (e) {
    return { fieldId: field.id, success: false, error: (e as Error).message }
  }
}

export function fillFields(
  fields: FilledField[],
  schemas: FormFieldSchema[] = [],
): { success: boolean; failed: string[]; filled: number } {
  const failed: string[] = []
  let filled = 0

  console.log('[ApplyMate] fillFields: starting', fields.length, 'fields,', fields.filter(f => !f.skip).length, 'non-skip')
  const docs = getAllDocs()
  console.log('[ApplyMate] fillFields: accessible documents:', docs.length)

  for (const field of fields) {
    if (field.skip) continue

    try {
      // Workday rebuilds dependent controls (such as County) while values are
      // applied. Its generated id can therefore change between Scan and Apply.
      // Retain the scanned schema so we can find the rebuilt control by label.
      const schema = schemas.find(candidate => candidate.id === field.fieldId)
      const result = schema
        ? fillField(schema, field.value)
        : fillFieldById(field.fieldId, field.value)
      if (result.success) filled++
      else {
        console.warn('[ApplyMate] fillFieldById failed:', field.fieldId, result.error)
        failed.push(field.fieldId)
      }
    } catch (e) {
      console.error('[ApplyMate] fillFieldById threw:', field.fieldId, e)
      failed.push(field.fieldId)
    }
  }

  console.log('[ApplyMate] fillFields: done —', filled, 'filled,', failed.length, 'failed')
  return { success: failed.length === 0, failed, filled }
}

/**
 * Opens the browser's native file picker for a scanned upload field. Browsers
 * deliberately do not let extensions select a local file programmatically, so
 * the candidate chooses the reviewed PDF in this picker.
 */
export function openUploadPicker(fieldId: string, onSelected: (fileName: string) => void): FillResult {
  const cleanId = fieldId.replace(/^iframe\|[^|]+\|/, '')
  for (const doc of getAllDocs()) {
    for (const candidate of Array.from(doc.querySelectorAll('input[type="file"]'))) {
      const input = candidate as HTMLInputElement
      const id = generateId(input)
      if (id !== fieldId && id !== cleanId) continue
      input.addEventListener('change', () => onSelected(input.files?.[0]?.name ?? ''), { once: true })
      input.click()
      highlightElement(input)
      return { fieldId, success: true }
    }
  }
  return { fieldId, success: false, error: 'Upload field not found' }
}

// ── Element Resolution ────────────────────────────────────────

/**
 * Get all accessible documents: main document + same-origin iframe documents.
 */
function getAllDocs(): Document[] {
  const docs: Document[] = [document]
  const iframes = document.querySelectorAll('iframe')
  for (const iframe of Array.from(iframes)) {
    try {
      const doc = iframe.contentDocument
      if (doc) docs.push(doc)
    } catch { /* cross-origin */ }
  }
  return docs
}

const INPUT_SELECTOR = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), ' +
  'textarea, select, [contenteditable="true"], [role="combobox"], [role="textbox"]'

function resolveElement(field: FormFieldSchema): HTMLElement | null {
  // Strip iframe prefix from ID if present (fields scanned in iframes)
  const cleanId = field.id.replace(/^iframe\|[^|]+\|/, '')

  for (const doc of getAllDocs()) {
    const candidates = doc.querySelectorAll(INPUT_SELECTOR)
    for (const el of Array.from(candidates)) {
      const ht = el as HTMLElement
      if (generateId(ht) === field.id) return ht
      if (cleanId !== field.id && generateId(ht) === cleanId) return ht
    }
  }

  // Fuzzy match by label text + type (search all docs)
  if (field.label) {
    for (const doc of getAllDocs()) {
      const candidates = doc.querySelectorAll(INPUT_SELECTOR)
      for (const el of Array.from(candidates)) {
        const ht = el as HTMLElement
        const lbl = extractLabel(ht)
        if (lbl && lbl.toLowerCase() === field.label.toLowerCase()) return ht
      }
    }
  }

  return null
}

function fillFieldById(fieldId: string, value: string): FillResult {
  const cleanId = fieldId.replace(/^iframe\|[^|]+\|/, '')

  for (const doc of getAllDocs()) {
    const candidates = doc.querySelectorAll(INPUT_SELECTOR)
    for (const el of Array.from(candidates)) {
      const ht = el as HTMLElement
      const gid = generateId(ht)
      if (gid === fieldId || gid === cleanId) {
        try {
          setElementValueGeneric(ht, value)
          highlightElement(ht)
          return { fieldId, success: true }
        } catch (e) {
          return { fieldId, success: false, error: (e as Error).message }
        }
      }
    }
  }

  return { fieldId, success: false, error: 'Element not found' }
}

// ── Core Value Setter ─────────────────────────────────────────

export function setElementValue(el: HTMLElement, value: string, field?: FormFieldSchema): void {
  const tag = el.tagName.toLowerCase()
  const type = (el as HTMLInputElement).type ?? ''

  if (tag === 'select') {
    fillSelectElement(el as HTMLSelectElement, value)
    return
  }

  if (type === 'checkbox') {
    fillCheckbox(el as HTMLInputElement, value)
    return
  }

  if (type === 'radio') {
    fillRadio(el as HTMLInputElement, value)
    return
  }

  if (el.getAttribute('contenteditable') === 'true') {
    el.textContent = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return
  }

  const nestedInput = el.querySelector('input, textarea, select') as HTMLElement | null
  if (nestedInput && nestedInput !== el) {
    setElementValue(nestedInput, value, field)
    return
  }

  // Standard <input> or <textarea>
  fillTextInput(el as HTMLInputElement | HTMLTextAreaElement, value)
}

/** Generic setter used when we only have fieldId (no FormFieldSchema) */
function setElementValueGeneric(el: HTMLElement, value: string): void {
  const tag = el.tagName.toLowerCase()
  const type = (el as HTMLInputElement).type ?? ''

  if (tag === 'select') {
    fillSelectElement(el as HTMLSelectElement, value)
  } else if (type === 'checkbox') {
    fillCheckbox(el as HTMLInputElement, value)
  } else if (type === 'radio') {
    fillRadio(el as HTMLInputElement, value)
  } else if (el.getAttribute('contenteditable') === 'true') {
    el.textContent = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
  } else {
    const nestedInput = el.querySelector('input, textarea, select') as HTMLElement | null
    if (nestedInput && nestedInput !== el) {
      setElementValueGeneric(nestedInput, value)
      return
    }
    if (el.getAttribute('role') === 'combobox' || el.getAttribute('role') === 'textbox') {
      throw new Error('Custom form control needs review')
    }
    fillTextInput(el as HTMLInputElement | HTMLTextAreaElement, value)
  }
}

// ── Specialized Fillers ──────────────────────────────────────

function fillTextInput(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  // React/Vue compatible: use native value setter
  const nativeDescriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(HTMLInputElement.prototype), 'value',
  ) ?? Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(el), 'value',
  )

  if (nativeDescriptor?.set) {
    nativeDescriptor.set.call(el, value)
  } else {
    el.value = value
  }

  // Dispatch events for framework change detection
  el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }))
  el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }))

  // React 18+ _valueTracker
  const tracker = (el as any)._valueTracker
  if (tracker?.setValue) {
    tracker.setValue(value)
  }

  // Also set the attribute value for some edge cases
  el.setAttribute('value', value)
}

function fillSelectElement(el: HTMLSelectElement, value: string): void {
  // Exact match
  for (const opt of Array.from(el.options)) {
    if (opt.text.trim().toLowerCase() === value.trim().toLowerCase()) {
      el.value = opt.value
      dispatchChange(el)
      return
    }
  }

  // Contains match
  for (const opt of Array.from(el.options)) {
    if (opt.text.trim().toLowerCase().includes(value.trim().toLowerCase())) {
      el.value = opt.value
      dispatchChange(el)
      return
    }
  }

  // Fuzzy match with 50% threshold
  let bestMatch: HTMLOptionElement | null = null
  let bestScore = 0
  for (const opt of Array.from(el.options)) {
    const score = simpleSimilarity(value.toLowerCase(), opt.text.trim().toLowerCase())
    if (score > bestScore && score > 0.5) {
      bestScore = score
      bestMatch = opt
    }
  }
  if (bestMatch) {
    el.value = bestMatch.value
    dispatchChange(el)
  }
}

function fillCheckbox(el: HTMLInputElement, value: string): void {
  const v = value.toLowerCase().trim()
  const yesValues = ['yes', 'true', '1', 'agree', 'accept', 'checked', 'x']
  el.checked = yesValues.includes(v) || value.trim().length > 0
  dispatchChange(el)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function fillRadio(el: HTMLInputElement, value: string): void {
  const name = el.name
  if (!name) return

  const radios = document.querySelectorAll<HTMLInputElement>(
    `input[type="radio"][name="${CSS.escape(name)}"]`,
  )

  for (const radio of Array.from(radios)) {
    const rLabel = extractLabel(radio) || radio.value
    if (rLabel.toLowerCase() === value.toLowerCase() ||
        radio.value.toLowerCase() === value.toLowerCase()) {
      radio.checked = true
      dispatchChange(radio)
      return
    }
  }

  // Fuzzy match
  for (const radio of Array.from(radios)) {
    const rLabel = extractLabel(radio) || radio.value
    if (simpleSimilarity(value.toLowerCase(), rLabel.toLowerCase()) > 0.6) {
      radio.checked = true
      dispatchChange(radio)
      return
    }
  }
}

// ── Event Dispatch ────────────────────────────────────────────

function dispatchChange(el: HTMLElement): void {
  el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }))
  el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }))

  // Some ATS platforms use blur to trigger validation
  el.dispatchEvent(new FocusEvent('focus', { bubbles: true }))
  el.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
}

// ── Visual Feedback ───────────────────────────────────────────

export function highlightElement(el: HTMLElement): void {
  const originalOutline = el.style.outline
  const originalBackground = el.style.backgroundColor
  const originalTransition = el.style.transition

  el.style.transition = 'all 0.3s ease'
  el.style.outline = '2px solid #3B6D11'
  el.style.backgroundColor = 'rgba(59, 109, 17, 0.05)'

  setTimeout(() => {
    el.style.outline = originalOutline
    el.style.backgroundColor = originalBackground
    el.style.transition = originalTransition
  }, 2500)
}

// ── String Similarity ─────────────────────────────────────────

function simpleSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0
  if (a.includes(b) || b.includes(a)) return 0.85

  const setA = new Set(a.split(''))
  const setB = new Set(b.split(''))
  let intersection = 0
  for (const c of setA) {
    if (setB.has(c)) intersection++
  }
  const union = new Set([...setA, ...setB])
  return union.size === 0 ? 0 : intersection / union.size
}
