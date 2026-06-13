import type { FormFieldSchema } from './types'

/**
 * Aggressive full-page form scanner.
 * Works on ANY website — scans the entire document for anything
 * that looks like a form field: native inputs, React/Vue components,
 * contenteditable divs, custom select widgets, etc.
 */
export function scanFormFields(): FormFieldSchema[] {
  const fields: FormFieldSchema[] = []
  const seen = new Set<string>()
  let totalFound = 0
  let noiseFiltered = 0
  let dupFiltered = 0

  // Scan the ENTIRE document.body — no form container requirement
  const allInteractive = document.querySelectorAll(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), ' +
    'textarea, select, ' +
    '[contenteditable="true"], ' +
    '[role="combobox"], [role="listbox"], [role="textbox"], ' +
    '[role="radiogroup"], [role="checkbox"], [role="switch"]',
  )

  for (const el of allInteractive) {
    const schema = classifyElement(el as HTMLElement)
    if (!schema) continue
    totalFound++

    // Deduplicate by ID
    if (seen.has(schema.id)) { dupFiltered++; continue }
    seen.add(schema.id)

    // Filter out noise: tiny hidden fields, tracking inputs, etc.
    if (isNoiseField(el as HTMLElement, schema)) { noiseFiltered++; continue }

    fields.push(schema)
  }

  console.log('[ApplyMate] scanFormFields:', totalFound, 'found →',
    fields.length, 'kept,', dupFiltered, 'duplicates,', noiseFiltered, 'noise')

  // ── Deep scan pass: detect custom widgets without native form elements ──
  // Some ATS use <div> wrappers with JS event handlers instead of <input>/<select>
  const beforeDeep = fields.length
  deepScanCustomWidgets(fields, seen)
  if (fields.length > beforeDeep) {
    console.log('[ApplyMate] deepScan: found', fields.length - beforeDeep, 'additional fields')
  }

  return fields
}

/**
 * Detect form fields that use custom <div>-based widgets (no native <input>/<select>).
 * Common in modern React/Vue ATS platforms.
 */
