/**
 * FormFillerView — Sidepanel tab for reviewing & applying AI-generated form answers.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { getSettings, saveSettings } from '@/lib/storage'
import { getPersona, analyzeForm, reviseFormFields, getPersonaFields, savePersonaFields } from '@/lib/api'
import type { ExtensionSettings } from '@/lib/types'
import type { FormFieldSchema, FilledField, FormFillResponse } from '@/lib/form-filler/types'
import type { PersonaField } from '@/lib/api'

const C = {
  primary:  '#4F46E5',
  green:    '#3B6D11',
  red:      '#A32D2D',
  amber:    '#854F0B',
  teal:     '#0E7490',
  bg:       '#f0f4f8',
  card:     '#ffffff',
  border:   '#e2e8f0',
  text:     '#0f172a',
  muted:    '#64748b',
  subtle:   '#94a3b8',
}

type ViewState = 'idle' | 'scanning' | 'aiThinking' | 'review' | 'applying' | 'done' | 'error'
type AnalysisPhase = 'fetchingPersona' | 'preparingPrompt' | 'waitingForAI' | 'processingResult'

const contentScriptLoads = new Map<number, Promise<void>>()

async function ensureContentScript(tabId: number): Promise<void> {
  const pending = contentScriptLoads.get(tabId)
  if (pending) return pending

  const load = (async () => {
    const probe = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: () => {
        const state = (globalThis as typeof globalThis & {
          __applyMateContentScriptState?: 'loading' | 'ready'
        }).__applyMateContentScriptState
        return state === 'loading' || state === 'ready'
      },
    })

    if (probe.some(result => result.result === true)) return

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
      world: 'ISOLATED',
    })
  })()

  contentScriptLoads.set(tabId, load)
  try {
    await load
  } finally {
    contentScriptLoads.delete(tabId)
  }
}

async function scanFormDirectly(tabId: number): Promise<FormFieldSchema[]> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: () => {
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
      const labelFor = (element: HTMLElement) => {
        const id = element.getAttribute('id')
        if (id) {
          const label = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`)
          if (label?.textContent) return clean(label.textContent)
        }
        const aria = element.getAttribute('aria-label')
        if (aria) return clean(aria)
        const labelledBy = element.getAttribute('aria-labelledby')
        if (labelledBy) {
          const label = document.getElementById(labelledBy.split(/\s+/)[0])
          if (label?.textContent) return clean(label.textContent)
        }
        const container = element.closest(
          '[data-automation-id^="formField-"], label, fieldset, [class*="form-field"], [class*="fieldWrapper"]',
        )
        const nearbyLabel = container?.querySelector('label, legend, [data-automation-id*="label"]')
        if (nearbyLabel?.textContent) return clean(nearbyLabel.textContent)
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
        const tag = element.tagName.toLowerCase()
        const inputType = (element.getAttribute('type') ?? '').toLowerCase()
        const role = (element.getAttribute('role') ?? '').toLowerCase()
        const label = labelFor(element)
        const name = element.getAttribute('name') ?? ''
        const elementId = element.getAttribute('id') ?? ''
        const rawId = name
          ? `n-${hash(name)}`
          : `l-${hash([elementId, label, inputType || tag].filter(Boolean).join('|'))}`
        if (seen.has(rawId)) return []
        seen.add(rawId)

        let type = 'text'
        if (tag === 'textarea' || role === 'textbox' || element.getAttribute('contenteditable') === 'true') type = 'textarea'
        else if (tag === 'select' || role === 'combobox') type = 'select'
        else if (role === 'radiogroup' || inputType === 'radio') type = 'radio'
        else if (role === 'checkbox' || role === 'switch' || inputType === 'checkbox') type = 'checkbox'
        else if (['email', 'tel', 'url', 'number', 'date', 'file'].includes(inputType)) type = inputType

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
        const currentValue = inputType === 'checkbox' || inputType === 'radio'
          ? (input.checked ? input.value || 'true' : undefined)
          : (input.value || element.textContent?.trim() || undefined)

        return [{
          id: rawId,
          type,
          label,
          placeholder: element.getAttribute('placeholder') ?? undefined,
          options,
          required: element.hasAttribute('required') || element.getAttribute('aria-required') === 'true',
          surroundingText: clean(element.closest(
            '[data-automation-id^="formField-"], label, fieldset, [class*="field"], [class*="form"]',
          )?.textContent ?? '').slice(0, 250),
          groupName: name || undefined,
          currentValue,
        }]
      })
    },
  })

  const fields = results[0]?.result
  return Array.isArray(fields) ? fields as FormFieldSchema[] : []
}

async function refreshAuthFromDashboard(
  current: ExtensionSettings,
): Promise<ExtensionSettings | null> {
  const tabs = await chrome.tabs.query({})
  const dashboard = tabs.find(tab => {
    if (!tab.id || !tab.url) return false
    try {
      const url = new URL(tab.url)
      return url.hostname === 'localhost' ||
        url.hostname === 'web-delta-ruddy-29.vercel.app' ||
        url.hostname.endsWith('.applymate.ai')
    } catch {
      return false
    }
  })
  if (!dashboard?.id || !dashboard.url) return null

  const result = await chrome.scripting.executeScript({
    target: { tabId: dashboard.id },
    world: 'MAIN',
    func: async () => {
      try {
        const response = await fetch('/api/auth/me/extension-token', {
          credentials: 'include',
        })
        if (!response.ok) return { ok: false }
        const data = await response.json()
        return { ok: true, data }
      } catch {
        return { ok: false }
      }
    },
  })
  const auth = result[0]?.result as {
    ok?: boolean
    data?: { token?: string; user?: { email?: string; name?: string } }
  } | undefined
  if (!auth?.ok || !auth.data?.token) return null

  const refreshed: ExtensionSettings = {
    ...current,
    apiBaseUrl: new URL(dashboard.url).origin,
    apiToken: auth.data.token,
    userEmail: auth.data.user?.email ?? current.userEmail,
    userName: auth.data.user?.name ?? current.userName,
  }
  await saveSettings(refreshed)
  return refreshed
}

export function FormFillerView({ settings, pendingFields, onFieldsConsumed, scanTrigger, onPersonaUpdated }: {
  settings: ExtensionSettings
  pendingFields?: FormFieldSchema[] | null
  onFieldsConsumed?: () => void
  scanTrigger: number
  personaUpdateTrigger?: number
  onPersonaUpdated?: () => void
}) {
  const [viewState, setViewState] = useState<ViewState>('idle')
  const [fields, setFields] = useState<FormFieldSchema[]>([])
  const [filledFields, setFilledFields] = useState<FilledField[]>([])
  const [errorMsg, setErrorMsg] = useState('')
  const [appliedCount, setAppliedCount] = useState(0)
  const [reviseInstruction, setReviseInstruction] = useState('')
  const [revising, setRevising] = useState(false)
  const [injectPermissionHost, setInjectPermissionHost] = useState<string | null>(null)
  const [uploadedFiles, setUploadedFiles] = useState<Record<string, string>>({})
  const [failedFieldIds, setFailedFieldIds] = useState<string[]>([])
  const analyzeFieldsRef = useRef<(
    fields: FormFieldSchema[],
    overrideSettings?: ExtensionSettings,
    allowAuthRefresh?: boolean,
  ) => Promise<void>>(async () => {})

  // ── Persona Save Prompt ──────────────────────────────────────
  const [personaMatches, setPersonaMatches] = useState<Array<{
    fieldId: string; label: string; value: string; existingValue?: string; personaKey: string
  }>>([])
  const [savingPersona, setSavingPersona] = useState(false)

  /** Build a persona key from a field label (for dedup across sites) */
  function fieldToPersonaKey(label: string): string {
    return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
  }

  function guessCategoryFromLabel(label: string): string {
    const l = label.toLowerCase()
    if (/name|gender|sex|pronoun|birth|age|race|ethnic|veteran|disability/i.test(l)) return 'personal'
    if (/phone|mobile|tel|cell|email|address|city|state|province|region|country|nationality|zip|postal|linkedin|github|website|portfolio/i.test(l)) return 'contact'
    if (/salary|compensation|pay|rate|authorization|visa|sponsor|permit|eligible|relocat|remote|wfh|hybrid|notice|availability|start.date|commute|driver|license|target.role/i.test(l)) return 'work'
    if (/school|university|college|institution|degree|major|gpa|grade.point|graduation|language|certification|award|honor|achievement/i.test(l)) return 'education'
    return 'preferences'
  }

  /** Shared: compare current values with saved persona fields.
   *  Only includes fields the AI flagged as personaRelevant. */
  async function computePersonaMatches(values: Array<{ fieldId: string; value: string }>): Promise<typeof personaMatches> {
    const result = await getPersonaFields(settings)
    const existingFields = result.fields ?? []
    const existingMap = new Map(existingFields.map((f: PersonaField) => [f.key, f]))
    const valueMap = new Map(values.map(v => [v.fieldId, v.value]))

    const matches: typeof personaMatches = []
    for (const f of filledFields) {
      // Only consider fields the AI classified as persona-relevant
      if (f.skip || !f.personaRelevant) continue
      const currentValue = valueMap.get(f.fieldId) ?? ''
      if (!currentValue.trim()) continue
      const schema = fields.find(s => s.id === f.fieldId)
      const label = schema?.label ?? f.fieldId
      const personaKey = fieldToPersonaKey(label)

      const existing = existingMap.get(personaKey)
      if (!existing) {
        matches.push({ fieldId: f.fieldId, label, value: currentValue, personaKey })
      } else if (existing.value.trim() !== currentValue.trim()) {
        matches.push({ fieldId: f.fieldId, label, value: currentValue, existingValue: existing.value, personaKey })
      }
    }
    return matches
  }

  /** After apply succeeds: auto-detect persona fields via AI's personaRelevant flag */
  async function analyzePersonaMatches() {
    try {
      const values = filledFields
        .filter(f => !f.skip && f.personaRelevant && f.value.trim())
        .map(f => ({ fieldId: f.fieldId, value: f.value }))
      const matches = await computePersonaMatches(values)
      setPersonaMatches(matches)
    } catch { /* ignore */ }
  }

  /** Refresh: read current DOM values from the page, re-compare with persona */
  async function handleRefreshPersona() {
    setSavingPersona(true)
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
      const tabId = tabs[0]?.id
      if (!tabId) return

      const resp = await chrome.tabs.sendMessage(tabId, {
        type: 'READ_FIELD_VALUES',
        fieldIds: filledFields.filter(f => !f.skip).map(f => f.fieldId),
      }) as { type?: string; values?: Array<{ fieldId: string; value: string }> } | undefined

      if (resp?.type !== 'FIELD_VALUES_RESULT' || !resp.values) return

      const matches = await computePersonaMatches(resp.values)
      setPersonaMatches(matches)
    } catch { /* ignore */ }
    finally { setSavingPersona(false) }
  }

  async function handleSavePersonaMatches() {
    setSavingPersona(true)
    try {
      const fields: PersonaField[] = personaMatches.map(m => ({
        key:        m.personaKey,
        category:   guessCategory(m.personaKey),
        label:      m.label,
        value:      m.value,
        confidence: 1.0,
        source:     'form_scan',
        updatedAt:  new Date().toISOString(),
      }))
      await savePersonaFields(settings, fields)
      setPersonaMatches([])
      onPersonaUpdated?.()
    } catch { /* ignore */ }
    finally { setSavingPersona(false) }
  }

  function guessCategory(key: string): string {
    if (['phone', 'address', 'linkedin_profile', 'github_profile', 'website'].includes(key)) return 'contact'
    if (['salary_expectation', 'work_authorization', 'open_to_relocation', 'availability'].includes(key)) return 'work'
    if (['gender', 'race', 'ethnicity', 'veteran_status', 'disability_status'].includes(key)) return 'personal'
    return 'preferences'
  }

  // ── AI Analysis Progress ─────────────────────────────────────
  const [analysisPhase, setAnalysisPhase] = useState<AnalysisPhase>('fetchingPersona')
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (viewState === 'aiThinking') {
      timerRef.current = setInterval(() => setElapsedSeconds(s => s + 1), 1000)
    } else {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
      setElapsedSeconds(0)
      setAnalysisPhase('fetchingPersona')
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [viewState])

  // ── Tab switch detection ─────────────────────────────────────
  const prevTriggerRef = useRef(scanTrigger)
  useEffect(() => {
    // Skip first render — only react to subsequent tab switches
    if (prevTriggerRef.current === scanTrigger) return
    prevTriggerRef.current = scanTrigger
    // Reset to idle for the new page — user can scan again
    setViewState('idle')
    setFields([])
    setFilledFields([])
    setErrorMsg('')
    setInjectPermissionHost(null)
  }, [scanTrigger])

  useEffect(() => {
    const listener = (message: { type?: string; fieldId?: string; fileName?: string }) => {
      if (message.type === 'FILE_UPLOAD_CHANGED' && message.fieldId) {
        setUploadedFiles(files => ({ ...files, [message.fieldId!]: message.fileName || 'File selected' }))
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [])

  // Process pending fields passed from SidePanel (avoids race condition on mount)
  useEffect(() => {
    if (pendingFields && pendingFields.length > 0) {
      setFields(pendingFields)
      analyzeFields(pendingFields)
      onFieldsConsumed?.()
    }
    // Intentionally only react to pendingFields changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFields])

  const notifyContentScript = useCallback((success: boolean) => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'FORM_ANALYSIS_COMPLETE', success }).catch(() => {})
      }
    })
  }, [])

  const analyzeFields = useCallback(async (
    formFields: FormFieldSchema[],
    overrideSettings?: ExtensionSettings,
    allowAuthRefresh = true,
  ) => {
    const activeSettings = overrideSettings ?? settings
    try {
      setViewState('aiThinking')
      setErrorMsg('')

      // Phase 0: Split prefilled (user already typed) vs empty fields
      const prefilled = formFields.filter(f => f.currentValue?.trim())
      const empty = formFields.filter(f => !f.currentValue?.trim())
      console.log('[FormFiller] Pre-fill split:', prefilled.length, 'prefilled,', empty.length, 'empty → match/ai')
      if (prefilled.length > 0) {
        console.log('[FormFiller] Pre-filled fields:', prefilled.map(f => f.label + '=' + f.currentValue?.slice(0, 30)).join(', '))
      }
      const prefilledFields: FilledField[] = prefilled.map(f => ({
        fieldId: f.id,
        value: f.currentValue!,
        confidence: 1.0,
        reasoning: 'User already filled this field',
        skip: false,
        personaRelevant: false,
      }))

      // If everything is prefilled, skip AI entirely
      if (empty.length === 0) {
        setFilledFields(prefilledFields)
        setViewState('review')
        notifyContentScript(true)
        return
      }

      setAnalysisPhase('fetchingPersona')

      // Phase 1: Fetch user profile, persona, resume + job context
      let persona: string
      let personaFields: PersonaField[] = []
      try {
        const [personaResult, pFieldsResult] = await Promise.all([
          getPersona(activeSettings),
          getPersonaFields(activeSettings).catch(() => ({ fields: [] })),
        ])
        persona = personaResult.persona
        personaFields = pFieldsResult.fields ?? []
      } catch (e) {
        const msg = (e as Error).message
        if (msg.includes('timed out')) throw new Error('Profile fetch timed out. Check your network or server status.')
        throw e
      }

      // Get current job for context
      let jobContext: string | undefined
      try {
        const stored = await chrome.storage.local.get('currentJob')
        const job = stored.currentJob
        if (job?.title && job?.company) {
          jobContext = `Job: ${job.title} at ${job.company}`
          if (job.location && job.location !== 'Unknown') jobContext += ` — ${job.location}`
          if (job.description) jobContext += `\nDescription: ${job.description.slice(0, 1500)}`
        }
      } catch { /* ignore */ }

      // ── Phase 2: Persona matching — extract known answers, skip AI for obvious matches ──
      const knownAnswers = buildKnownAnswers(persona, personaFields)
      console.log('[FormFiller] Known answers:', knownAnswers.length, 'keys loaded')

      const personaMatchedFields: FilledField[] = []
      const needsAi: FormFieldSchema[] = []

      for (const field of empty) {
        const match = findPersonaMatch(field, knownAnswers)
        if (match) {
          personaMatchedFields.push({
            fieldId: field.id,
            value: match.value,
            confidence: match.confidence,
            reasoning: `Matched from persona: ${match.source}`,
            skip: false,
            personaRelevant: true,
          })
        } else {
          needsAi.push(field)
        }
      }

      console.log('[FormFiller] Persona match:', personaMatchedFields.length, 'matched,', needsAi.length, '→ AI')
      if (personaMatchedFields.length > 0) {
        console.log('[FormFiller] Matched fields:', personaMatchedFields.map(f => f.fieldId + '=' + f.value?.slice(0, 30)).join(', '))
      }

      // If everything matched persona, skip AI entirely
      if (needsAi.length === 0) {
        const fieldMap = new Map<string, FilledField>()
        for (const f of prefilledFields) fieldMap.set(f.fieldId, f)
        for (const f of personaMatchedFields) fieldMap.set(f.fieldId, f)
        const merged = formFields.map(f => fieldMap.get(f.id)!).filter(Boolean)
        setFilledFields(merged)
        setViewState('review')
        notifyContentScript(true)
        return
      }

      setAnalysisPhase('preparingPrompt')

      setAnalysisPhase('waitingForAI')

      // Phase 3: AI model call — only for truly unknown fields
      let result: FormFillResponse
      try {
        result = await analyzeForm(activeSettings, { fields: needsAi, persona, jobContext })
      } catch (e) {
        const msg = (e as Error).message
        if (msg.includes('timed out')) throw new Error(`AI analysis timed out after 3 min for ${needsAi.length} fields. Try with fewer fields or a faster model.`)
        throw e
      }
      setAnalysisPhase('processingResult')

      // Phase 4: Merge prefilled + persona-matched + AI results (preserving original order)
      const fieldMap = new Map<string, FilledField>()
      for (const f of prefilledFields) fieldMap.set(f.fieldId, f)
      for (const f of personaMatchedFields) fieldMap.set(f.fieldId, f)
      for (const f of result.fields) fieldMap.set(f.fieldId, f)
      const merged = formFields.map(f => fieldMap.get(f.id)!).filter(Boolean)
      setFilledFields(merged)
      setViewState('review')
      notifyContentScript(true)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (allowAuthRefresh && /unauthorized|401/i.test(message)) {
        const refreshed = await refreshAuthFromDashboard(activeSettings).catch(() => null)
        if (refreshed) {
          await analyzeFieldsRef.current(formFields, refreshed, false)
          return
        }
        setErrorMsg('ApplyMate session expired. Open or refresh the Dashboard, then click Retry.')
      } else {
        setErrorMsg(message)
      }
      setViewState('error')
      notifyContentScript(false)
    }
  }, [settings, notifyContentScript])
  analyzeFieldsRef.current = analyzeFields

  const handleRevise = useCallback(async () => {
    if (!reviseInstruction.trim()) return
    setRevising(true)
    try {
      const { persona } = await getPersona(settings)
      const result = await reviseFormFields(settings, {
        fields,
        previousFill: filledFields,
        persona,
        instruction: reviseInstruction.trim(),
      })
      setFilledFields(result.fields)
      setReviseInstruction('')
    } catch (e) {
      setErrorMsg((e as Error).message)
    } finally {
      setRevising(false)
    }
  }, [settings, fields, filledFields, reviseInstruction])

  const handleApplyAll = useCallback(async () => {
    setViewState('applying')
    setAppliedCount(0)
    setFailedFieldIds([])

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) {
        setErrorMsg('Cannot access current tab for form filling.')
        setViewState('error')
        return
      }
      await ensureContentScript(tab.id)
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'APPLY_FIELD_VALUES',
        fields: filledFields,
        schemas: fields,
      })
      if (response?.type === 'APPLY_RESULT') {
        const skipped = filledFields.filter(f => f.skip).length
        const failed = response.failed ?? []
        const applied = filledFields.length - skipped - failed.length
        setAppliedCount(applied)
        setFailedFieldIds(failed)
        // A partially completed form is still useful. Keep the successful
        // values on the page and show the remaining fields as a warning rather
        // than replacing the review flow with a blocking error screen.
        setViewState('done')
        setErrorMsg(failed.length ? `${applied} fields filled; ${failed.length} need review.` : '')
        analyzePersonaMatches()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[FormFiller] APPLY_FIELD_VALUES failed:', message)
      setErrorMsg(`Could not reach page: ${message}. Try scanning again.`)
      setViewState('error')
    }
  }, [filledFields])

  const handleUpload = useCallback(async (fieldId: string) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) return
    await ensureContentScript(tab.id)
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_UPLOAD_PICKER', fieldId }) as { success?: boolean; error?: string } | undefined
    if (!response?.success) setErrorMsg(response?.error ?? 'Could not open the file picker.')
  }, [])

  const handleRequestPermission = useCallback(async () => {
    try {
      const granted = await chrome.permissions.request({ origins: ['<all_urls>'] })
      if (granted) {
        setInjectPermissionHost(null)
        setViewState('idle')
        // Re-scan after a short delay (permission just granted)
        setTimeout(() => {
          // Ensure the content script exists once, then send SCAN_FORM.
          ;(async () => {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
            const tabId = tabs[0]?.id
            if (!tabId) return
            try {
              setViewState('scanning')
              await ensureContentScript(tabId)
              const response = await chrome.tabs.sendMessage(tabId, { type: 'SCAN_FORM' })
              if (response?.type === 'FORM_DETECTED' && response.fields?.length > 0) {
                setFields(response.fields)
                analyzeFields(response.fields)
              } else {
                setErrorMsg('No form fields detected on this page.')
                setViewState('error')
              }
            } catch (error) {
              setErrorMsg(`Could not connect to this page: ${(error as Error).message}`)
              setViewState('error')
            }
          })()
        }, 500)
      } else {
        setErrorMsg('Permission denied. You can grant it later in chrome://extensions → ApplyMate AI → Details.')
      }
    } catch (e) {
      setErrorMsg(`Permission request failed: ${(e as Error).message}`)
    }
  }, []) // handleRequestPermission

  const handleFieldEdit = useCallback((fieldId: string, value: string) => {
    setFilledFields(prev => prev.map(f =>
      f.fieldId === fieldId
        ? {
            ...f,
            value,
            // Clear pre-filled status on edit — value is now user-modified
            ...(f.confidence === 1.0 && f.reasoning?.includes('already filled')
              ? { confidence: 0.85, reasoning: 'User edited (was pre-filled)' }
              : {}),
          }
        : f,
    ))
  }, [])

  const handleScanPage = useCallback(async () => {
    setViewState('scanning')
    setErrorMsg('')

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const tab = tabs[0]
    if (!tab?.id) {
      setErrorMsg('Cannot access current tab.')
      setViewState('error')
      return
    }

    // Check for restricted URLs where content scripts can never run
    const url = tab.url ?? ''
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:')) {
      setErrorMsg('Cannot scan Chrome system pages. Please navigate to a job application website first.')
      setViewState('error')
      return
    }

    // Proactively ensure <all_urls> permission (one-time grant)
    const hasAllUrls = await chrome.permissions.contains({ origins: ['<all_urls>'] })
    if (!hasAllUrls) {
      try {
        const granted = await chrome.permissions.request({ origins: ['<all_urls>'] })
        if (!granted) {
          setErrorMsg('Permission required to scan form fields on this page. Grant "Read and change all your data on all websites" to proceed.')
          setViewState('error')
          return
        }
        // Short delay after permission grant for Chrome to register it
        await new Promise(r => setTimeout(r, 300))
      } catch {
        // Fall through — try anyway (may work via activeTab)
      }
    }

    /**
     * Use the content scanner first so the scan IDs and the subsequent fill
     * IDs come from the same implementation. The direct scanner remains an
     * escape hatch for pages that reject content-script messaging.
     */
    async function tryScan(): Promise<{ ok: boolean; injectError?: string }> {
      try {
        await ensureContentScript(tab.id!)
      } catch (e: unknown) {
        const msg = (e as Error)?.message ?? String(e)
        console.warn('[FormFiller] content script ensure failed:', msg)
        return { ok: false, injectError: msg }
      }
      try {
        const response = await chrome.tabs.sendMessage(tab.id!, { type: 'SCAN_FORM' })
        if (response?.type === 'FORM_DETECTED' && response.fields?.length > 0) {
          setFields(response.fields)
          analyzeFields(response.fields)
          return { ok: true }
        }
      } catch { /* content script not available yet */ }

      try {
        const directFields = await scanFormDirectly(tab.id!)
        if (directFields.length > 0) {
          console.log('[FormFiller] Direct scan found', directFields.length, 'fields')
          setFields(directFields)
          analyzeFields(directFields)
          return { ok: true }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn('[FormFiller] Direct scan failed:', message)
        return { ok: false, injectError: message }
      }
      return { ok: false }
    }

    const r2 = await tryScan()
    if (r2.ok) return

    // Build a diagnostic error message
    const host = new URL(url).hostname
    const isPermissionError = r2.injectError?.includes('permission') ||
      r2.injectError?.includes('Cannot access') ||
      r2.injectError?.includes('not allowed')

    if (isPermissionError) {
      // Offer to request <all_urls> optional permission
      setErrorMsg(`ApplyMate needs permission to access ${host}. Click below to grant it (one-time).`)
      setViewState('error')
      setInjectPermissionHost(host)
    } else if (r2.injectError) {
      setErrorMsg(`Injection failed on ${host}: ${r2.injectError}`)
      setViewState('error')
    } else {
      setErrorMsg(`No form fields detected on ${host}. Make sure you are on a page with an application form.`)
      setViewState('error')
    }
  }, [settings])

  const confidenceBadge = (conf: number) => {
    const pct = Math.round(conf * 100)
    const color = pct >= 80 ? C.green : pct >= 50 ? C.amber : C.red
    return { pct, color }
  }

  // ── Render States ──────────────────────────────────────────

  if (viewState === 'idle' || viewState === 'scanning') {
    const scanning = viewState === 'scanning'
    return (
      <div style={{ padding: 16 }}>
        <div style={{ textAlign: 'center', padding: '40px 20px' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>&#128269;</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 4 }}>
            {scanning ? 'Scanning Page...' : 'Form Auto-Fill'}
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 20 }}>
            {scanning
              ? 'Scanning the current page for form fields...'
              : 'Navigate to any job application page, then click below to scan for form fields.'}
          </div>
          <button
            onClick={handleScanPage}
            disabled={scanning}
            style={{
              ...btnStyle(C.primary),
              fontSize: 13, padding: '10px 24px',
              opacity: scanning ? 0.6 : 1,
            }}
          >
            {scanning ? 'Scanning...' : 'Scan Current Page for Form'}
          </button>
          <div style={{ fontSize: 10, color: C.subtle, marginTop: 12 }}>
            Works on any company career site, Greenhouse, Lever, Workday, and more.
          </div>
        </div>
      </div>
    )
  }

  if (viewState === 'aiThinking') {
    const aiFieldCount = fields.filter(f => !f.currentValue?.trim()).length
    return <AnalysisProgressView phase={analysisPhase} totalFields={fields.length} aiFieldCount={aiFieldCount} elapsed={elapsedSeconds} />
  }

  if (viewState === 'error') {
    const isPermission = !!injectPermissionHost
    return (
      <div style={{ padding: 16 }}>
        <div style={{ textAlign: 'center', padding: 40 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>{isPermission ? '🔒' : '❌'}</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: isPermission ? C.amber : C.red }}>
            {isPermission ? 'Permission Required' : 'Error'}
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 4, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
            {errorMsg}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 16 }}>
            {isPermission ? (
              <>
                <button onClick={handleRequestPermission} style={btnStyle(C.green)}>
                  Grant Permission
                </button>
                <button onClick={() => { setInjectPermissionHost(null); setViewState('idle') }} style={{
                  background: 'transparent', color: C.muted, border: `1px solid ${C.border}`,
                  borderRadius: 6, padding: '8px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                }}>
                  Cancel
                </button>
              </>
            ) : (
              <button onClick={() => fields.length > 0 ? analyzeFields(fields) : handleScanPage()} style={btnStyle(C.primary)}>
                Retry
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (viewState === 'applying') {
    return (
      <div style={{ padding: 16 }}>
        <div style={{ textAlign: 'center', padding: 40, color: C.muted }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>&#128221;</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Filling Form...</div>
          <div style={{ fontSize: 12, marginTop: 4, color: C.primary }}>
            {appliedCount} / {filledFields.filter(f => !f.skip).length} fields
          </div>
          <div style={{
            width: '100%', height: 4, background: C.border, borderRadius: 2,
            marginTop: 12, overflow: 'hidden',
          }}>
            <div style={{
              height: '100%', background: C.green, borderRadius: 2,
              width: `${filledFields.filter(f => !f.skip).length > 0
                ? (appliedCount / filledFields.filter(f => !f.skip).length) * 100 : 0}%`,
              transition: 'width 0.3s ease',
            }} />
          </div>
        </div>
      </div>
    )
  }

  if (viewState === 'done') {
    const uploadFields = fields.filter(field => field.type === 'file')
    const failedFields = fields.filter(field => failedFieldIds.includes(field.id))
    return (
      <div style={{ padding: 16 }}>
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>&#9989;</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.green }}>Form Filled!</div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
            {failedFields.length
              ? `${appliedCount} fields filled — ${failedFields.length} still need your review.`
              : `${appliedCount} fields filled — review and submit manually.`}
          </div>
        </div>

        {failedFields.length > 0 && (
          <div style={{ background: '#FFF8E8', border: `1px solid ${C.amber}45`, borderRadius: 10, padding: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.amber, marginBottom: 4 }}>Review these fields manually</div>
            <div style={{ fontSize: 10, color: C.muted, lineHeight: 1.5 }}>
              Workday custom dropdowns can require a manual selection. Your other answers have already been filled and remain on the form.
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 9 }}>
              {failedFields.map(field => (
                <span key={field.id} style={{ fontSize: 10, color: C.text, background: C.card, border: `1px solid ${C.border}`, borderRadius: 999, padding: '4px 7px' }}>
                  {field.label || 'Unmatched field'}
                </span>
              ))}
            </div>
          </div>
        )}

        {uploadFields.length > 0 && (
          <div style={{ background: C.card, border: `1px solid ${C.primary}35`, borderRadius: 10, padding: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 4 }}>Attach reviewed documents</div>
            <div style={{ fontSize: 10, color: C.muted, lineHeight: 1.5, marginBottom: 10 }}>
              Choose your audited resume or cover-letter PDF in Chrome&apos;s file picker. ApplyMate cannot select local files for you.
            </div>
            {uploadFields.map(field => (
              <div key={field.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <span style={{ flex: 1, fontSize: 11, color: C.text }}>{field.label || 'Document upload'}{field.required ? ' *' : ''}</span>
                {uploadedFiles[field.id] ? (
                  <span style={{ fontSize: 10, color: C.green, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>✓ {uploadedFiles[field.id]}</span>
                ) : (
                  <button onClick={() => handleUpload(field.id)} style={{ ...btnStyle(C.primary), fontSize: 10, padding: '6px 9px' }}>Choose file</button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Persona Save Prompt */}
        {personaMatches.length > 0 && (
          <div style={{
            background: C.card, border: `1px solid ${C.green}40`, borderRadius: 10,
            padding: 12, marginBottom: 12,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: C.text }}>Save to Persona?</span>
              <button
                onClick={handleRefreshPersona}
                disabled={savingPersona}
                title="Re-read form values from the page and compare with saved persona"
                style={{
                  ...btnStyleGhost(), fontSize: 10, padding: '3px 8px',
                  opacity: savingPersona ? 0.5 : 1,
                }}
              >
                🔄 Refresh
              </button>
            </div>
            <div style={{ fontSize: 10, color: C.muted, marginBottom: 10 }}>
              {personaMatches.filter(m => !m.existingValue).length} new, {personaMatches.filter(m => m.existingValue).length} updated — edit on page, then refresh
            </div>
            <div style={{ maxHeight: 160, overflowY: 'auto', marginBottom: 10 }}>
              {personaMatches.map(m => (
                <div key={m.personaKey} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '5px 0', borderBottom: `1px solid ${C.border}`,
                  fontSize: 10,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {m.label}
                    </div>
                    <div style={{ color: C.green, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {m.value}
                    </div>
                    {m.existingValue && (
                      <div style={{ color: C.subtle, textDecoration: 'line-through', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        was: {m.existingValue}
                      </div>
                    )}
                  </div>
                  <span style={{ fontSize: 9, color: m.existingValue ? C.amber : C.green, fontWeight: 600, flexShrink: 0 }}>
                    {m.existingValue ? 'UPDATE' : 'NEW'}
                  </span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleSavePersonaMatches} disabled={savingPersona} style={{ ...btnStyle(C.green), flex: 1 }}>
                {savingPersona ? 'Saving...' : 'Save to Persona'}
              </button>
              <button onClick={() => setPersonaMatches([])} style={btnStyleGhost()}>
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* Next Step */}
        <div style={{ textAlign: 'center', borderTop: `1px solid ${C.border}`, paddingTop: 14 }}>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
            Multi-step application? Go to the next page and scan again.
          </div>
          <button onClick={handleScanPage} style={btnStyle(C.primary)}>
            Scan Next Step
          </button>
        </div>
      </div>
    )
  }

  // ── Main Review View ───────────────────────────────────────

  return (
    <div style={{ padding: '16px', paddingBottom: 16 }}>
      {/* Header */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 2 }}>
          Form Fields ({fields.length})
        </div>
        <div style={{ fontSize: 11, color: C.muted }}>
          {filledFields.filter(f => f.confidence === 1.0 && f.reasoning?.includes('already filled')).length} pre-filled,{' '}
          {filledFields.filter(f => f.reasoning?.includes('Matched from persona')).length} persona-matched,{' '}
          {filledFields.filter(f => !(f.confidence === 1.0 && f.reasoning?.includes('already filled')) && !f.reasoning?.includes('Matched from persona') && !f.skip).length} AI-suggested
        </div>
      </div>

      {/* Apply All Button */}
      <button
        onClick={handleApplyAll}
        style={{
          ...btnStyle(C.green), width: '100%', marginBottom: 12,
          fontSize: 14, fontWeight: 700, padding: '10px 16px',
        }}
      >
        Apply All to Form
      </button>

      {/* Field List */}
      <div style={{ maxHeight: '50vh', overflowY: 'auto', marginBottom: 12 }}>
        {filledFields.map(f => {
          const fieldSchema = fields.find(s => s.id === f.fieldId)
          if (f.skip) return null

          const { pct, color } = confidenceBadge(f.confidence)

          return (
            <div
              key={f.fieldId}
              style={{
                background: C.card, border: `1px solid ${C.border}`,
                borderRadius: 8, padding: 10, marginBottom: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: C.text }}>
                  {fieldSchema?.label ?? f.fieldId}
                  {fieldSchema?.required && <span style={{ color: C.red, marginLeft: 2 }}>*</span>}
                </span>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  {f.confidence === 1.0 && f.reasoning?.includes('already filled') && f.value?.trim() && (
                    <span style={{
                      fontSize: 9, fontWeight: 600, color: C.primary,
                      background: `${C.primary}12`, padding: '2px 6px', borderRadius: 10,
                    }}>
                      PRE-FILLED
                    </span>
                  )}
                  {f.reasoning?.includes('Matched from persona') && (
                    <span style={{
                      fontSize: 9, fontWeight: 600, color: C.teal,
                      background: `${C.teal}12`, padding: '2px 6px', borderRadius: 10,
                    }}>
                      PERSONA
                    </span>
                  )}
                  <span style={{
                    fontSize: 10, fontWeight: 600, color,
                    background: `${color}15`, padding: '2px 6px', borderRadius: 10,
                  }}>
                    {pct}%
                  </span>
                </div>
              </div>

              <textarea
                value={f.value}
                onChange={e => handleFieldEdit(f.fieldId, e.target.value)}
                rows={2}
                style={{
                  width: '100%', border: `1px solid ${C.border}`, borderRadius: 4,
                  padding: 6, fontSize: 12, fontFamily: 'inherit',
                  resize: 'vertical', color: C.text,
                  boxSizing: 'border-box',
                }}
              />

              {f.reasoning && (
                <div style={{ fontSize: 10, color: C.muted, marginTop: 2, fontStyle: 'italic' }}>
                  {f.reasoning}
                </div>
              )}

              {fieldSchema?.type === 'select' && fieldSchema?.options && (
                <div style={{ marginTop: 4 }}>
                  <select
                    value={f.value}
                    onChange={e => handleFieldEdit(f.fieldId, e.target.value)}
                    style={{
                      width: '100%', border: `1px solid ${C.border}`,
                      borderRadius: 4, padding: 4, fontSize: 11, color: C.text,
                    }}
                  >
                    <option value="">-- Select --</option>
                    {fieldSchema.options.map(o => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Revise Panel */}
      <div style={{
        border: `1px solid ${C.border}`, borderRadius: 8, padding: 10,
        background: C.bg, marginBottom: 10,
      }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: C.text, marginBottom: 6 }}>
          AI Revise with Natural Language
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="text"
            value={reviseInstruction}
            onChange={e => setReviseInstruction(e.target.value)}
            placeholder="e.g., make answers more concise, emphasize leadership..."
            style={{
              flex: 1, border: `1px solid ${C.border}`, borderRadius: 4,
              padding: '6px 8px', fontSize: 11, color: C.text,
            }}
            onKeyDown={e => e.key === 'Enter' && handleRevise()}
          />
          <button
            onClick={handleRevise}
            disabled={revising || !reviseInstruction.trim()}
            style={{
              ...btnStyle(C.primary), fontSize: 11, padding: '6px 12px',
              opacity: revising ? 0.6 : 1,
            }}
          >
            {revising ? '...' : 'Revise'}
          </button>
        </div>
      </div>

      {/* Re-scan for multi-step forms */}
      <div style={{
        border: `1px dashed ${C.border}`, borderRadius: 8, padding: 10,
        background: 'transparent', textAlign: 'center',
      }}>
        <div style={{ fontSize: 10, color: C.subtle, marginBottom: 6 }}>
          Multi-step form? Go to next page →
        </div>
        <button onClick={handleScanPage} style={{
          background: 'transparent', color: C.primary, border: `1px solid ${C.primary}30`,
          borderRadius: 6, padding: '6px 14px', fontSize: 11,
          fontWeight: 600, cursor: 'pointer',
        }}>
          &#128269; Scan New Step
        </button>
      </div>
    </div>
  )
}

// ── AI Analysis Progress View ─────────────────────────────────

const PHASE_INFO: Record<AnalysisPhase, { icon: string; label: string; subLabel: (n: number) => string; pct: number }> = {
  fetchingPersona:  { icon: '👤', label: 'Fetching your profile...',      subLabel: () => 'Loading resume, preferences & contact info', pct: 15 },
  preparingPrompt:  { icon: '📝', label: 'Preparing AI prompt...',        subLabel: (n) => `Formatting ${n} fields for AI analysis`,    pct: 30 },
  waitingForAI:     { icon: '⚡', label: 'AI is analyzing your form...',  subLabel: (n) => `Generating answers for ${n} fields`,         pct: 70 },
  processingResult: { icon: '🔍', label: 'Processing results...',          subLabel: () => 'Parsing and validating AI responses',        pct: 95 },
}

function AnalysisProgressView({ phase, totalFields, aiFieldCount, elapsed }: { phase: AnalysisPhase; totalFields: number; aiFieldCount: number; elapsed: number }) {
  const info = PHASE_INFO[phase]
  const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
  // Rough estimate: ~3s per AI field (MiniMax M2.7 average)
  const estSeconds = Math.max(10, Math.min(180, aiFieldCount * 3))
  const estStr = estSeconds < 60 ? `~${estSeconds}s` : `~${Math.round(estSeconds / 60)}min`

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: 0, flex: '0 0 auto' }}>
        <div style={{ fontSize: 42, marginBottom: 12, display: 'flex', justifyContent: 'center', gap: 12 }}>
          {(['fetchingPersona', 'preparingPrompt', 'waitingForAI', 'processingResult'] as AnalysisPhase[]).map((p, i) => {
            const isDone = (['fetchingPersona', 'preparingPrompt', 'waitingForAI', 'processingResult'].indexOf(phase)) >= i
            const isCurrent = phase === p
            return (
              <span key={p} style={{
                opacity: isDone ? 1 : 0.25,
                fontSize: isCurrent ? 36 : 28,
                transition: 'all 0.4s ease',
                transform: isCurrent ? 'scale(1.15)' : 'scale(1)',
              }}>
                {PHASE_INFO[p].icon}
              </span>
            )
          })}
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 4 }}>
          {info.label}
        </div>
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 12 }}>
          {info.subLabel(aiFieldCount)}
        </div>
      </div>

      {/* Progress Bar */}
      <div style={{ flex: '0 0 auto', padding: '0 8px', marginBottom: 16 }}>
        <div style={{
          width: '100%', height: 8, background: C.border, borderRadius: 4, overflow: 'hidden',
          position: 'relative',
        }}>
          {/* Determinate fill based on phase */}
          <div style={{
            height: '100%',
            background: `linear-gradient(90deg, ${C.primary}, ${C.green})`,
            borderRadius: 4,
            width: `${info.pct}%`,
            transition: 'width 0.6s ease',
            position: 'absolute', top: 0, left: 0,
          }} />
          {/* Animated shimmer on the progress bar */}
          <div style={{
            position: 'absolute', top: 0, left: 0, height: '100%', width: '100%',
            background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.25) 50%, transparent 100%)',
            animation: 'shimmer 1.6s ease-in-out infinite',
          }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
          <div>
            <span style={{ fontSize: 10, color: C.muted }}>Phase: </span>
            <span style={{ fontSize: 10, fontWeight: 600, color: C.primary }}>
              {['fetchingPersona', 'preparingPrompt', 'waitingForAI', 'processingResult'].indexOf(phase) + 1}/4
            </span>
          </div>
          <div>
            <span style={{ fontSize: 10, fontWeight: 600, color: C.subtle }}>{info.pct}%</span>
          </div>
          <div>
            <span style={{ fontSize: 10, color: C.muted }}>Elapsed: </span>
            <span style={{ fontSize: 10, fontWeight: 600, color: C.subtle }}>{elapsedStr}</span>
          </div>
        </div>
      </div>

      {/* Field Summary */}
      <div style={{
        flex: '0 0 auto',
        background: C.card, border: `1px solid ${C.border}`, borderRadius: 10,
        padding: '12px 14px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: C.text }}>
            {totalFields} fields total
          </span>
          <span style={{ fontSize: 10, color: C.subtle }}>
            Est: {estStr}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          {totalFields - aiFieldCount > 0 && (
            <span style={{ fontSize: 10, color: C.primary, background: `${C.primary}12`, padding: '2px 8px', borderRadius: 10 }}>
              {totalFields - aiFieldCount} pre-filled ✓
            </span>
          )}
          <span style={{ fontSize: 10, color: C.muted, background: C.bg, padding: '2px 8px', borderRadius: 10 }}>
            {aiFieldCount} need AI
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* Animated dots showing activity */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: C.primary,
                  opacity: 1,
                  animation: `dotPulse 1.4s ${i * 0.2}s ease-in-out infinite`,
                }}
              />
            ))}
            <span style={{ fontSize: 10, color: C.muted, marginLeft: 4 }}>
              {phase === 'fetchingPersona' && 'Loading your data...'}
              {phase === 'preparingPrompt' && 'Building prompt context...'}
              {phase === 'waitingForAI' && `Generating answers (this may take 30-90s)...`}
              {phase === 'processingResult' && 'Parsing AI response...'}
            </span>
          </div>
        </div>
      </div>

      {/* Tip */}
      <div style={{
        flex: '0 0 auto', marginTop: 12,
        fontSize: 10, color: C.subtle, textAlign: 'center', lineHeight: 1.6,
      }}>
        {phase === 'waitingForAI'
          ? 'AI is carefully considering each field based on your profile.\nResponses with higher confidence will show in green.'
          : 'Your profile data stays private — it\'s only used for this form fill.'
        }
      </div>

      <style>{`
        @keyframes shimmer {
          from { transform: translateX(-100%); }
          to   { transform: translateX(100%); }
        }
        @keyframes dotPulse {
          0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
          40%           { transform: scale(1);   opacity: 1; }
        }
      `}</style>
    </div>
  )
}

function btnStyle(bg: string): React.CSSProperties {
  return {
    background: bg, color: '#fff', border: 'none',
    borderRadius: 6, padding: '8px 14px', fontSize: 12,
    fontWeight: 600, cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    gap: 6,
  }
}

function btnStyleGhost(): React.CSSProperties {
  return {
    background: 'transparent', color: '#64748b',
    border: '1px solid #e2e8f0', borderRadius: 6,
    padding: '6px 12px', fontSize: 11,
    fontWeight: 600, cursor: 'pointer',
  }
}

// ── Persona Matching Engine ──────────────────────────────────────────────────────

interface KnownAnswer {
  key: string        // e.g. "name", "email", "phone"
  value: string
  confidence: number
  source: string     // "profile" | "persona" | "resume"
  keywords: string[] // label keywords that match this answer
}

/** Extract known answers from persona text + structured persona fields */
function buildKnownAnswers(persona: string, personaFields: { key: string; label: string; value: string; confidence: number; category: string }[]): KnownAnswer[] {
  const answers: KnownAnswer[] = []

  // 1. Parse profile fields from persona string (NAME:, EMAIL:, etc.)
  const parseLine = (key: string) => {
    const m = persona.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
    return m ? m[1].trim() : ''
  }
  const nameVal = parseLine('NAME')
  const emailVal = parseLine('EMAIL')
  const phoneVal = parseLine('PHONE')
  const locationVal = parseLine('LOCATION')
  const linkedinVal = parseLine('LINKEDIN')
  const githubVal = parseLine('GITHUB')

  if (nameVal && nameVal !== 'N/A') answers.push({
    key: 'name', value: nameVal, confidence: 1.0, source: 'profile',
    keywords: ['name', 'first name', 'last name', 'full name', 'legal name', '姓名', '名字'],
  })
  if (emailVal) answers.push({
    key: 'email', value: emailVal, confidence: 1.0, source: 'profile',
    keywords: ['email', 'e-mail', 'email address', '邮箱', '电子邮箱'],
  })
  if (phoneVal) answers.push({
    key: 'phone', value: phoneVal, confidence: 1.0, source: 'profile',
    keywords: ['phone', 'phone number', 'mobile', 'cell', 'telephone', '电话', '手机'],
  })
  if (locationVal) answers.push({
    key: 'location', value: locationVal, confidence: 0.95, source: 'profile',
    keywords: ['location', 'city', 'address', 'where are you', 'country', 'region', 'state', '所在地', '地址', '城市'],
  })
  if (linkedinVal && linkedinVal !== 'N/A') answers.push({
    key: 'linkedin', value: linkedinVal, confidence: 1.0, source: 'profile',
    keywords: ['linkedin', 'linkedin url', 'linkedin profile'],
  })
  if (githubVal && githubVal !== 'N/A') answers.push({
    key: 'github', value: githubVal, confidence: 1.0, source: 'profile',
    keywords: ['github', 'github url', 'github profile', 'portfolio'],
  })

  // 2. Add structured persona fields (form-fill history)
  for (const pf of personaFields) {
    if (!pf.value?.trim()) continue
    // Generate keywords from the label — split on common delimiters
    const labelLower = pf.label.toLowerCase()
    const kw = new Set<string>()
    kw.add(labelLower)
    // Also add individual words (excluding short/common words)
    for (const w of labelLower.split(/[\s\/\-–—(),.:;]+/)) {
      if (w.length >= 3 && !/^(the|and|for|your|what|when|where|which|this|that|with|from|have|been|were|are|not|its|can|you|all|has|had|was|will|would|should|could|may|might|shall|must|each|every|some|any|both|few|many|more|most|other|such|only|also|very|just)$/.test(w)) {
        kw.add(w)
      }
    }
    answers.push({
      key: pf.key,
      value: pf.value,
      confidence: pf.confidence,
      source: `persona:${pf.category}`,
      keywords: [...kw],
    })
  }

  // 3. Extract resume skills as potential answers
  const skillsMatch = persona.match(/^SKILLS:\s*(.+)$/m)
  if (skillsMatch) {
    const skills = skillsMatch[1].split(',').map(s => s.trim()).filter(Boolean)
    for (const sk of skills) {
      answers.push({
        key: `skill:${sk.toLowerCase()}`,
        value: sk,
        confidence: 0.9,
        source: 'resume',
        keywords: [sk.toLowerCase(), 'skills', 'skill', 'technical skills', '技术', '技能'],
      })
    }
  }

  return answers
}

/** Compute label similarity score between a field label and a known answer's keywords */
function labelSimilarity(fieldLabel: string, keywords: string[]): number {
  const label = fieldLabel.toLowerCase().replace(/[?*:]/g, '').trim()
  if (!label) return 0

  for (const kw of keywords) {
    const kwLower = kw.toLowerCase()
    // Exact match or label contains keyword as a whole word
    if (label === kwLower) return 1.0
    if (new RegExp(`\\b${kwLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(label)) return 0.95
    // Label contains keyword as substring
    if (label.includes(kwLower)) return 0.85
    // Keyword contains label
    if (kwLower.includes(label) && label.length >= 3) return 0.8
  }
  return 0
}

/** Try to match a form field against known persona answers. Returns the best match or null. */
function findPersonaMatch(field: FormFieldSchema, answers: KnownAnswer[]): { value: string; confidence: number; source: string } | null {
  const label = field.label || ''
  const surroundingText = field.surroundingText || ''
  const combinedText = `${label} ${surroundingText}`

  let best: { answer: KnownAnswer; score: number } | null = null

  for (const a of answers) {
    const score = labelSimilarity(combinedText, a.keywords)
    if (score > (best?.score ?? 0)) {
      best = { answer: a, score }
    }
  }

  // Require at least 0.8 similarity to use persona match directly
  const MIN_SCORE = 0.8
  if (best && best.score >= MIN_SCORE) {
    return {
      value: best.answer.value,
      confidence: best.answer.confidence * best.score,
      source: best.answer.source,
    }
  }

  return null
}
