/**
 * FormFillerView — Sidepanel tab for reviewing & applying AI-generated form answers.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FilePenLine,
  FileText,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Upload,
  UserRound,
  WandSparkles,
} from 'lucide-react'
import { getSettings, saveSettings } from '@/lib/storage'
import { getPersona, analyzeForm, reviseFormFields, getPersonaFields, savePersonaFields } from '@/lib/api'
import { getCurrentJob } from '@/lib/storage'
import type { ExtensionSettings } from '@/lib/types'
import { useExtensionI18n } from '@/lib/i18n'
import type { FormFieldSchema, FilledField, FormFillResponse } from '@/lib/form-filler/types'
import type { PersonaField } from '@/lib/api'
import { groupFieldIdsByFrame, groupFilledFieldsByFrame } from '@/lib/form-filler/frame-routing'

type ViewState = 'idle' | 'scanning' | 'aiThinking' | 'review' | 'applying' | 'done' | 'error'
type AnalysisPhase = 'fetchingPersona' | 'preparingPrompt' | 'waitingForAI' | 'processingResult'
const ALL_SITE_ORIGINS = ['https://*/*', 'http://*/*'] as const

const contentScriptLoads = new Map<number, Promise<void>>()

async function ensureContentScript(tabId: number): Promise<void> {
  const pending = contentScriptLoads.get(tabId)
  if (pending) return pending

  const load = (async () => {
    const probe = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'ISOLATED',
      func: () => {
        const state = (globalThis as typeof globalThis & {
          __applyMateContentScriptState?: 'loading' | 'ready'
        }).__applyMateContentScriptState
        return state === 'loading' || state === 'ready'
      },
    })

    const missingFrameIds = probe
      .filter(result => result.result !== true)
      .map(result => result.frameId)
    if (missingFrameIds.length === 0 && probe.length > 0) return

    await chrome.scripting.executeScript({
      target: missingFrameIds.length > 0 ? { tabId, frameIds: missingFrameIds } : { tabId, allFrames: true },
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
    target: { tabId, allFrames: true },
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

  const fields: FormFieldSchema[] = []
  for (const result of results) {
    if (!Array.isArray(result.result)) continue
    const frameId = result.frameId ?? 0
    for (const field of result.result as FormFieldSchema[]) {
      fields.push({ ...field, id: `frame|${frameId}|${field.id}`, frameId })
    }
  }
  return fields
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
        url.hostname === 'applymate.site' ||
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
  const { lang, t } = useExtensionI18n()
  const [viewState, setViewState] = useState<ViewState>('idle')
  const [fields, setFields] = useState<FormFieldSchema[]>([])
  const [filledFields, setFilledFields] = useState<FilledField[]>([])
  const [errorMsg, setErrorMsg] = useState('')
  const [allSitesAccess, setAllSitesAccess] = useState(false)
  const [requestingAccess, setRequestingAccess] = useState(false)
  const [appliedCount, setAppliedCount] = useState(0)
  const [reviseInstruction, setReviseInstruction] = useState('')
  const [revising, setRevising] = useState(false)
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

  useEffect(() => {
    void chrome.permissions.contains({ origins: [...ALL_SITE_ORIGINS] })
      .then(setAllSitesAccess)
      .catch(() => setAllSitesAccess(false))
  }, [])

  const handleRequestAllSitesAccess = useCallback(async () => {
    setRequestingAccess(true)
    try {
      const granted = await chrome.permissions.request({ origins: [...ALL_SITE_ORIGINS] })
      setAllSitesAccess(granted)
      if (granted) {
        setErrorMsg('')
        setViewState('idle')
      }
    } catch (error) {
      console.warn('[FormFiller] all-site permission request failed:', error)
    } finally {
      setRequestingAccess(false)
    }
  }, [])

  /** Build a persona key from a field label (for dedup across sites) */
  function fieldToPersonaKey(label: string): string {
    return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 50)
  }

  // GDPR data minimisation: these answers are never offered for Persona
  // storage, even if a site form or model marks them as reusable.
  function isPersonaSafe(label: string): boolean {
    return !/(gender|sex|pronoun|birth|age|race|ethnic|religion|faith|politic|union|health|medical|disab|veteran|criminal|passport|national[_ ]?id)/i.test(label)
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
      if (!isPersonaSafe(label)) continue
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

      const fieldIds = filledFields.filter(f => !f.skip).map(f => f.fieldId)
      const grouped = groupFieldIdsByFrame(fieldIds, fields)
      const responses = await Promise.all([...grouped.entries()].map(async ([frameId, ids]) => {
        try {
          return await chrome.tabs.sendMessage(tabId, { type: 'READ_FIELD_VALUES', fieldIds: ids }, { frameId }) as { type?: string; values?: Array<{ fieldId: string; value: string }> } | undefined
        } catch { return undefined }
      }))
      const values = responses.flatMap(response => response?.type === 'FIELD_VALUES_RESULT' ? response.values ?? [] : [])
      if (values.length === 0) return

      const matches = await computePersonaMatches(values)
      setPersonaMatches(matches)
    } catch { /* ignore */ }
    finally { setSavingPersona(false) }
  }

  async function handleSavePersonaMatches() {
    setSavingPersona(true)
    try {
      const fields: PersonaField[] = personaMatches.map(m => ({
        key:        m.personaKey,
        category:   guessCategoryFromLabel(m.label),
        label:      m.label,
        value:      m.value,
        confidence: 1.0,
        source:     'form_scan',
        updatedAt:  new Date().toISOString(),
        consentAt:  new Date().toISOString(),
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
        console.log('[FormFiller] Pre-filled fields:', prefilled.map(f => f.label).join(', '))
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
          getPersona(activeSettings, 'form_fill'),
          getPersonaFields(activeSettings, 'form_fill').catch(() => ({ fields: [] })),
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
        const job = await getCurrentJob(activeSettings.userEmail)
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
      const groups = groupFilledFieldsByFrame(filledFields, fields)
      const responses = await Promise.all(groups.map(async group => {
        const response = await chrome.tabs.sendMessage(tab.id!, {
          type: 'APPLY_FIELD_VALUES',
          fields: group.fields,
          schemas: group.schemas,
        }, { frameId: group.frameId }) as { type?: string; failed?: string[] } | undefined
        return response?.type === 'APPLY_RESULT'
          ? response
          : { failed: group.fields.filter(field => !field.skip).map(field => field.fieldId) }
      }))
      if (responses.length > 0) {
        const skipped = filledFields.filter(f => f.skip).length
        const failed = responses.flatMap(response => response.failed ?? [])
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
  }, [filledFields, fields, analyzePersonaMatches])

  const handleUpload = useCallback(async (fieldId: string) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) return
    await ensureContentScript(tab.id)
    const frameId = fields.find(field => field.id === fieldId)?.frameId ?? 0
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_UPLOAD_PICKER', fieldId }, { frameId }) as { success?: boolean; error?: string } | undefined
    if (!response?.success) setErrorMsg(response?.error ?? 'Could not open the file picker.')
  }, [fields])

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

    /**
     * The direct scanner runs in every accessible frame and supplies stable
     * frame-qualified IDs. The content scanner remains a fallback for custom
     * widgets that are not represented by the direct DOM selector.
     */
    async function tryScan(): Promise<{ ok: boolean; injectError?: string }> {
      try {
        await ensureContentScript(tab.id!)
      } catch (e: unknown) {
        const msg = (e as Error)?.message ?? String(e)
        console.warn('[FormFiller] content script ensure failed:', msg)
        return { ok: false, injectError: msg }
      }
      if (allSitesAccess) {
        try {
          await chrome.tabs.sendMessage(tab.id!, { type: 'ENABLE_JOB_SCRAPING' })
        } catch {
          // The scan can still proceed if the page's script was just starting.
        }
      }
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

      try {
        const response = await chrome.tabs.sendMessage(tab.id!, { type: 'SCAN_FORM' })
        if (response?.type === 'FORM_DETECTED' && response.fields?.length > 0) {
          setFields(response.fields)
          analyzeFields(response.fields)
          return { ok: true }
        }
      } catch { /* content script not available yet */ }
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
      setErrorMsg(`Chrome has not granted access to ${host}. Allow access to all websites once, then scan any company form without activating the extension for every new site.`)
      setViewState('error')
    } else if (r2.injectError) {
      setErrorMsg(`Injection failed on ${host}: ${r2.injectError}`)
      setViewState('error')
    } else {
      setErrorMsg(`No form fields detected on ${host}. Make sure you are on a page with an application form.`)
      setViewState('error')
    }
  }, [allSitesAccess, settings])

  const confidenceBadge = (conf: number) => {
    const pct = Math.round(conf * 100)
    const tone = pct >= 80 ? 'high' : pct >= 50 ? 'medium' : 'low'
    return { pct, tone }
  }

  // ── Render States ──────────────────────────────────────────

  if (viewState === 'idle' || viewState === 'scanning') {
    const scanning = viewState === 'scanning'
    return (
      <div className="am-form-view am-form-idle">
        <div className="am-form-context">
          <div className="am-form-context-icon"><FileText size={16} strokeWidth={2.2} /></div>
          <div className="am-form-context-copy">
            <span className="am-form-eyebrow">{t('APPLICATION FORM')}</span>
            <strong>{t('Form auto-fill')}</strong>
          </div>
          <span className="am-form-context-status">{t('Ready')}</span>
        </div>

        <div className="am-form-hero">
          <div className="am-form-hero-icon"><ScanSearch size={23} strokeWidth={1.8} /></div>
          <h2>{scanning ? t('Scanning this page') : t('Ready to scan this page')}</h2>
          <p>
            {scanning
              ? t('Looking for fields on the current application page.')
              : t('Find application fields and prepare answers from your ApplyMate profile.')}
          </p>
          <button className="am-form-button primary" onClick={handleScanPage} disabled={scanning}>
            <ScanSearch size={15} />
            {scanning ? t('Scanning page') : t('Scan current page')}
            {!scanning && <ArrowRight size={14} />}
          </button>
          <span className="am-form-helper">
            Works with company career sites, Greenhouse, Lever, Workday, and more.
            When you scan, ApplyMate reads field labels and any existing values on this page to prepare suggestions.
            Review everything before filling; it never submits the application.
            <a href="https://applymate.site/privacy" target="_blank" rel="noreferrer">{t('Privacy & data use')}</a>
          </span>
          <div className="am-form-access-card">
            <div>
              <strong>{allSitesAccess ? t('All websites access enabled') : t('Use on any company career site')}</strong>
              <span>{allSitesAccess ? t('You can scan custom forms without activating the extension on each new domain.') : t('Grant once to scan custom forms, Workday, and other ATS pages.')}</span>
            </div>
            {!allSitesAccess && (
              <button className="am-form-button ghost small" onClick={handleRequestAllSitesAccess} disabled={requestingAccess}>
                {requestingAccess ? t('Waiting...') : t('Allow access')}
              </button>
            )}
          </div>
        </div>

        <div className="am-form-info-strip">
          <ShieldCheck size={15} />
          <span>{t('Your profile and scanned form data are used only for the ApplyMate feature you start.')}</span>
        </div>
      </div>
    )
  }

  if (viewState === 'aiThinking') {
    const aiFieldCount = fields.filter(f => !f.currentValue?.trim()).length
    return <AnalysisProgressView phase={analysisPhase} totalFields={fields.length} aiFieldCount={aiFieldCount} elapsed={elapsedSeconds} />
  }

  if (viewState === 'error') {
    return (
      <div className="am-form-view">
        <div className="am-form-state error">
          <div className="am-form-state-icon"><AlertTriangle size={22} /></div>
          <span className="am-form-eyebrow">{t('FORM AUTO-FILL')}</span>
          <h2>{t('We could not scan this page')}</h2>
          <p>{lang === 'zh' ? t('Something went wrong') : errorMsg}</p>
          <div className="am-form-actions">
            <button className="am-form-button primary" onClick={() => fields.length > 0 ? analyzeFields(fields) : handleScanPage()}>
              <RefreshCw size={14} />
              {t('Retry')}
            </button>
            {!allSitesAccess && (
              <button className="am-form-button ghost" onClick={handleRequestAllSitesAccess} disabled={requestingAccess}>
                <ShieldCheck size={14} />
                {requestingAccess ? t('Waiting for permission') : t('Allow all websites')}
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (viewState === 'applying') {
    const fillableCount = filledFields.filter(f => !f.skip).length
    const progress = fillableCount > 0 ? (appliedCount / fillableCount) * 100 : 0
    return (
      <div className="am-form-view am-form-centered">
        <div className="am-form-state-icon primary"><FilePenLine size={22} className="am-form-icon-pulse" /></div>
        <span className="am-form-eyebrow">{t('APPLYMATE IS WORKING')}</span>
        <h2>{t('Filling your form')}</h2>
        <p className="am-form-state-copy">{t('Applying reviewed answers to the current page.')}</p>
        <div className="am-form-progress" aria-label={`Filled ${appliedCount} of ${fillableCount} fields`}>
          <span style={{ width: `${progress}%` }} />
        </div>
        <div className="am-form-progress-meta">
          <strong>{appliedCount} / {fillableCount} fields</strong>
          <span>{Math.round(progress)}%</span>
        </div>
      </div>
    )
  }

  if (viewState === 'done') {
    const uploadFields = fields.filter(field => field.type === 'file')
    const failedFields = fields.filter(field => failedFieldIds.includes(field.id))
    return (
      <div className="am-form-view am-form-done">
        <div className="am-form-success">
          <div className="am-form-success-icon"><CheckCircle2 size={25} /></div>
          <span className="am-form-eyebrow">{t('FORM AUTO-FILL')}</span>
          <h2>{t('Form filled')}</h2>
          <p>
            {failedFields.length
              ? `${appliedCount} ${t('fields filled')} — ${failedFields.length} ${t('still need your review')}.`
              : `${appliedCount} ${t('fields filled')} — ${t('review and submit manually')}.`}
          </p>
        </div>

        {failedFields.length > 0 && (
          <div className="am-form-callout warning">
            <div className="am-form-callout-title"><AlertTriangle size={14} /> {t('Review these fields manually')}</div>
            <p>
              {t('Workday custom dropdowns can require a manual selection. Your other answers have already been filled and remain on the form.')}
            </p>
            <div className="am-form-chip-list">
              {failedFields.map(field => (
                <span key={field.id} className="am-form-chip">
                  {field.label || t('Unmatched field')}
                </span>
              ))}
            </div>
          </div>
        )}

        {uploadFields.length > 0 && (
          <div className="am-form-card am-form-upload">
            <div className="am-form-card-title"><Upload size={14} /> {t('Attach reviewed documents')}</div>
            <p>
              {t("Choose your audited resume or cover-letter PDF in Chrome's file picker. ApplyMate cannot select local files for you.")}
            </p>
            {uploadFields.map(field => (
              <div key={field.id} className="am-form-upload-row">
                <span>{field.label || t('Document upload')}{field.required ? ' *' : ''}</span>
                {uploadedFiles[field.id] ? (
                  <span className="am-form-uploaded"><CheckCircle2 size={12} /> {uploadedFiles[field.id]}</span>
                ) : (
                  <button className="am-form-button small primary" onClick={() => handleUpload(field.id)}><Upload size={12} /> {t('Choose file')}</button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Persona Save Prompt */}
        {personaMatches.length > 0 && (
          <div className="am-form-card am-form-persona">
            <div className="am-form-card-head">
              <div className="am-form-card-title"><UserRound size={14} /> {t('Save updates to your profile?')}</div>
              <button
                onClick={handleRefreshPersona}
                disabled={savingPersona}
                title={t('Re-read form values from the page and compare with saved persona')}
                className="am-form-icon-button"
              >
                <RefreshCw size={12} className={savingPersona ? 'am-form-icon-pulse' : undefined} />
                {t('Refresh')}
              </button>
            </div>
            <p>
              {personaMatches.filter(m => !m.existingValue).length} new, {personaMatches.filter(m => m.existingValue).length} updated — edit on page, then refresh
            </p>
            <div className="am-form-persona-list">
              {personaMatches.map(m => (
                <div key={m.personaKey} className="am-form-persona-row">
                  <div>
                    <strong>
                      {m.label}
                    </strong>
                    <span className="am-form-persona-value">
                      {m.value}
                    </span>
                    {m.existingValue && (
                      <small>
                        was: {m.existingValue}
                      </small>
                    )}
                  </div>
                  <span className={`am-form-badge ${m.existingValue ? 'warning' : 'success'}`}>
                    {m.existingValue ? t('UPDATE') : t('NEW')}
                  </span>
                </div>
              ))}
            </div>
            <div className="am-form-actions stretch">
              <button className="am-form-button primary" onClick={handleSavePersonaMatches} disabled={savingPersona}>
                <CheckCircle2 size={14} />
                {savingPersona ? t('Saving...') : t('Save to Persona')}
              </button>
              <button className="am-form-button ghost" onClick={() => setPersonaMatches([])}>
                {t('Dismiss')}
              </button>
            </div>
          </div>
        )}

        {/* Next Step */}
        <div className="am-form-next">
          <div>
            <strong>{t('Continue to the next step?')}</strong>
            <span>{t('Open the next page and scan again.')}</span>
          </div>
          <button className="am-form-button ghost" onClick={handleScanPage}>
          {t('Scan next step')} <ArrowRight size={13} />
          </button>
        </div>
      </div>
    )
  }

  // ── Main Review View ───────────────────────────────────────

  return (
    <div className="am-form-view am-form-review">
      <div className="am-form-review-head">
        <div>
          <span className="am-form-eyebrow">{t('REVIEW ANSWERS')}</span>
          <h2>{t('Form fields')} <span>({fields.length})</span></h2>
          <p className="am-form-review-meta">
            {filledFields.filter(f => f.confidence === 1.0 && f.reasoning?.includes('already filled')).length} {t('pre-filled')} ·{' '}
            {filledFields.filter(f => f.reasoning?.includes('Matched from persona')).length} {t('profile matched')} ·{' '}
            {filledFields.filter(f => !(f.confidence === 1.0 && f.reasoning?.includes('already filled')) && !f.reasoning?.includes('Matched from persona') && !f.skip).length} {t('AI suggested')}
          </p>
        </div>
        <div className="am-form-review-icon"><FileText size={18} /></div>
      </div>

      <div className="am-form-summary">
        <span><strong>{filledFields.filter(f => f.confidence === 1.0 && f.reasoning?.includes('already filled')).length}</strong> {t('Pre-filled')}</span>
        <span><strong>{filledFields.filter(f => f.reasoning?.includes('Matched from persona')).length}</strong> {t('Profile matched')}</span>
        <span><strong>{filledFields.filter(f => !(f.confidence === 1.0 && f.reasoning?.includes('already filled')) && !f.reasoning?.includes('Matched from persona') && !f.skip).length}</strong> {t('AI suggested')}</span>
      </div>

      <button className="am-form-button primary am-form-apply-all" onClick={handleApplyAll}>
        <WandSparkles size={16} />
        {t('Apply all to form')}
        <ArrowRight size={14} />
      </button>

      <div className="am-form-field-list">
        {filledFields.map(f => {
          const fieldSchema = fields.find(s => s.id === f.fieldId)
          if (f.skip) return null

          const { pct, tone } = confidenceBadge(f.confidence)
          return (
            <div key={f.fieldId} className={`am-form-field-card ${tone}`}>
              <div className="am-form-field-head">
                <span className="am-form-field-label">
                  {fieldSchema?.label ?? f.fieldId}
                  {fieldSchema?.required && <em>*</em>}
                </span>
                <div className="am-form-field-badges">
                  {f.confidence === 1.0 && f.reasoning?.includes('already filled') && f.value?.trim() && (
                    <span className="am-form-badge primary">{t('PRE-FILLED')}</span>
                  )}
                  {f.reasoning?.includes('Matched from persona') && (
                    <span className="am-form-badge teal">{t('PROFILE')}</span>
                  )}
                  <span className={`am-form-badge ${tone}`}>{pct}%</span>
                </div>
              </div>

              <textarea
                value={f.value}
                onChange={e => handleFieldEdit(f.fieldId, e.target.value)}
                rows={2}
                className="am-form-input am-form-textarea"
              />

              {f.reasoning && (
                <div className="am-form-reasoning">
                  <Sparkles size={11} />
                  {f.reasoning}
                </div>
              )}

              {fieldSchema?.type === 'select' && fieldSchema?.options && (
                <div className="am-form-select-wrap">
                  <select
                    value={f.value}
                    onChange={e => handleFieldEdit(f.fieldId, e.target.value)}
                    className="am-form-input am-form-select"
                  >
                    <option value="">-- {t('Select')} --</option>
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

      <div className="am-form-revise">
        <div className="am-form-card-title"><Sparkles size={14} /> {t('Revise with natural language')}</div>
        <div className="am-form-revise-row">
          <input
            type="text"
            value={reviseInstruction}
            onChange={e => setReviseInstruction(e.target.value)}
            placeholder={t('e.g. make answers more concise...')}
            className="am-form-input"
            onKeyDown={e => e.key === 'Enter' && handleRevise()}
          />
          <button
            onClick={handleRevise}
            disabled={revising || !reviseInstruction.trim()}
            className="am-form-button primary small"
          >
            {revising ? t('Working...') : t('Revise')}
          </button>
        </div>
      </div>

      <div className="am-form-next">
        <div>
          <strong>{t('Multi-step form?')}</strong>
          <span>{t('Go to the next page and scan again.')}</span>
        </div>
        <button className="am-form-button ghost" onClick={handleScanPage}>
          <ScanSearch size={13} /> {t('Scan new step')}
        </button>
      </div>
    </div>
  )
}

// ── AI Analysis Progress View ─────────────────────────────────

const PHASE_INFO: Record<AnalysisPhase, { icon: LucideIcon; label: string; subLabel: (n: number) => string; pct: number }> = {
  fetchingPersona:  { icon: UserRound, label: 'Fetching your profile...',      subLabel: () => 'Loading resume, preferences and contact info', pct: 15 },
  preparingPrompt:  { icon: FileText, label: 'Preparing AI prompt...',          subLabel: n => `Formatting ${n} fields for analysis`,          pct: 30 },
  waitingForAI:     { icon: Sparkles, label: 'AI is analyzing your form...',     subLabel: n => `Generating answers for ${n} fields`,         pct: 70 },
  processingResult: { icon: ShieldCheck, label: 'Processing results...',         subLabel: () => 'Parsing and validating AI responses',          pct: 95 },
}

function AnalysisProgressView({ phase, totalFields, aiFieldCount, elapsed }: { phase: AnalysisPhase; totalFields: number; aiFieldCount: number; elapsed: number }) {
  const { t } = useExtensionI18n()
  const info = PHASE_INFO[phase]
  const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
  // Rough estimate: ~3s per AI field (MiniMax M3 average)
  const estSeconds = Math.max(10, Math.min(180, aiFieldCount * 3))
  const estStr = estSeconds < 60 ? `~${estSeconds}s` : `~${Math.round(estSeconds / 60)}min`
  const phases = ['fetchingPersona', 'preparingPrompt', 'waitingForAI', 'processingResult'] as AnalysisPhase[]
  const phaseIndex = phases.indexOf(phase)

  return (
    <div className="am-form-view am-form-analysis">
      <div className="am-form-context">
        <div className="am-form-context-icon"><Sparkles size={16} strokeWidth={2.2} /></div>
        <div className="am-form-context-copy">
            <span className="am-form-eyebrow">{t('APPLICATION FORM')}</span>
            <strong>{t('Preparing your answers')}</strong>
        </div>
        <span className="am-form-context-status active">{t('In progress')}</span>
      </div>

      <div className="am-form-analysis-head">
        <div className="am-form-analysis-icon"><Sparkles size={22} className="am-form-icon-pulse" /></div>
        <span className="am-form-eyebrow">{t('AI ANALYSIS')}</span>
        <h2>{t(info.label)}</h2>
        <p>{t(info.subLabel(aiFieldCount))}</p>
      </div>

      <div className="am-form-progress-wrap">
        <div className="am-form-progress"><span style={{ width: `${info.pct}%` }} /></div>
        <div className="am-form-progress-meta">
          <span>{t('Phase')} {phaseIndex + 1} {t('of')} {phases.length}</span>
          <strong>{info.pct}%</strong>
          <span>{t('Elapsed')} {elapsedStr}</span>
        </div>
      </div>

      <div className="am-form-analysis-card">
        <div className="am-form-card-head">
          <div className="am-form-card-title"><FileText size={14} /> {t('Field summary')}</div>
          <span className="am-form-estimate">{t('Estimated')} {estStr}</span>
        </div>
        <div className="am-form-analysis-stats">
          <span><strong>{totalFields}</strong> {t('fields total')}</span>
          {totalFields - aiFieldCount > 0 && (
            <span className="am-form-badge primary">{totalFields - aiFieldCount} {t('pre-filled')}</span>
          )}
          <span className="am-form-badge neutral">{aiFieldCount} {t('need AI')}</span>
        </div>
        <div className="am-form-phase-list">
          {phases.map((p, index) => {
            const PhaseIcon = PHASE_INFO[p].icon
            const state = index < phaseIndex ? 'done' : index === phaseIndex ? 'current' : ''
            return (
              <div key={p} className={`am-form-phase ${state}`}>
                <span className="am-form-phase-icon">
                  {index < phaseIndex ? <CheckCircle2 size={13} /> : <PhaseIcon size={13} />}
                </span>
                <span>{t(PHASE_INFO[p].label.replace('...', ''))}</span>
                {index === phaseIndex && <span className="am-form-phase-dot" />}
              </div>
            )
          })}
        </div>
      </div>

      <div className="am-form-analysis-tip">
        <ShieldCheck size={13} />
        {phase === 'waitingForAI'
          ? t('AI is considering each field based on your profile. Higher-confidence answers will be marked clearly.')
          : t("Your profile data stays private — it's only used for this form fill.")
        }
      </div>
    </div>
  )
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
    keywords: ['name', 'first name', 'last name', 'full name', 'legal name', 'Name', 'name'],
  })
  if (emailVal) answers.push({
    key: 'email', value: emailVal, confidence: 1.0, source: 'profile',
    keywords: ['email', 'e-mail', 'email address', 'Mail', 'Email'],
  })
  if (phoneVal) answers.push({
    key: 'phone', value: phoneVal, confidence: 1.0, source: 'profile',
    keywords: ['phone', 'phone number', 'mobile', 'cell', 'telephone', 'Telephone', 'cell phone'],
  })
  if (locationVal) answers.push({
    key: 'location', value: locationVal, confidence: 0.95, source: 'profile',
    keywords: ['location', 'city', 'address', 'where are you', 'country', 'region', 'state', 'location', 'address', 'City'],
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
        keywords: [sk.toLowerCase(), 'skills', 'skill', 'technical skills', 'technology', 'Skill'],
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