function deepScanCustomWidgets(fields: FormFieldSchema[], seen: Set<string>): void {
  // Pattern 1: Question text followed by a text block (Q&A sections)
  const questionBlocks = document.querySelectorAll(
    '.question, .application-question, .custom-question, ' +
    '[class*="question"], [class*="Question"], ' +
    '.form-item, .form-row, .field-wrapper, ' +
    '[data-field], [data-question]'
  )

  for (const block of questionBlocks) {
    // Find the label/question text
    const labelCandidates = block.querySelectorAll(
      'label, .label, [class*="label"], h4, h5, h6, legend, .question-text, ' +
      '.field-label, [class*="title"], [class*="header"]'
    )
    let label = ''
    for (const lc of labelCandidates) {
      const t = (lc.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (t.length > 1 && t.length < 200 && !t.match(/^(save|submit|cancel|back|next|clear|reset)$/i)) {
        label = t
        break
      }
    }
    if (!label) {
      // Use the block's first significant text as label
      const text = (block.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (text.length > 2 && text.length < 200) label = text
      else continue
    }

    // Skip if we already have a field with this label
    if (seen.has('l-' + hashStr(label))) continue

    // Check if there's an answer element (input/textarea/select) inside — if so, already caught
    if (block.querySelector('input:not([type="hidden"]), textarea, select')) continue

    // Check for contenteditable or rich text areas
    const editable = block.querySelector('[contenteditable="true"], [role="textbox"]')
    if (editable) continue // Already caught by main scan

    // This is a custom widget — create a synthetic field
    const id = 'deep-' + hashStr(label + (block.className ?? ''))
    if (seen.has(id)) continue
    seen.add(id)

    fields.push({
      id,
      type: 'textarea',
      label,
      required: !!block.querySelector('[aria-required="true"], .required, [class*="required"]'),
      surroundingText: (block.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 250),
    })
  }
}

function isNoiseField(el: HTMLElement, schema: FormFieldSchema): boolean {
  const tag = el.tagName.toLowerCase()
  const style = window.getComputedStyle(el)

  // Always skip truly invisible elements
  if (style.display === 'none' || style.visibility === 'hidden') return true
  if (style.opacity === '0') return true

  // Size check — exempt select, ARIA-role, AND elements inside <form> or field containers
  const role = (el.getAttribute('role') ?? '').toLowerCase()
  const inForm = !!el.closest('form, [role="form"], .application-form, .apply-form, [class*="apply"], [class*="application"]')
  const isCustomWidget = tag === 'select' || ['combobox', 'listbox', 'radiogroup', 'checkbox', 'switch', 'textbox'].includes(role)
  if (!isCustomWidget && !inForm) {
    const rect = el.getBoundingClientRect()
    if (rect.width < 10 || rect.height < 10) return true
  }

  // Skip search boxes, nav inputs only — NO longer skip 'comment' or 'query'
  const name = (el.getAttribute('name') ?? '').toLowerCase()
  const id = (el.getAttribute('id') ?? '').toLowerCase()
  const label = schema.label.toLowerCase()

  const skipNames = ['search', 'nav', 'menu']
  for (const s of skipNames) {
    if (name === s || id === s || label === s) return true
  }

  // Only skip truly obvious non-application labels
  const skipLabels = ['search', 'subscribe', 'newsletter']
  for (const s of skipLabels) {
    if (label.includes(s)) return true
  }

  return false
}

export function classifyElement(el: HTMLElement): FormFieldSchema | null {
  const tag = el.tagName.toLowerCase()
  const type = (el.getAttribute('type') ?? '').toLowerCase()
  const role = (el.getAttribute('role') ?? '').toLowerCase()

  let fieldType: FormFieldSchema['type'] = 'text'

  if (tag === 'textarea') {
    fieldType = 'textarea'
  } else if (el.getAttribute('contenteditable') === 'true' || role === 'textbox') {
    fieldType = 'textarea'
  } else if (tag === 'select' || role === 'combobox' || role === 'listbox') {
    fieldType = 'select'
  } else if (role === 'radiogroup') {
    fieldType = 'radio'
  } else if (role === 'checkbox' || role === 'switch') {
    fieldType = 'checkbox'
  } else if (tag === 'input') {
    switch (type) {
      case 'email': fieldType = 'email'; break
      case 'tel': case 'telephone': case 'phone': fieldType = 'tel'; break
      case 'url': fieldType = 'url'; break
      case 'number': fieldType = 'number'; break
      case 'date': fieldType = 'date'; break
      case 'file': fieldType = 'file'; break
      case 'checkbox': fieldType = 'checkbox'; break
      case 'radio': fieldType = 'radio'; break
      default: fieldType = 'text'
    }
  }

  // Always try to extract a label — use name humanization as last resort
  const label = extractLabel(el)

  const placeholder = el.getAttribute('placeholder') ?? undefined
  const isRequired = el.getAttribute('required') !== null ||
    el.getAttribute('aria-required') === 'true' ||
    (el.closest('[required]') !== null)

  let options: string[] | undefined
  let groupName: string | undefined

  if (tag === 'select') {
    options = extractSelectOptions(el as HTMLSelectElement)
  } else if (type === 'radio') {
    groupName = el.getAttribute('name') ?? undefined
    options = extractRadioOptions(el as HTMLInputElement) ?? (groupName ? extractRadioOptionsByName(groupName) : undefined)
  } else if (type === 'checkbox') {
    groupName = el.getAttribute('name') ?? undefined
    if (groupName && !['on', 'off'].includes(groupName)) {
      options = extractCheckboxOptions(groupName)
    }
  }

  return {
    id: generateId(el),
    type: fieldType,
    label,
    placeholder,
    options,
    required: isRequired,
    surroundingText: extractSurroundingText(el),
    groupName,
    currentValue: readCurrentValue(el),
  }
}

// ── ID Generation ─────────────────────────────────────────────

export function generateId(el: HTMLElement): string {
  const name = el.getAttribute('name') ?? ''
  const eid = el.getAttribute('id') ?? ''
  const label = extractLabel(el)
  const type = el.getAttribute('type') ?? el.tagName.toLowerCase()

  // Prefer name attribute (most stable)
  if (name) return 'n-' + hashStr(name)

  // Combined id + label
  const base = [eid, label, type].filter(Boolean).join('|')
  if (base.length > 3) return 'l-' + hashStr(base)

  // DOM position fallback
  return 'd-' + hashStr(getDomPath(el))
}

function getDomPath(el: HTMLElement): string {
  const parts: string[] = []
  let current: HTMLElement | null = el
  let depth = 0
  while (current && current !== document.body && depth < 5) {
    let selector = current.tagName.toLowerCase()
    if (current.id) { parts.unshift('#' + current.id); break }
    if ((current as HTMLInputElement).name) { parts.unshift(`[name="${(current as HTMLInputElement).name}"]`); break }
    if (current.className && typeof current.className === 'string') {
      const cls = current.className.trim().split(/\s+/).slice(0, 1)[0]
      if (cls && cls.length < 30) selector += '.' + cls
    }
    parts.unshift(selector)
    current = current.parentElement
    depth++
  }
  return parts.join('>')
}

function hashStr(s: string): string {
  let hash = 0
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

// ── Label Extraction ──────────────────────────────────────────

export function extractLabel(el: HTMLElement): string {
  // 1. Associated <label for="id">
  const elId = el.getAttribute('id')
  if (elId) {
    const labelEl = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(elId)}"]`)
    if (labelEl) return clean(labelEl.textContent ?? '')
  }

  // 2. Parent <label> wrapping
  const parentLabel = el.closest('label')
  if (parentLabel) {
    const text = parentLabel.textContent ?? ''
    const inputValue = (el as HTMLInputElement).value || ''
    return clean(inputValue ? text.replace(inputValue, '') : text)
  }

  // 3. aria-label / aria-labelledby
  const ariaLabel = el.getAttribute('aria-label')
  if (ariaLabel) return clean(ariaLabel)

  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy.split(/\s+/)[0])
    if (labelEl) return clean(labelEl.textContent ?? '')
  }

  // 4. Placeholder
  const ph = el.getAttribute('placeholder')
  if (ph && ph.length > 2 && !ph.startsWith('http')) return clean(ph)

  // 5. Name attribute (last resort)
  const name = el.getAttribute('name')
  if (name) return humanizeName(name)

  // 6. Adjacent text — look at siblings and parent for label-like text
  const adj = findAdjacentText(el)
  if (adj) return adj

  // 7. Previous sibling text node
  const prevEl = el.previousElementSibling
  if (prevEl && prevEl.tagName !== 'INPUT' && prevEl.tagName !== 'TEXTAREA' && prevEl.tagName !== 'SELECT') {
    const t = (prevEl.textContent ?? '').trim()
    if (t.length > 0 && t.length < 100) return clean(t)
  }

  // 8. Data attributes used by component libraries
  const dataLabel = el.getAttribute('data-label') ?? el.getAttribute('data-field-label') ?? el.getAttribute('data-testid')
  if (dataLabel) return humanizeName(dataLabel)

  return ''
}

