/**
 * Form Filler UI Injector — injects a floating "Auto-Fill" button on job application pages.
 * This file is loaded as part of the content script bundle.
 */
import { detectAndScanForms } from '../lib/form-filler/detectors/detect'
import { fillFields, highlightElement } from '../lib/form-filler/auto-fill'
import type { FormFieldSchema, FilledField } from '../lib/form-filler/types'

let injected = false
let autoFillBtn: HTMLElement | null = null

export function tryInjectAutoFillButton(): void {
  if (injected) return

  if (isJobListPage()) return

  const result = detectAndScanForms()
  if (!result || result.fields.length === 0) return

  injected = true
  injectButton(result.fields)
}

function isJobListPage(): boolean {
  const host = window.location.hostname
  const path = window.location.pathname

  if (host.includes('linkedin.com') && path.startsWith('/jobs/')) {
    return !path.includes('/view/') && !path.includes('/jobs/view/')
  }
  if (host.includes('indeed.com')) {
    return path.includes('/jobs') && !path.includes('viewjob')
  }
  return false
}

function injectButton(fields: FormFieldSchema[]): void {
  if (autoFillBtn) return

  const btn = document.createElement('div')
  btn.id = 'applymate-autofill-btn'
  btn.innerHTML = `
    <div style="
      display: flex; align-items: center; gap: 8px;
      background: linear-gradient(135deg, #3B6D11, #5A9A1F);
      color: white; padding: 10px 18px; border-radius: 28px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px; font-weight: 600; cursor: pointer;
      box-shadow: 0 4px 16px rgba(59,109,17,0.35);
      transition: transform 0.15s, box-shadow 0.15s;
      user-select: none; z-index: 2147483647;
    ">
      <span style="font-size: 18px;">&#9889;</span>
      <span>Auto-Fill (${fields.length} fields)</span>
    </div>
  `

  btn.style.cssText = `
    position: fixed; bottom: 24px; right: 24px;
    z-index: 2147483647;
  `

  btn.addEventListener('mouseenter', () => {
    const inner = btn.firstElementChild as HTMLElement
    inner.style.transform = 'scale(1.05)'
    inner.style.boxShadow = '0 6px 24px rgba(59,109,17,0.45)'
  })

  btn.addEventListener('mouseleave', () => {
    const inner = btn.firstElementChild as HTMLElement
    inner.style.transform = ''
    inner.style.boxShadow = ''
  })

  btn.addEventListener('click', () => {
    // Send form detected to sidepanel — it will handle AI analysis and show review UI
    chrome.runtime.sendMessage({ type: 'FORM_DETECTED', fields, source: 'content', formCount: 1 })
    updateButtonState('loading')
    // Safety: auto-revert after 120s if no response from sidepanel
    setTimeout(() => {
      if (autoFillBtn) updateButtonState('idle')
    }, 120_000)
  })

  document.body.appendChild(btn)
  autoFillBtn = btn
}

export function updateButtonState(state: 'idle' | 'loading' | 'done' | 'error'): void {
  if (!autoFillBtn) return
  const inner = autoFillBtn.firstElementChild as HTMLElement

  switch (state) {
    case 'loading':
      inner.innerHTML = '<span style="font-size:18px;">&#9889;</span><span>AI Analyzing...</span>'
      break
    case 'done':
      inner.innerHTML = '<span style="font-size:18px;">&#9989;</span><span>Form Filled!</span>'
      break
    case 'error':
      inner.innerHTML = '<span style="font-size:18px;">&#10060;</span><span>Error — Retry?</span>'
      break
    default:
      break
  }
}

export function removeAutoFillButton(): void {
  if (autoFillBtn) {
    autoFillBtn.remove()
    autoFillBtn = null
  }
  injected = false
}

export function applyFieldValues(fields: FilledField[]): { success: boolean; failed: string[] } {
  const result = fillFields(fields)
  if (result.success) {
    updateButtonState('done')
  } else {
    updateButtonState('error')
  }
  return { success: result.success, failed: result.failed }
}
