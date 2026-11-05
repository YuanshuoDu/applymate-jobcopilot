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
import { saveSettings, normalizeApiBaseUrl } from '@/lib/storage'
import { getPersona, analyzeForm, reviseFormFields, getPersonaFields, savePersonaFields } from '@/lib/api'
import { getCurrentJob } from '@/lib/storage'
import type { ExtensionSettings } from '@/lib/types'
import { useExtensionI18n } from '@/lib/i18n'
import type { FormFieldSchema, FilledField, FormFillResponse } from '@/lib/form-filler/types'
import type { PersonaField } from '@/lib/api'
import { groupFieldIdsByFrame, groupFilledFieldsByFrame } from '@/lib/form-filler/frame-routing'
import { filterSafeFormFields, filterSafeFormRevision, mergeSafeFormAnswers } from '@/lib/form-filler/field-safety'
import { loadSiteAccess, requestSiteAccess, requestFrameInspection, removeBroadSiteAccess, assertActivePage, type SiteAccessSnapshot } from '@/lib/form-filler/site-access'
import { scanAccessibleFrames, messageScannedDocument, type FormScanContext } from '@/lib/form-filler/frame-access'

type ViewState = 'idle' | 'scanning' | 'aiThinking' | 'review' | 'applying' | 'done' | 'error'
type AnalysisPhase = 'fetchingPersona' | 'preparingPrompt' | 'waitingForAI' | 'processingResult'
async function refreshAuthFromDashboard(
  current: ExtensionSettings,
): Promise<ExtensionSettings | null> {
  const expectedOrigin = normalizeApiBaseUrl(current.apiBaseUrl)
  if (!expectedOrigin || !current.userEmail?.trim()) return null
  const tabs = await chrome.tabs.query({})
  const dashboard = tabs.find(tab => {
    if (!tab.id || !tab.url) return false
    try {
      const url = new URL(tab.url)
      return normalizeApiBaseUrl(url.origin) === expectedOrigin
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
  if (!current.userEmail?.trim() || auth.data.user?.email?.trim().toLowerCase() !== current.userEmail.trim().toLowerCase()) return null

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

interface FormFillerProps {
  settings: ExtensionSettings
  pendingFields?: FormFieldSchema[] | null
  onFieldsConsumed?: () => void
  scanTrigger: number
  personaUpdateTrigger?: number
  onPersonaUpdated?: () => void
}

export function FormFillerView(props: FormFillerProps) {
  // Account changes destroy the old scan and its in-flight callbacks; rotating
  // a token for the same account preserves the user's reviewed answers.
  const account = `${normalizeApiBaseUrl(props.settings.apiBaseUrl) ?? ''}|${props.settings.userEmail?.trim().toLowerCase() ?? ''}`
  return <FormFillerSession key={account} {...props} />
}

function FormFillerSession({ settings, pendingFields, onFieldsConsumed, scanTrigger, onPersonaUpdated }: FormFillerProps) {
  const { lang, t } = useExtensionI18n()
  const [viewState, setViewState] = useState<ViewState>('idle')
  const [fields, setFields] = useState<FormFieldSchema[]>([])
  const [filledFields, setFilledFields] = useState<FilledField[]>([])
  const [errorMsg, setErrorMsg] = useState('')
  const [siteAccess, setSiteAccess] = useState<SiteAccessSnapshot | null>(null)
  const [requestingAccess, setRequestingAccess] = useState(false)
  const [accessMessage, setAccessMessage] = useState('')
  const [scanNotice, setScanNotice] = useState('')
  const accessRef = useRef<SiteAccessSnapshot | null>(null)
  const accessVersionRef = useRef(0)
  const activeTabRef = useRef<{ id: number; windowId?: number } | null>(null)
  const scanContextRef = useRef<FormScanContext | null>(null)
  const scanGenerationRef = useRef(0)
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

  const refreshSiteAccess = useCallback(async (): Promise<SiteAccessSnapshot | null> => {
    const version = ++accessVersionRef.current
    accessRef.current = null
    setSiteAccess(null)
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (tab?.id === undefined) throw new Error('Open a company application page first.')
      activeTabRef.current = { id: tab.id, windowId: tab.windowId }
      const snapshot = await loadSiteAccess(tab)
      await assertActivePage(snapshot)
      if (version !== accessVersionRef.current) return null
      accessRef.current = snapshot
      setSiteAccess(snapshot)
      return snapshot
    } catch (error) {
      if (version === accessVersionRef.current) setAccessMessage(error instanceof Error ? error.message : 'Site access could not be checked.')
      return null
    }
  }, [])

  const invalidateScan = useCallback(() => {
    scanGenerationRef.current += 1
    scanContextRef.current = null
    setFields([])
    setFilledFields([])
    setViewState('idle')
    setErrorMsg('')
    setScanNotice('')
    setPersonaMatches([])
    setUploadedFiles({})
  }, [])

  useEffect(() => {
    const changed = () => {
      accessVersionRef.current += 1
      accessRef.current = null
      setSiteAccess(null)
      invalidateScan()
      void refreshSiteAccess()
    }
    const activated = (info: chrome.tabs.TabActiveInfo) => {
      if (activeTabRef.current?.windowId !== undefined && info.windowId !== activeTabRef.current.windowId) return
      changed()
    }
    const updated = (tabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (tabId === activeTabRef.current?.id && (info.url || info.status === 'loading')) changed()
    }
    chrome.tabs.onActivated.addListener(activated)
    chrome.tabs.onUpdated.addListener(updated)
    chrome.permissions.onAdded.addListener(changed)
    chrome.permissions.onRemoved.addListener(changed)
    void refreshSiteAccess()
    return () => {
      accessVersionRef.current += 1
      accessRef.current = null
      scanGenerationRef.current += 1
      scanContextRef.current = null
      chrome.tabs.onActivated.removeListener(activated)
      chrome.tabs.onUpdated.removeListener(updated)
      chrome.permissions.onAdded.removeListener(changed)
      chrome.permissions.onRemoved.removeListener(changed)
    }
  }, [invalidateScan, refreshSiteAccess])

  const handleAccessChange = useCallback((kind: 'site' | 'frames' | 'removeBroad', origin?: string) => {
    const snapshot = siteAccess
    if (!snapshot) return
    try {
      // Request synchronously in this click turn, before any promise or tab lookup.
      const request = kind === 'site'
        ? requestSiteAccess(snapshot, origin ?? '', accessRef.current)
        : kind === 'frames' ? requestFrameInspection(snapshot, accessRef.current)
          : removeBroadSiteAccess(snapshot, accessRef.current)
      setRequestingAccess(true)
      void request.then(async granted => {
        invalidateScan()
        setAccessMessage(granted
          ? kind === 'removeBroad' ? 'Previous all-sites access removed. Built-in supported sites remain available; other sites need their own grant.' : 'Site access updated. Scan again to use the selected sites.'
          : 'Permission was not granted. You can still scan sites that already have access.')
        await refreshSiteAccess()
      }).catch(error => setAccessMessage(error instanceof Error ? error.message : 'Permission could not be changed.'))
        .finally(() => setRequestingAccess(false))
    } catch (error) {
      setAccessMessage(error instanceof Error ? error.message : 'Refresh site access and try again.')
    }
  }, [siteAccess, invalidateScan, refreshSiteAccess])

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
    const generation = scanGenerationRef.current
    try {
      const values = filledFields
        .filter(f => !f.skip && f.personaRelevant && f.value.trim())
        .map(f => ({ fieldId: f.fieldId, value: f.value }))
      const matches = await computePersonaMatches(values)
      if (generation !== scanGenerationRef.current) return
      setPersonaMatches(matches)
    } catch { /* ignore */ }
  }

  /** Refresh: read current DOM values from the page, re-compare with persona */
  async function handleRefreshPersona() {
    const generation = scanGenerationRef.current
    setSavingPersona(true)
    try {
      const context = scanContextRef.current
      if (!context) throw new Error('Scan the current page before reading its answers.')

      const fieldIds = filledFields.filter(f => !f.skip).map(f => f.fieldId)
      const grouped = groupFieldIdsByFrame(fieldIds, fields)
      const responses = await Promise.all([...grouped.entries()].map(async ([frameId, ids]) => {
        try {
          return await messageScannedDocument<{ type?: string; values?: Array<{ fieldId: string; value: string }> }>(context, frameId,
            { type: 'READ_FIELD_VALUES', fieldIds: ids }, () => scanContextRef.current === context)
        } catch { return undefined }
      }))
      const values = responses.flatMap(response => response?.type === 'FIELD_VALUES_RESULT' ? response.values ?? [] : [])
      if (values.length === 0) return
      if (generation !== scanGenerationRef.current) return

      const matches = await computePersonaMatches(values)
      if (generation !== scanGenerationRef.current) return
      setPersonaMatches(matches)
    } catch (error) { setErrorMsg(error instanceof Error ? error.message : 'Scan the current page again.') }
    finally { setSavingPersona(false) }
  }

  async function handleSavePersonaMatches() {
    const generation = scanGenerationRef.current
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
      if (generation !== scanGenerationRef.current) return
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
    invalidateScan()
    void refreshSiteAccess()
  }, [scanTrigger, invalidateScan, refreshSiteAccess])

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
      // Legacy messages do not identify the document whose answers would be filled.
      // A fresh explicit scan establishes that document binding before any AI use.
      invalidateScan()
      setAccessMessage('Click Scan current page to review fields from the current application page.')
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
    const generation = scanGenerationRef.current
    const activeSettings = overrideSettings ?? settings
    try {
      formFields = filterSafeFormFields(formFields)
      setFields(formFields)
      if (formFields.length === 0) throw new Error('No supported application fields found. Passwords and other sensitive fields are excluded.')
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
        if (generation !== scanGenerationRef.current) return
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
      if (generation !== scanGenerationRef.current) return

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
        if (generation !== scanGenerationRef.current) return
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
      for (const f of mergeSafeFormAnswers(needsAi, [], result.fields)) fieldMap.set(f.fieldId, f)
      const merged = formFields.map(f => fieldMap.get(f.id)!).filter(Boolean)
      setFilledFields(merged)
      setViewState('review')
      notifyContentScript(true)
    } catch (e) {
      if (generation !== scanGenerationRef.current) return
      const message = e instanceof Error ? e.message : String(e)
      if (allowAuthRefresh && /unauthorized|401/i.test(message)) {
        const refreshed = await refreshAuthFromDashboard(activeSettings).catch(() => null)
        if (generation !== scanGenerationRef.current) return
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
    const generation = scanGenerationRef.current
    try {
      const safeRevision = filterSafeFormRevision(fields, filledFields)
      if (safeRevision.fields.length === 0) throw new Error('No supported application fields to revise.')
      const { persona } = await getPersona(settings, 'form_fill')
      if (generation !== scanGenerationRef.current) return
      const result = await reviseFormFields(settings, {
        ...safeRevision,
        persona,
        instruction: reviseInstruction.trim(),
      })
      if (generation !== scanGenerationRef.current) return
      setFilledFields(mergeSafeFormAnswers(safeRevision.fields, safeRevision.previousFill, result.fields))
      setReviseInstruction('')
    } catch (e) {
      if (generation !== scanGenerationRef.current) return
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
      const context = scanContextRef.current
      if (!context) throw new Error('Scan the current page before filling answers.')
      const groups = groupFilledFieldsByFrame(filledFields, fields)
      const responses = await Promise.all(groups.map(async group => {
        try {
          const response = await messageScannedDocument<{ type?: string; failed?: string[] }>(context, group.frameId, {
            type: 'APPLY_FIELD_VALUES', fields: group.fields, schemas: group.schemas,
          }, () => scanContextRef.current === context)
          if (response?.type === 'APPLY_RESULT') return response
        } catch { /* Keep successful frames usable; a navigated or blocked frame needs a new scan. */ }
        return { failed: group.fields.filter(field => !field.skip).map(field => field.fieldId) }
      }))
      if (scanContextRef.current !== context) return
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
    try {
      const context = scanContextRef.current
      if (!context) throw new Error('Scan the current page before choosing an upload.')
      const frameId = fields.find(field => field.id === fieldId)?.frameId ?? 0
      const response = await messageScannedDocument<{ success?: boolean; error?: string }>(context, frameId,
        { type: 'OPEN_UPLOAD_PICKER', fieldId }, () => scanContextRef.current === context)
      if (!response?.success) setErrorMsg(response?.error ?? 'Could not open the file picker.')
    } catch (error) { setErrorMsg(error instanceof Error ? error.message : 'Scan the current page again.') }
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
    const requestedPage = accessRef.current
    if (!requestedPage) {
      setAccessMessage('Checking the active site. Click Scan current page again once the site is shown.')
      await refreshSiteAccess()
      return
    }
    if (!requestedPage.frames.some(frame => frame.origin && frame.granted)) {
      setAccessMessage('Allow the current site or the embedded site hosting your form below, then click Scan current page.')
      return
    }
    invalidateScan()
    const generation = scanGenerationRef.current
    setViewState('scanning')
    try {
      await assertActivePage(requestedPage)
      const snapshot = await refreshSiteAccess()
      if (generation !== scanGenerationRef.current) return
      if (!snapshot) throw new Error('Site access changed. Check the active page and try again.')
      if (snapshot.tabId !== requestedPage.tabId || snapshot.tabUrl !== requestedPage.tabUrl) throw new Error('The active page changed. Scan the page you want to fill.')
      const result = await scanAccessibleFrames(snapshot)
      if (generation !== scanGenerationRef.current) return
      scanContextRef.current = result.context
      const notices = [
        !snapshot.frameInspection ? 'Only the main page was inspected. Use Find embedded application frames if the form is inside another page.' : '',
        snapshot.warning ?? '',
        result.skippedFrames ? `${result.skippedFrames} page(s) have no site access or cannot be scanned. Only allow listed sites that host your application form.` : '',
        result.failedFrames ? `${result.failedFrames} page(s) changed or could not be scanned. Refresh site access and scan again for those fields.` : '',
      ].filter(Boolean)
      setScanNotice(notices.join(' '))
      if (!result.fields.length) throw new Error('No supported application fields were found in the pages you allowed. If this is an embedded form, find its site below, grant access, then scan again.')
      setFields(result.fields)
      await analyzeFields(result.fields)
    } catch (error) {
      if (generation !== scanGenerationRef.current) return
      setErrorMsg(error instanceof Error ? error.message : 'Could not scan the current application page.')
      setViewState('error')
    }
  }, [refreshSiteAccess, invalidateScan, analyzeFields])

  const confidenceBadge = (conf: number) => {
    const pct = Math.round(conf * 100)
    const tone = pct >= 80 ? 'high' : pct >= 50 ? 'medium' : 'low'
    return { pct, tone }
  }

  const mainSite = siteAccess?.frames.find(frame => frame.frameId === 0)
  const hasSiteAccess = siteAccess?.frames.some(frame => frame.origin && frame.granted) ?? false
  const embeddedSites = [...new Set(siteAccess?.frames.filter(frame => frame.frameId !== 0 && frame.origin !== mainSite?.origin).map(frame => frame.origin).filter((origin): origin is string => !!origin) ?? [])]
  const changingAccess = requestingAccess || viewState === 'scanning' || viewState === 'aiThinking' || viewState === 'applying'
  const accessControls = (
    <div className="am-form-card">
      <div className="am-form-card-title"><ShieldCheck size={14} /> Site access</div>
      {mainSite?.origin ? (
        <div className="am-form-access-card">
          <div style={{ minWidth: 0 }}>
            <strong style={{ overflowWrap: 'anywhere' }}>{mainSite.origin.slice(0, -2)}</strong>
            <span>{mainSite.granted ? 'Current site allowed' : 'Allow this site to scan its application fields.'}</span>
          </div>
          {!mainSite.granted && <button className="am-form-button ghost small" disabled={changingAccess} onClick={() => handleAccessChange('site', mainSite.origin!)}>Allow this site</button>}
        </div>
      ) : <p>Checking the active page… Open an HTTP or HTTPS application page to continue.</p>}
      {siteAccess && !siteAccess.frameInspection && (
        <>
          <p>Scanning currently covers the main page. If the form is embedded, you can let ApplyMate inspect this tab’s embedded page addresses and choose their sites below. These addresses stay local.</p>
          <button className="am-form-button ghost small" disabled={changingAccess} onClick={() => handleAccessChange('frames')}>Find embedded application frames</button>
        </>
      )}
      {siteAccess?.frameInspection && (
        <>
          <p>Embedded sites on this page are listed below. Allow only the site hosting your application form; other embedded content can stay blocked. An address alone does not identify a form.</p>
          {embeddedSites.length === 0 && <p>No additional HTTP or HTTPS sites were found.</p>}
          {embeddedSites.map(origin => {
            const granted = siteAccess.frames.some(frame => frame.origin === origin && frame.granted)
            return <div className="am-form-access-card" key={origin}>
              <div style={{ minWidth: 0 }}><strong style={{ overflowWrap: 'anywhere' }}>{origin.slice(0, -2)}</strong><span>{granted ? 'Allowed' : 'Not scanned until you allow this site'}</span></div>
              {!granted && <button className="am-form-button ghost small" disabled={changingAccess} onClick={() => handleAccessChange('site', origin)}>Allow this site</button>}
            </div>
          })}
          <p>Restricted, sandboxed, blank, and unsupported embedded pages may still need manual entry. Refresh this list after an embedded page navigates.</p>
        </>
      )}
      {siteAccess?.warning && <p role="status">{siteAccess.warning}</p>}
      {!!siteAccess?.broadOrigins.length && <div className="am-form-callout warning">
        <strong>Previous all-sites permission is still enabled</strong>
        <p>An earlier version was granted broad website access. Remove it to use individual site grants. Built-in supported sites remain available.</p>
        <button className="am-form-button ghost small" disabled={changingAccess} onClick={() => handleAccessChange('removeBroad')}>Remove previous all-sites access</button>
      </div>}
      {accessMessage && <p role="status">{accessMessage}</p>}
      <button className="am-form-button ghost small" disabled={changingAccess} onClick={() => { invalidateScan(); void refreshSiteAccess() }}><RefreshCw size={12} /> Refresh site access</button>
    </div>
  )
  const coverageNotice = scanNotice && <div className="am-form-callout warning" role="status"><p>{scanNotice}</p></div>

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
          <button className="am-form-button primary" onClick={handleScanPage} disabled={scanning || requestingAccess || !hasSiteAccess}>
            <ScanSearch size={15} />
            {scanning ? t('Scanning page') : t('Scan current page')}
            {!scanning && <ArrowRight size={14} />}
          </button>
          <span className="am-form-helper">
            {t('Works with company career sites, Greenhouse, Lever, Workday, and more.')}{' '}
            {t('When you scan, ApplyMate reads supported field labels and existing values on this page.')}{' '}
            {t('Relevant form and profile data is sent to ApplyMate and the configured AI provider when needed to prepare or revise suggestions.')}{' '}
            {t('This can include location, salary expectations, and health or disability details you choose to provide.')}{' '}
            {t('Review everything before filling; it never submits the application.')}{' '}
            <a href="https://applymate.site/privacy" target="_blank" rel="noreferrer">{t('Privacy & data use')}</a>
          </span>
        </div>

        {accessControls}

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
          <p>{errorMsg}</p>
          <div className="am-form-actions">
            <button className="am-form-button primary" disabled={requestingAccess || !hasSiteAccess} onClick={handleScanPage}>
              <RefreshCw size={14} />
              {t('Retry')}
            </button>
          </div>
        </div>
        {coverageNotice}
        {accessControls}
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
        <div className="am-form-progress" aria-label={t(`Filled ${appliedCount} of ${fillableCount} fields`)}>
          <span style={{ width: `${progress}%` }} />
        </div>
        <div className="am-form-progress-meta">
          <strong>{appliedCount} / {fillableCount} {t('fields')}</strong>
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

        {coverageNotice}

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
        {accessControls}
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

      {coverageNotice}

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
      {accessControls}
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