function findAdjacentText(el: HTMLElement): string | null {
  const parent = el.closest('div, li, p, td, .form-group, .field, .input-group, [class*="field"], [class*="input"], [class*="form"]') ?? el.parentElement
  if (!parent) return null

  // Look for a label element anywhere in the parent that doesn't wrap the input
  const labelSelectors = [
    'label', '.label', '[class*="label"]', '[class*="Label"]',
    'h4', 'h5', 'h6', '.field-label', '.input-label', '.question-text',
    '[data-label]', 'legend', '.form-label', '.control-label',
  ]

  for (const sel of labelSelectors) {
    try {
      const candidates = parent.querySelectorAll(sel)
      for (const c of candidates) {
        if (!c.contains(el)) {
          const t = (c.textContent ?? '').replace(/\s+/g, ' ').trim()
          if (t.length > 1 && t.length < 120) return t
        }
      }
    } catch { /* ignore */ }
  }

  // If parent is small enough, just use its text (minus input value)
  const parentText = (parent.textContent ?? '').replace(/\s+/g, ' ').trim()
  if (parentText.length > 2 && parentText.length < 150) {
    return parentText
  }

  return null
}

export function humanizeName(name: string): string {
  if (!name) return ''
  return name
    .replace(/[_-]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function clean(text: string): string {
  return text.replace(/[\n\r\t]+/g, ' ').replace(/\s+/g, ' ').replace(/[*:]+$/, '').trim()
}

// ── Options ───────────────────────────────────────────────────

function extractSelectOptions(el: HTMLSelectElement): string[] {
  return Array.from(el.options)
    .filter(o => o.value && o.textContent?.trim())
    .map(o => o.textContent!.trim())
    .slice(0, 50)
}

function extractRadioOptions(el: HTMLInputElement): string[] | undefined {
  const name = el.getAttribute('name')
  return name ? extractRadioOptionsByName(name) : undefined
}

function extractRadioOptionsByName(name: string): string[] | undefined {
  if (!name) return undefined
  const radios = document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(name)}"]`)
  const opts = Array.from(radios)
    .map(r => {
      const lbl = extractLabel(r)
      return lbl || r.value || ''
    })
    .filter(Boolean)
  return opts.length > 0 ? opts : undefined
}

function extractCheckboxOptions(name: string): string[] | undefined {
  if (!name) return undefined
  const boxes = document.querySelectorAll<HTMLInputElement>(`input[type="checkbox"][name="${CSS.escape(name)}"]`)
  const opts = Array.from(boxes)
    .map(cb => {
      const lbl = extractLabel(cb)
      return lbl || cb.value || ''
    })
    .filter(Boolean)
  return opts.length > 0 ? opts : undefined
}

// ── Surrounding Text ──────────────────────────────────────────

function extractSurroundingText(el: HTMLElement): string {
  const container = el.closest(
    'div, fieldset, li, .form-group, .field, .application-field, .question, [class*="form"]',
  ) ?? el.parentElement
  if (!container) return ''

  const text = (container.textContent ?? '').replace(/\s+/g, ' ').trim()
  return text.length > 250 ? text.slice(0, 250) + '...' : text
}

/** Read the current user-filled value from a form element */
function readCurrentValue(el: HTMLElement): string | undefined {
  const tag = el.tagName.toLowerCase()
  const type = (el as HTMLInputElement).type ?? ''

  if (tag === 'select') {
    const sel = el as HTMLSelectElement
    const val = (sel.options[sel.selectedIndex]?.text ?? sel.value ?? '').trim()
    // Filter out placeholder options that aren't real user values
    if (!val) return undefined
    const lower = val.toLowerCase()
    const placeholders = /^(select|choose|please select|please choose|none|--|--\s*select\s*--|n\/a|not specified|other|prefer not to say|select one|select an option|make a selection|pick one)$/
    if (placeholders.test(lower)) return undefined
    // Also skip values starting with common placeholder patterns
    if (/^[-–—]{1,3}$/.test(val)) return undefined
    return val
  }
  if (type === 'checkbox') {
    return (el as HTMLInputElement).checked ? 'true' : undefined
  }
  if (type === 'radio') {
    if (!(el as HTMLInputElement).checked) return undefined
    return extractLabel(el) || (el as HTMLInputElement).value || undefined
  }
  if (el.getAttribute('contenteditable') === 'true') {
    const text = (el.textContent ?? '').trim()
    return text || undefined
  }
  const val = (el as HTMLInputElement).value?.trim()
  return val || undefined
}

// ── Shadow DOM ────────────────────────────────────────────────

export function scanShadowRoots(): FormFieldSchema[] {
  const allFields = scanFormFields()
  const seen = new Set(allFields.map(f => f.id))

  const allElements = document.querySelectorAll('*')
  for (const el of allElements) {
    const root = (el as HTMLElement).shadowRoot
    if (!root) continue
    try {
      const inputs = root.querySelectorAll('input:not([type="hidden"]):not([type="submit"]), textarea, select')
      for (const input of inputs) {
        const schema = classifyElement(input as HTMLElement)
        if (schema && !seen.has(schema.id)) {
          seen.add(schema.id)
          allFields.push(schema)
        }
      }
    } catch { /* cross-origin shadow DOM */ }
  }

  return allFields
}

// ── Iframes ───────────────────────────────────────────────────

/**
 * Scan same-origin iframes for form fields.
 * For cross-origin iframes, content script injection (allFrames) handles them
 * via a separate content script instance.
 */
export function scanIframes(baseFields: FormFieldSchema[]): FormFieldSchema[] {
  const fields = [...baseFields]
  const seen = new Set(fields.map(f => f.id))
  const iframes = document.querySelectorAll('iframe')
  let iframeFieldCount = 0

  for (const iframe of iframes) {
    if (!isSameOriginIframe(iframe)) continue

    try {
      const doc = iframe.contentDocument
      if (!doc) continue

      const inputs = doc.querySelectorAll(
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), ' +
        'textarea, select, [contenteditable="true"], ' +
        '[role="combobox"], [role="listbox"], [role="textbox"], ' +
        '[role="radiogroup"], [role="checkbox"], [role="switch"]',
      )

      for (const el of inputs) {
        const schema = classifyElementInDoc(el as HTMLElement, doc)
        if (!schema) continue
        schema.id = `iframe|${iframe.src?.slice(0, 40) ?? 'unknown'}|${schema.id}`
        if (seen.has(schema.id)) continue
        seen.add(schema.id)
        fields.push(schema)
        iframeFieldCount++
      }
    } catch { /* cross-origin or inaccessible iframe */ }
  }

  if (iframeFieldCount > 0) {
    console.log('[ApplyMate] scanIframes:', iframeFieldCount, 'fields found in', iframes.length, 'iframes')
  }

  return fields
}

