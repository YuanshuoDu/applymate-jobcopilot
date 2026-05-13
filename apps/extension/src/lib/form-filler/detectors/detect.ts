import type { FormFieldSchema, FormDetectionResult } from '../types'
import { scanFormFields, scanShadowRoots, detectCaptcha, classifyElement, scanIframes } from '../form-scanner'

/**
 * Dispatcher — mirrors lib/scrapers/detect.ts pattern.
 * Tries platform-specific detectors first, falls back to generic.
 */
export function detectAndScanForms(): FormDetectionResult | null {
  const host = window.location.hostname

  let fields: FormFieldSchema[] | null = null
  let source = 'generic'

  if (host.includes('greenhouse.io')) {
    fields = scanGreenhouse()
    source = 'greenhouse'
  } else if (host.includes('lever.co')) {
    fields = scanLever()
    source = 'lever'
  } else if (host.includes('myworkdayjobs') || host.includes('workday')) {
    fields = scanWorkday()
    source = 'workday'
  }

  // Generic fallback — scan everything
  if (!fields || fields.length === 0) {
    fields = scanFormFields()
    source = 'generic'

    // Also try shadow roots and iframes
    try {
      const shadowFields = scanShadowRoots()
      if (shadowFields.length > fields.length) {
        fields = shadowFields
        source = 'generic+shadow'
      }
    } catch { /* ignore */ }

    // Scan same-origin iframes (iCIMS, Brassring, SuccessFactors, etc.)
    if (fields.length === 0) {
      fields = scanIframes(fields)
      if (fields.length > 0) source = 'generic+iframe'
    }
  }

  if (fields.length === 0) return null

  const hasFileUpload = fields.some(f => f.type === 'file')
  const hasCaptcha = detectCaptcha()

  return {
    fields,
    source,
    formCount: countFormElements(),
    hasFileUpload,
    hasCaptcha,
  }
}

function countFormElements(): number {
  return document.querySelectorAll('form').length
}

// ── Greenhouse ATS ────────────────────────────────────────────

function scanGreenhouse(): FormFieldSchema[] {
  // Greenhouse job boards use a specific structure:
  // .field-- or #field_ containers with label + input
  const fields: FormFieldSchema[] = []
  const containers = document.querySelectorAll(
    '#application_form .field, [class*="demographic_question"], ' +
    '.application-form .application-field, ' +
    '.app-form .app-field',
  )

  if (containers.length > 0) {
    for (const container of containers) {
      const inputs = container.querySelectorAll(
        'input:not([type="hidden"]):not([type="submit"]), textarea, select',
      )
      for (const el of inputs) {
        const schema = classifyElement(el as HTMLElement)
        if (schema) fields.push(schema)
      }
    }
    return fields
  }

  // Fallback: generic scan within any form on greenhouse page
  return scanFormFields()
}

// ── Lever ATS ─────────────────────────────────────────────────

function scanLever(): FormFieldSchema[] {
  // Lever uses .application-form or the built-in lever form
  const fields: FormFieldSchema[] = []

  const formSelectors = [
    '.posting-apply form',
    '.application-form',
    'form[class*="apply"]',
  ]

  for (const sel of formSelectors) {
    const form = document.querySelector(sel)
    if (form) {
      const inputs = form.querySelectorAll(
        'input:not([type="hidden"]):not([type="submit"]), textarea, select',
      )
      for (const el of inputs) {
        const schema = classifyElement(el as HTMLElement)
        if (schema) fields.push(schema)
      }
      if (fields.length > 0) break
    }
  }

  // Lever custom demographic questions
  document.querySelectorAll('.application-question, .custom-question').forEach(q => {
    const inputs = q.querySelectorAll('input:not([type="hidden"]), textarea, select')
    for (const el of inputs) {
      const schema = classifyElement(el as HTMLElement)
      if (schema && !fields.find(f => f.id === schema.id)) {
        fields.push(schema)
      }
    }
  })

  return fields.length > 0 ? fields : scanFormFields()
}

// ── Workday ATS ───────────────────────────────────────────────

function scanWorkday(): FormFieldSchema[] {
  // Workday uses data-automation-id attributes heavily
  const fields: FormFieldSchema[] = []

  const containers = document.querySelectorAll(
    '[data-automation-id*="form"], [data-automation-id*="field"], ' +
    '[data-automation-id*="question"], [data-automation-id*="section"], ' +
    '[class*="form-field"], [class*="fieldWrapper"]',
  )

  if (containers.length > 0) {
    for (const container of containers) {
      const inputs = container.querySelectorAll(
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select',
      )
      for (const el of inputs) {
        const schema = classifyElement(el as HTMLElement)
        if (schema) fields.push(schema)
      }
    }
    if (fields.length > 0) return fields
  }

  // Workday often has multi-page forms
  const sectionPanels = document.querySelectorAll('[data-automation-id*="section"], .gwt-TabPanel')
  for (const panel of sectionPanels) {
    const inputs = panel.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]), textarea, select',
    )
    for (const el of inputs) {
      const schema = classifyElement(el as HTMLElement)
      if (schema && !fields.find(f => f.id === schema.id)) {
        fields.push(schema)
      }
    }
  }

  return fields.length > 0 ? fields : scanFormFields()
}
