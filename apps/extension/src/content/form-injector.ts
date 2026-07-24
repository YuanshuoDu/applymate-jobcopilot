/**
 * Form filling is driven from the ApplyMate side panel. The former in-page
 * floating helper was removed because it obstructed host pages and appeared
 * outside the intended application flow.
 */
import { fillFields } from '../lib/form-filler/auto-fill'
import type { FilledField, FormFieldSchema } from '../lib/form-filler/types'

/** Kept as a compatibility hook for callers in the content script. */
export function tryInjectAutoFillButton(): void {
  // Intentionally no in-page UI.
}

/** Kept for the side-panel message protocol; no floating UI remains. */
export function updateButtonState(_state: 'idle' | 'loading' | 'done' | 'error'): void {
  // Intentionally no in-page UI.
}

export function removeAutoFillButton(): void {
  document.getElementById('applymate-autofill-btn')?.remove()
}

export function applyFieldValues(
  fields: FilledField[],
  schemas: FormFieldSchema[] = [],
): { success: boolean; failed: string[] } {
  const result = fillFields(fields, schemas)
  return { success: result.success, failed: result.failed }
}