function isSameOriginIframe(iframe: HTMLIFrameElement): boolean {
  try {
    // This throws if cross-origin
    return !!iframe.contentDocument
  } catch {
    return false
  }
}

/**
 * classifyElement variant that uses a specific document for label lookups.
 */
function classifyElementInDoc(el: HTMLElement, doc: Document): FormFieldSchema | null {
  const tag = el.tagName.toLowerCase()
  const type = (el.getAttribute('type') ?? '').toLowerCase()
  const role = (el.getAttribute('role') ?? '').toLowerCase()

  let fieldType: FormFieldSchema['type'] = 'text'

  if (tag === 'textarea') {
    fieldType = 'textarea'
  } else if (el.getAttribute('contenteditable') === 'true' || role === 'textbox') {
    fieldType = 'textarea'
  } else if (tag === 'select' || role === 'combobox' || role === 'listbox') {
    fieldType = 'select'
  } else if (role === 'radiogroup') {
    fieldType = 'radio'
  } else if (role === 'checkbox' || role === 'switch') {
    fieldType = 'checkbox'
  } else if (tag === 'input') {
    switch (type) {
      case 'email': fieldType = 'email'; break
      case 'tel': case 'telephone': case 'phone': fieldType = 'tel'; break
      case 'url': fieldType = 'url'; break
      case 'number': fieldType = 'number'; break
      case 'date': fieldType = 'date'; break
      case 'file': fieldType = 'file'; break
      case 'checkbox': fieldType = 'checkbox'; break
      case 'radio': fieldType = 'radio'; break
      default: fieldType = 'text'
    }
  }

  const label = extractLabelInDoc(el, doc)
  const placeholder = el.getAttribute('placeholder') ?? undefined
  const isRequired = el.getAttribute('required') !== null ||
    el.getAttribute('aria-required') === 'true'

  let options: string[] | undefined
  let groupName: string | undefined

  if (tag === 'select') {
    options = Array.from((el as HTMLSelectElement).options)
      .filter(o => o.value && o.textContent?.trim())
      .map(o => o.textContent!.trim())
      .slice(0, 50)
  } else if (type === 'radio') {
    groupName = el.getAttribute('name') ?? undefined
    const name = groupName
    if (name) {
      const radios = doc.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(name)}"]`)
      options = Array.from(radios)
        .map(r => extractLabelInDoc(r, doc) || r.value || '')
        .filter(Boolean)
    }
  }

  return {
    id: `${generateIdInDoc(el, doc)}`,
    type: fieldType,
    label,
    placeholder,
    options,
    required: isRequired,
    surroundingText: extractSurroundingTextInDoc(el, doc),
    groupName,
    currentValue: readCurrentValue(el),
  }
}

function extractLabelInDoc(el: HTMLElement, doc: Document): string {
  const elId = el.getAttribute('id')
  if (elId) {
    const labelEl = doc.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(elId)}"]`)
    if (labelEl) return clean(labelEl.textContent ?? '')
  }
  const parentLabel = el.closest('label')
  if (parentLabel) {
    const text = parentLabel.textContent ?? ''
    return clean(text)
  }
  const ariaLabel = el.getAttribute('aria-label')
  if (ariaLabel) return clean(ariaLabel)
  const ph = el.getAttribute('placeholder')
  if (ph && ph.length > 2 && !ph.startsWith('http')) return clean(ph)
  const name = el.getAttribute('name')
  if (name) return humanizeName(name)
  return ''
}

function generateIdInDoc(el: HTMLElement, _doc: Document): string {
  return generateId(el) // Reuse main ID generation (DOM-path based)
}

function extractSurroundingTextInDoc(el: HTMLElement, _doc: Document): string {
  const container = el.closest('div, fieldset, li, .form-group, .field')
  if (!container) return ''
  const text = (container.textContent ?? '').replace(/\s+/g, ' ').trim()
  return text.length > 250 ? text.slice(0, 250) + '...' : text
}

// ── CAPTCHA ───────────────────────────────────────────────────

export function detectCaptcha(): boolean {
  return !!(document.querySelector(
    '[src*="recaptcha"], [src*="hcaptcha"], .g-recaptcha, .h-captcha, ' +
    '[class*="captcha"], [id*="captcha"], iframe[src*="captcha"]',
  ))
}

// ── Page analysis helpers ─────────────────────────────────────

/** Quick check: does this page contain any form-like elements? */
export function pageHasFormElements(): boolean {
  const inputs = document.querySelectorAll(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select, [contenteditable="true"]',
  )
  return inputs.length > 0
}

/** Get a summary of form candidates on the page */
export function getFormSummary(): { totalInputs: number; totalSelects: number; totalTextareas: number; hasSubmit: boolean } {
  return {
    totalInputs: document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"])').length,
    totalSelects: document.querySelectorAll('select').length,
    totalTextareas: document.querySelectorAll('textarea').length,
    hasSubmit: !!document.querySelector('input[type="submit"], button[type="submit"], button:not([type])'),
  }
}
