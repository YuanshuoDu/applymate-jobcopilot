'use client'
import { isApplicationPdfUnsupportedCharactersError } from '@/lib/application-pdf-errors'
import React, { useState, useEffect, useRef } from 'react'
import { useSession } from 'next-auth/react'
import { Btn, useToast, useConfirm } from '@/components/ui'
import { apiMutate } from '@/lib/hooks'
import { useI18n } from '@/lib/i18n'
import type { CoverLetter, Job, ResumeContent, TemplateOptions } from '@/lib/types'

interface Props {
  job:           Job
  resumeId?:     string
  resumeContent: ResumeContent | null
  resumeName:    string
  templateId:    string
  templateName?: string
  templateOptions: TemplateOptions
  onClose:       () => void
  onSaved?:      (cl: CoverLetter) => void
}

const TONES = ['professional', 'enthusiastic', 'concise'] as const
type Tone = typeof TONES[number]
const LANGUAGES = ['en', 'de', 'fr', 'nl', 'es'] as const
type CoverLetterLanguage = typeof LANGUAGES[number]

type AutosaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error'
type MemoryDraft = { content: string; tone: Tone; revision: number; blocked: boolean; pending: boolean }
const memoryDrafts = new Map<string, MemoryDraft>()
const memoryGenerated = new Map<string, string>()
const uncertainWrites = new Set<string>()
const inFlightWrites = new Set<string>()
const inFlightGenerations = new Set<string>()
const inFlightDeletes = new Set<string>()
const writeListeners = new Set<() => void>()
const deleteListeners = new Set<(jobKey: string) => void>()
let unloadRegistered = false
function warnUnsaved(event: BeforeUnloadEvent) { event.preventDefault(); event.returnValue = '' }
function syncUnloadWarning() {
  if (typeof window === 'undefined') return
  const needed = memoryDrafts.size > 0 || memoryGenerated.size > 0
  if (needed && !unloadRegistered) { window.addEventListener('beforeunload', warnUnsaved); unloadRegistered = true }
  if (!needed && unloadRegistered) { window.removeEventListener('beforeunload', warnUnsaved); unloadRegistered = false }
}

export function CoverLetterPanel({ job, resumeId, resumeContent, resumeName, templateId, templateName, templateOptions, onClose, onSaved }: Props) {
  const { t } = useI18n()
  const { data: session } = useSession()
  const owner = session?.user?.id ?? ''
  const scope = JSON.stringify([owner, job.userId, job.id, job.finalCoverLetterId])
  const draftKey = (id: string | null) => JSON.stringify([owner, job.id, id])
  const generatedKey = JSON.stringify([owner, job.id])
  const generatedKeyRef = useRef(generatedKey)
  generatedKeyRef.current = generatedKey
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const generationRef = useRef(0)
  const closingEpochRef = useRef(0)
  const hasLoadedScopeRef = useRef(false)
  const toast = useToast()
  const [confirm, ConfirmDialog] = useConfirm()

  const [coverLetters, setCoverLetters]   = useState<CoverLetter[]>([])
  const [activeId,     setActiveId]       = useState<string | null>(null)
  const [localContent, setLocalContent]   = useState('')
  const [localTone,    setLocalTone]      = useState<Tone>('professional')
  const [localLanguage, setLocalLanguage] = useState<CoverLetterLanguage>('en')
  const [loading,      setLoading]        = useState(true)
  const [autosaveStatus, setAutosaveStatus] = useState<AutosaveStatus>('idle')
  const [generating,   setGenerating]     = useState(false)
  const [downloading,  setDownloading]    = useState(false)
  const [previewing,   setPreviewing]     = useState(false)
  const [visible,      setVisible]        = useState(false)
  const [hydrated,     setHydrated]       = useState(false)
  const [loadedScope, setLoadedScope] = useState('')
  const [loadFailed, setLoadFailed] = useState(false)
  const [failedScope, setFailedScope] = useState('')
  const [reload, setReload] = useState(0)
  const [switching, setSwitching] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const deletingRef = useRef(false)
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const [unsavedGeneration, setUnsavedGeneration] = useState('')
  const [unavailableDraft, setUnavailableDraft] = useState<{ scope: string; content: string } | null>(null)
  const retainedVersionRef = useRef<{ scope: string; id: string } | null>(null)
  const [, refreshWriteStatus] = useState(0)
  useEffect(() => {
    const listener = () => {
      refreshWriteStatus(value => value + 1)
      if (!inFlightGenerations.has(generatedKeyRef.current)) setUnsavedGeneration(memoryGenerated.get(generatedKeyRef.current) ?? '')
    }
    writeListeners.add(listener)
    return () => { writeListeners.delete(listener) }
  }, [])
  useEffect(() => {
    const listener = (jobKey: string) => { if (generatedKeyRef.current === jobKey) setReload(value => value + 1) }
    deleteListeners.add(listener)
    return () => { deleteListeners.delete(listener) }
  }, [])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftRef = useRef({ activeId: null as string | null, content: '', tone: 'professional' as Tone })
  const draftRevisionRef = useRef(0)
  const pdfContext = JSON.stringify([scope, activeId, job.company, job.role, resumeName, resumeContent, templateId, templateOptions])
  const pdfContextRef = useRef(pdfContext)
  const pdfContextEpoch = useRef(0)
  if (pdfContextRef.current !== pdfContext) { pdfContextRef.current = pdfContext; pdfContextEpoch.current += 1 }
  const dirtyDraftRef = useRef(false)
  const savePromiseRef = useRef<Promise<boolean> | null>(null)
  const saveBlockedRef = useRef(false)
  const skipAutoSaveRef = useRef(false)

  // Animate in on mount
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 20)
    return () => clearTimeout(t)
  }, [])

  // Load cover letters on mount
  useEffect(() => {
    let current = true
    if (hasLoadedScopeRef.current) setVisible(true)
    hasLoadedScopeRef.current = true
    generationRef.current += 1
    const requestScope = scope
    const retainedId = retainedVersionRef.current?.scope === requestScope ? retainedVersionRef.current.id : null
    if (retainedVersionRef.current?.scope !== requestScope) retainedVersionRef.current = null
    const showUnavailable = () => {
      const savedDraft = retainedId ? memoryDrafts.get(draftKey(retainedId)) : undefined
      setUnavailableDraft(savedDraft ? { scope: requestScope, content: savedDraft.content } : null)
      setUnsavedGeneration(memoryGenerated.get(generatedKey) ?? '')
      setLoading(false)
      setLoadFailed(true)
      setFailedScope(requestScope)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort(); if (current && scopeRef.current === requestScope) showUnavailable() }, 15_000)
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
    autoSaveTimer.current = null
    setHydrated(false)
    setLoadedScope('')
    setLoadFailed(false)
    setFailedScope('')
    setUnavailableDraft(null)
    setAutosaveStatus('idle')
    dirtyDraftRef.current = false
    skipAutoSaveRef.current = true
    savePromiseRef.current = null
    saveBlockedRef.current = false
    setGenerating(false)
    deletingRef.current = false
    setDeleting(false)
    setDownloading(false)
    setSwitching(false)
    setUnsavedGeneration('')
    setPreviewing(false)
    setLoading(true)
    setCoverLetters([])
    setActiveId(null)
    draftRef.current = { activeId: null, content: '', tone: 'professional' }
    if (!owner || owner !== job.userId) { clearTimeout(timer); setLoading(false); setLoadFailed(true); setFailedScope(requestScope); return () => { current = false; generationRef.current += 1; controller.abort() } }
    fetch(`/api/jobs/${job.id}/cover-letters`, { signal: controller.signal, cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error('Unavailable'); return r.json() })
      .then((data: unknown) => {
        if (!current || controller.signal.aborted || scopeRef.current !== requestScope) return
        if (!Array.isArray(data) || data.some(cl => !cl || typeof cl.id !== 'string' || cl.userId !== owner || cl.jobId !== job.id || typeof cl.content !== 'string') || new Set(data.map(cl => cl.id)).size !== data.length) throw new Error('Unavailable')
        const list: CoverLetter[] = data
        if (job.finalCoverLetterId && !list.some(cl => cl.id === job.finalCoverLetterId)) throw new Error('Unavailable')
        if (retainedId && !list.some(cl => cl.id === retainedId) && memoryDrafts.has(draftKey(retainedId))) throw new Error('Unavailable')
        setCoverLetters(list)
        // A same-scope refresh keeps the version the user was editing.
        const initialId = (retainedId && list.some(cl => cl.id === retainedId) ? retainedId : null) ?? job.finalCoverLetterId ?? list[0]?.id ?? null
        retainedVersionRef.current = initialId ? { scope: requestScope, id: initialId } : null
        setActiveId(initialId)
        setUnsavedGeneration(memoryGenerated.get(generatedKey) ?? '')
        if (initialId) {
          const cl = list.find(c => c.id === initialId)
          if (cl) {
            const savedDraft = memoryDrafts.get(draftKey(cl.id))
            const content = savedDraft?.content ?? cl.content
            const tone = savedDraft?.tone ?? (cl.tone as Tone) ?? 'professional'
            setLocalContent(content)
            setLocalTone(tone)
            draftRef.current = { activeId: cl.id, content, tone }
            if (savedDraft) { dirtyDraftRef.current = true; draftRevisionRef.current = savedDraft.revision; saveBlockedRef.current = true; setAutosaveStatus('error') }
            else if (uncertainWrites.has(draftKey(cl.id))) { saveBlockedRef.current = true; setAutosaveStatus('error') }
          }
        } else {
          setLocalContent('')
          setLocalTone('professional')
          draftRef.current = { activeId: null, content: '', tone: 'professional' }
        }
        setLoadedScope(requestScope)
        setHydrated(true)
      })
      .catch(() => {
        if (!current || scopeRef.current !== requestScope) return
        setCoverLetters([])
        setActiveId(null)
        setLocalContent('')
        setLocalTone('professional')
        draftRef.current = { activeId: null, content: '', tone: 'professional' }
        showUnavailable()
      })
      .finally(() => {
        if (!current || scopeRef.current !== requestScope || controller.signal.aborted) return
        clearTimeout(timer)
        setLoading(false)
      })
    return () => { current = false; generationRef.current += 1; clearTimeout(timer); controller.abort() }
  }, [scope, reload])

  // Auto-grow textarea
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }, [localContent])

  const usable = loadedScope === scope && !loading && !loadFailed && Boolean(owner && owner === job.userId)
  const generationBusy = inFlightGenerations.has(generatedKey)
  const deletionBusy = Boolean(activeId && inFlightDeletes.has(draftKey(activeId)))
  const activeRecord = usable ? coverLetters.find(cl => cl.id === activeId) ?? null : null
  const activeCL = activeRecord ? { ...activeRecord, content: localContent, tone: localTone } : null

  // Version dropdown label: newest = highest index, labeled vN down to v1
  const total = coverLetters.length
  function versionLabel(cl: CoverLetter, idx: number) {
    return `v${total - idx} · ${cl.tone} · ${new Date(cl.createdAt).toLocaleDateString()}`
  }

  async function persistDraft(): Promise<boolean> {
    if (!usable || scopeRef.current !== scope || saveBlockedRef.current) return false
    const requestScope = scope
    const generation = generationRef.current
    if (savePromiseRef.current) {
      const success = await savePromiseRef.current
      if (!success || generationRef.current !== generation || scopeRef.current !== requestScope) return false
      return dirtyDraftRef.current ? persistDraft() : true
    }
    const draft = draftRef.current
    if (!draft.activeId || !dirtyDraftRef.current) return true

    const revision = draftRevisionRef.current
    const id = draft.activeId
    const key = draftKey(id)
    const savedEntry = memoryDrafts.get(key)
    if (savedEntry) { savedEntry.pending = true; syncUnloadWarning() }
    setAutosaveStatus('saving')
    const promise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      inFlightWrites.add(key)
      const write = apiMutate<CoverLetter>(`/api/cover-letters/${id}`, 'PATCH', { content: draft.content, tone: draft.tone }).finally(() => {
        inFlightWrites.delete(key)
        writeListeners.forEach(listener => listener())
      })
      const result = await Promise.race([
        write,
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 15_000) }),
      ])
      if (timer) clearTimeout(timer)
      const valid = Boolean(result?.data && result.data.id === id && result.data.userId === owner && result.data.jobId === job.id && result.data.content === draft.content && result.data.tone === draft.tone)
      const memory = memoryDrafts.get(key)
      if (memory) {
        memory.pending = inFlightWrites.has(key)
        if (valid && memory.revision === revision) memoryDrafts.delete(key)
        else if (!valid || generationRef.current !== generation || scopeRef.current !== requestScope) memory.blocked = true
        syncUnloadWarning()
      }
      if (!valid) { uncertainWrites.add(key); writeListeners.forEach(listener => listener()) }
      if (scopeRef.current !== requestScope || generationRef.current !== generation) return false
      if (!valid || !result?.data) {
        saveBlockedRef.current = true
        setAutosaveStatus('error')
        toast.error(t('coverLetter.panel.autosaveFailed'), t('resume.correctionChangedDetail'))
        return false
      }
      const saved = result.data
      setCoverLetters(previous => previous.map(letter => letter.id === id ? saved : letter))
      onSaved?.(saved)
      if (draftRevisionRef.current === revision && draftRef.current.activeId === id) {
        dirtyDraftRef.current = false
        setAutosaveStatus('saved')
      }
      return true
    })()
    savePromiseRef.current = promise
    const success = await promise
    if (generationRef.current === generation && savePromiseRef.current === promise) savePromiseRef.current = null
    if (!success || generationRef.current !== generation || scopeRef.current !== requestScope) return false
    return dirtyDraftRef.current ? persistDraft() : true
  }

  useEffect(() => {
    draftRef.current = { activeId, content: localContent, tone: localTone }
  }, [activeId, localContent, localTone])

  useEffect(() => {
    if (!hydrated || !activeId || !usable) return
    if (skipAutoSaveRef.current) {
      skipAutoSaveRef.current = false
      return
    }

    dirtyDraftRef.current = true
    if (saveBlockedRef.current) { setAutosaveStatus('error'); return }
    setAutosaveStatus('pending')
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
    autoSaveTimer.current = setTimeout(() => {
      autoSaveTimer.current = null
      void persistDraft()
    }, 900)

    return () => {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
    }
  }, [activeId, hydrated, localContent, localTone, usable])

  function editDraft(content: string, tone: Tone) {
    if (!usable || deletingRef.current || (activeId && inFlightDeletes.has(draftKey(activeId))) || inFlightGenerations.has(generatedKey)) return
    if (!activeId) { setLocalContent(content); setLocalTone(tone); return }
    if (uncertainWrites.has(draftKey(activeId)) && !memoryDrafts.has(draftKey(activeId))) return
    draftRevisionRef.current += 1
    dirtyDraftRef.current = true
    draftRef.current = { activeId, content, tone }
    memoryDrafts.set(draftKey(activeId), { content, tone, revision: draftRevisionRef.current, blocked: saveBlockedRef.current, pending: Boolean(savePromiseRef.current) })
    syncUnloadWarning()
    setLocalContent(content)
    setLocalTone(tone)
  }

  async function handleVersionChange(id: string) {
    if (!usable || deletingRef.current || (activeId && inFlightDeletes.has(draftKey(activeId))) || inFlightGenerations.has(generatedKey)) return
    const cl = coverLetters.find(c => c.id === id)
    if (!cl) return
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
    autoSaveTimer.current = null
    setSwitching(true)
    if (dirtyDraftRef.current && !await persistDraft()) { setSwitching(false); return }
    if (scopeRef.current !== scope) return
    setSwitching(false)
    draftRevisionRef.current += 1
    dirtyDraftRef.current = false
    skipAutoSaveRef.current = true
    setAutosaveStatus('idle')
    const savedDraft = memoryDrafts.get(draftKey(id))
    saveBlockedRef.current = Boolean(savedDraft) || uncertainWrites.has(draftKey(id))
    if (savedDraft) { dirtyDraftRef.current = true; draftRevisionRef.current = savedDraft.revision; setAutosaveStatus('error') }
    else if (saveBlockedRef.current) setAutosaveStatus('error')
    setActiveId(id)
    retainedVersionRef.current = { scope, id }
    setLocalContent(savedDraft?.content ?? cl.content)
    setLocalTone(savedDraft?.tone ?? (cl.tone as Tone) ?? 'professional')
  }

  async function handleDelete() {
    if (!usable || !activeId || deletingRef.current || inFlightDeletes.has(draftKey(activeId)) || inFlightGenerations.has(generatedKey)) return
    const requestScope = scope
    const generation = generationRef.current
    const id = activeId
    const key = draftKey(id)
    let requestStarted = false
    let outcomeUnknown = false
    deletingRef.current = true
    setDeleting(true)
    try {
      if (dirtyDraftRef.current && !await persistDraft()) return
      const revision = draftRevisionRef.current
      const current = () => scopeRef.current === requestScope && generationRef.current === generation && activeIdRef.current === id && draftRevisionRef.current === revision
      if (!current()) return
      const ok = await confirm({ title: 'Delete cover letter?', message: t('coverLetter.panel.deleteConfirm'), danger: true, confirmLabel: t('coverLetter.panel.delete') })
      if (!ok || !current()) return
      if (inFlightDeletes.has(key)) return
      inFlightDeletes.add(key)
      requestStarted = true
      writeListeners.forEach(listener => listener())
      const { error } = await apiMutate(`/api/cover-letters/${id}`, 'DELETE')
      outcomeUnknown = Boolean(error)
      if (!current()) return
      if (error) { toast.error('Delete failed', error); return }
      const idx = coverLetters.findIndex(c => c.id === id)
      const next = coverLetters.filter(c => c.id !== id)
      skipAutoSaveRef.current = true
      draftRevisionRef.current += 1
      dirtyDraftRef.current = false
      setAutosaveStatus('idle')
      setCoverLetters(next)
      const deletedSelected = id === job.finalCoverLetterId
      const nextActive = deletedSelected ? null : next[Math.max(0, idx - 1)]?.id ?? null
      if (deletedSelected) { setLoadFailed(true); setFailedScope(scope); setLoadedScope('') }
      setActiveId(nextActive)
      if (nextActive) {
        const cl = next.find(c => c.id === nextActive)
        if (cl) { setLocalContent(cl.content); setLocalTone((cl.tone as Tone) ?? 'professional') }
      } else {
        setLocalContent(''); setLocalTone('professional')
        draftRef.current = { activeId: null, content: '', tone: 'professional' }
      }
      toast.info('Deleted', 'Cover letter version removed')
    } finally {
      if (requestStarted) {
        if (outcomeUnknown) uncertainWrites.add(key)
        inFlightDeletes.delete(key)
        writeListeners.forEach(listener => listener())
        deleteListeners.forEach(listener => listener(generatedKey))
      }
      if (scopeRef.current === requestScope && generationRef.current === generation) { deletingRef.current = false; setDeleting(false) }
    }
  }

  async function handleGenerate() {
    if (!usable || deletingRef.current || (activeId && inFlightDeletes.has(draftKey(activeId))) || inFlightGenerations.has(generatedKey) || memoryGenerated.has(generatedKey)) return
    const requestScope = scope
    const generation = generationRef.current
    const closingEpoch = closingEpochRef.current
    const generationKey = generatedKey
    inFlightGenerations.add(generationKey)
    writeListeners.forEach(listener => listener())
    try {
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
    autoSaveTimer.current = null
    setSwitching(true)
    if (dirtyDraftRef.current && !await persistDraft()) { setSwitching(false); return }
    if (scopeRef.current !== requestScope || generationRef.current !== generation || closingEpochRef.current !== closingEpoch) return
    setSwitching(false)
    setGenerating(true)
    let generated = ''
    if (resumeContent) {
      // Use legacy route that works without a saved resumeId
      const { data, error } = await apiMutate<{ coverLetter: string }>('/api/ai/cover-letter', 'POST', {
        resumeContent,
        jobTitle:       job.role,
        jobCompany:     job.company,
        jobDescription: job.description ?? undefined,
        tone:           localTone,
        language:       localLanguage,
      })
      if (data?.coverLetter) { memoryGenerated.set(generationKey, data.coverLetter); syncUnloadWarning() }
      if (scopeRef.current !== requestScope || generationRef.current !== generation || closingEpochRef.current !== closingEpoch) return
      if (!data?.coverLetter) {
        setGenerating(false)
        toast.error('Generation failed', error ?? 'Check ANTHROPIC_API_KEY')
        return
      }
      generated = data.coverLetter
    } else {
      setGenerating(false)
      toast.info(t('coverLetter.noResumeContent'), t('coverLetter.noResumeContentDetail'))
      return
    }

    // Save the generated text as a new CoverLetter record
    const { data: saved, error: saveErr } = await apiMutate<CoverLetter>(`/api/jobs/${job.id}/cover-letters`, 'POST', {
      content: generated,
      tone:    localTone,
      ...(resumeId ? { resumeId } : {}),
    })
    const validSaved = saved && typeof saved.id === 'string' && saved.userId === owner && saved.jobId === job.id && saved.content === generated
    if (validSaved) { memoryGenerated.delete(generationKey); syncUnloadWarning() }
    if (validSaved && (scopeRef.current !== requestScope || generationRef.current !== generation || closingEpochRef.current !== closingEpoch)) deleteListeners.forEach(listener => listener(generationKey))
    if (scopeRef.current !== requestScope || generationRef.current !== generation || closingEpochRef.current !== closingEpoch) return
    setGenerating(false)
    if (saved && validSaved) {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
      autoSaveTimer.current = null
      skipAutoSaveRef.current = true
      draftRevisionRef.current += 1
      dirtyDraftRef.current = false
      setAutosaveStatus('idle')
      const updated = [saved, ...coverLetters]
      setCoverLetters(updated)
      setActiveId(saved.id)
      setLocalContent(saved.content)
      setLocalTone((saved.tone as Tone) ?? localTone)
      draftRef.current = { activeId: saved.id, content: saved.content, tone: (saved.tone as Tone) ?? localTone }
      toast.success(t('coverLetter.panel.generate'), 'New version created')
      onSaved?.(saved)
    } else {
      toast.error('Save failed', saveErr ?? 'Cover letter generated but could not be saved')
      // Keep generated text separate from the selected letter and its autosave.
      setUnsavedGeneration(generated)
    }
    } finally {
      inFlightGenerations.delete(generationKey)
      writeListeners.forEach(listener => listener())
    }
  }

  async function handlePdfDownload() {
    if (!usable || !activeCL?.content || downloading || deletingRef.current || (activeId && inFlightDeletes.has(draftKey(activeId))) || inFlightGenerations.has(generatedKey)) return
    const requestScope = scope
    const generation = generationRef.current
    const revision = draftRevisionRef.current
    const pdfEpoch = pdfContextEpoch.current
    const closingEpoch = closingEpochRef.current
    const isCurrentScope = () => scopeRef.current === requestScope && generationRef.current === generation
    const isCurrentPdf = () => isCurrentScope() && closingEpochRef.current === closingEpoch && draftRevisionRef.current === revision && pdfContextEpoch.current === pdfEpoch
    setDownloading(true)
    try {
      const { pdf } = await import('@react-pdf/renderer')
      const { renderCoverLetterDoc } = await import('@/lib/cover-letter-pdf')
      const applicant = resumeContent?.contact
        ? {
            name: resumeContent.contact.name || resumeName,
            email: resumeContent.contact.email,
            phone: resumeContent.contact.phone,
            location: resumeContent.contact.location,
            linkedin: resumeContent.contact.linkedin,
          }
        : { name: resumeName || 'Applicant' }
      const document = await renderCoverLetterDoc(
        activeCL.content,
        templateId,
        templateOptions,
        applicant,
        { company: job.company, role: job.role },
      )
      const blob = await pdf(document as never).toBlob()
      if (!isCurrentPdf()) return
      const safeName = `${job.company}_${job.role}`.replace(/[\\/:*?"<>|]/g, '_')
      const url = URL.createObjectURL(blob)
      const anchor = window.document.createElement('a')
      anchor.href = url
      anchor.download = `CoverLetter_${safeName}.pdf`
      window.document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
      toast.success('PDF downloaded', 'Cover letter saved as PDF')
    } catch (error) {
      if (!isCurrentPdf()) return
      console.error('[cover-letter] PDF export failed', error)
      if (isApplicationPdfUnsupportedCharactersError(error)) toast.error(t('application.downloadUnsupportedTitle'), t('application.downloadUnsupportedDetail'))
      else toast.error('PDF error', error instanceof Error ? error.message : 'Could not render cover letter PDF')
    } finally {
      if (isCurrentScope()) setDownloading(false)
    }
  }

  function closeForScope(requestScope: string, generation: number) {
    if (scopeRef.current !== requestScope || generationRef.current !== generation) return
    const closingEpoch = ++closingEpochRef.current
    setVisible(false)
    setTimeout(() => {
      if (scopeRef.current === requestScope && generationRef.current === generation && closingEpochRef.current === closingEpoch) onClose()
    }, 220)
  }

  async function handleClose() {
    if (deletingRef.current) return
    const requestScope = scope
    const generation = generationRef.current
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
    autoSaveTimer.current = null
    if (usable && dirtyDraftRef.current && !await persistDraft()) return
    if (scopeRef.current !== requestScope || generationRef.current !== generation) return
    if (unsavedGeneration) { toast.info(t('toast.saveFailed'), t('resume.correctionChangedDetail')); return }
    closeForScope(requestScope, generation)
  }

  function discardDraft(close: boolean) {
    if (!activeId || !usable) return
    const key = draftKey(activeId)
    memoryDrafts.delete(key)
    uncertainWrites.add(key)
    syncUnloadWarning()
    dirtyDraftRef.current = false
    saveBlockedRef.current = true
    if (close) closeForScope(scope, generationRef.current)
    else setReload(value => value + 1)
  }

  function acknowledgeWrite() {
    if (!activeId) return
    const key = draftKey(activeId)
    if (inFlightWrites.has(key)) return
    uncertainWrites.delete(key)
    saveBlockedRef.current = false
    setAutosaveStatus('idle')
    refreshWriteStatus(value => value + 1)
  }

  return (
    <>
      <div style={{ position: 'relative', zIndex: 301 }}><ConfirmDialog /></div>

      {/* Backdrop */}
      <div
        onClick={handleClose}
        style={{
          position:   'fixed',
          inset:       0,
          zIndex:      299,
          background: visible ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0)',
          transition: 'background 0.22s ease',
        }}
      />

      {/* Panel */}
      <div style={{
        position:   'fixed',
        top:         0,
        right:       0,
        bottom:      0,
        width:       'min(520px, 100vw)',
        zIndex:      300,
        background: 'var(--bg)',
        borderLeft: '0.5px solid var(--border)',
        boxShadow:  '-6px 0 28px rgba(0,0,0,0.15)',
        display:    'flex',
        flexDirection: 'column',
        transform:  visible ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 0.22s ease',
      }}>

        {/* ── Header ─────────────────────────────────────────────────── */}
        <div style={{
          padding:       '14px 18px',
          borderBottom:  '0.5px solid var(--border)',
          display:       'flex',
          alignItems:    'center',
          gap:           10,
          flexShrink:     0,
        }}>
          <button onClick={handleClose} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 16, color: 'var(--text-muted)', lineHeight: 1, padding: 0, flexShrink: 0,
          }}>✕</button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{t('coverLetter.panel.title')}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {job.role} · {job.company}
            </div>
          </div>
        </div>

        {/* ── Controls ────────────────────────────────────────────────── */}
        <div style={{
          padding:       '10px 18px',
          borderBottom:  '0.5px solid var(--border)',
          display:       'flex',
          flexWrap:      'wrap',
          gap:            8,
          alignItems:    'center',
          flexShrink:     0,
        }}>
          {/* Version dropdown */}
          {usable && coverLetters.length > 0 && (
            <select
              value={activeId ?? ''}
              disabled={switching || deleting || deletionBusy || generating || generationBusy || Boolean(unsavedGeneration)}
              onChange={e => handleVersionChange(e.target.value)}
              style={{
                fontSize: 11, padding: '4px 8px',
                border: '0.5px solid var(--border)', borderRadius: 6,
                background: 'var(--bg)', color: 'var(--text)', outline: 'none',
              }}>
              {coverLetters.map((cl, idx) => (
                <option key={cl.id} value={cl.id}>{versionLabel(cl, idx)}</option>
              ))}
            </select>
          )}

          {/* Tone chips */}
          <div style={{ display: 'flex', gap: 4 }}>
            {TONES.map(tone => (
              <button
                key={tone}
                disabled={!usable || switching || deleting || deletionBusy || generating || generationBusy || Boolean(unsavedGeneration) || Boolean(activeId && uncertainWrites.has(draftKey(activeId)) && !memoryDrafts.has(draftKey(activeId)))}
                onClick={() => editDraft(localContent, tone)}
                style={{
                  fontSize:   10,
                  padding:    '3px 9px',
                  borderRadius: 20,
                  cursor:     'pointer',
                  border:     localTone === tone ? 'none' : '0.5px solid var(--border)',
                  background: localTone === tone ? 'var(--primary)' : 'var(--bg-secondary)',
                  color:      localTone === tone ? '#fff' : 'var(--text)',
                  fontWeight: localTone === tone ? 500 : 400,
                }}>
                {tone.charAt(0).toUpperCase() + tone.slice(1)}
              </button>
            ))}
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--text-muted)' }}>
            {t('coverLetter.language.label')}
            <select
              value={localLanguage}
              disabled={!usable || switching || deleting || deletionBusy || generating || generationBusy || Boolean(unsavedGeneration)}
              onChange={e => setLocalLanguage(e.target.value as CoverLetterLanguage)}
              style={{
                fontSize: 11, padding: '4px 8px',
                border: '0.5px solid var(--border)', borderRadius: 6,
                background: 'var(--bg)', color: 'var(--text)', outline: 'none',
              }}>
              {LANGUAGES.map(lang => (
                <option key={lang} value={lang}>{t(`coverLetter.language.${lang}`)}</option>
              ))}
            </select>
          </label>

          <div style={{ flex: 1 }} />

          {/* Generate button */}
          <Btn small variant="primary" onClick={handleGenerate} disabled={generating || generationBusy || deleting || deletionBusy || !usable || switching || saveBlockedRef.current || Boolean(unsavedGeneration)}>
            {generating ? t('coverLetter.generating') : t('coverLetter.panel.generate')}
          </Btn>
        </div>

        {/* Action buttons row */}
        <div style={{
          padding:       '8px 18px',
          borderBottom:  '0.5px solid var(--border)',
          display:       'flex',
          gap:            6,
          flexShrink:     0,
          alignItems:    'center',
        }}>
          <span aria-live="polite" style={{ fontSize: 10, color: autosaveStatus === 'error' ? 'var(--danger)' : 'var(--text-muted)' }}>
            {autosaveStatus === 'pending' && t('resume.savingSoon')}
            {autosaveStatus === 'saving' && t('coverLetter.panel.saving')}
            {autosaveStatus === 'saved' && t('resume.savedJustNow')}
            {autosaveStatus === 'error' && t('coverLetter.panel.autosaveFailed')}
          </span>
          {autosaveStatus === 'error' && <Btn small variant="glass" onClick={() => void navigator.clipboard.writeText(localContent)}>{t('common.copy')}</Btn>}
          <Btn small variant="glass" onClick={() => setPreviewing(value => !value)} disabled={!activeCL || deleting || deletionBusy || generationBusy}>
            {previewing ? t('coverLetter.panel.edit') : t('coverLetter.panel.preview')}
          </Btn>

          {/* PDF export — M9 */}
          <button
            onClick={handlePdfDownload}
            disabled={!activeCL || downloading || deleting || deletionBusy || generationBusy}
            style={{
              fontSize:     10,
              padding:      '4px 9px',
              border:       '0.5px solid var(--border)',
              borderRadius: 6,
              background:   'var(--bg)',
              color:        'var(--text-muted)',
              cursor:       activeCL && !downloading ? 'pointer' : 'not-allowed',
              opacity:      activeCL && !downloading ? 1 : 0.5,
            }}>
            {downloading ? 'Preparing…' : t('coverLetter.panel.downloadPdf')}
          </button>

          <div style={{ flex: 1 }} />
          <Btn small variant="danger" onClick={handleDelete} disabled={!usable || !activeId || switching || deleting || deletionBusy || generating || generationBusy || saveBlockedRef.current || Boolean(unsavedGeneration)}>
            {t('coverLetter.panel.delete')}
          </Btn>
        </div>

        {/* ── Editor (middle, scrollable) ─────────────────────────────── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px' }}>
          {(deleting || deletionBusy) && <p role="status">{t('coverLetter.panel.delete')}…</p>}
          {usable && autosaveStatus === 'error' && <p role="status">{t('resume.correctionChangedDetail')}</p>}
          {usable && activeId && autosaveStatus === 'error' && memoryDrafts.has(draftKey(activeId)) && <div>
            <Btn onClick={() => discardDraft(false)}>{t('coverLetter.panel.discardReload')}</Btn>
            <Btn onClick={() => discardDraft(true)}>{t('coverLetter.panel.discardClose')}</Btn>
          </div>}
          {usable && activeId && uncertainWrites.has(draftKey(activeId)) && !memoryDrafts.has(draftKey(activeId)) && <div role="status">
            <p>{t('coverLetter.panel.writeUnknown')}</p>
            <Btn onClick={acknowledgeWrite} disabled={inFlightWrites.has(draftKey(activeId))}>{t('coverLetter.panel.checkedSaved')}</Btn>
            {inFlightWrites.has(draftKey(activeId)) && <p>{t('coverLetter.panel.writeInFlight')}</p>}
          </div>}
          {loading || (loadedScope !== scope && failedScope !== scope) ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 0', gap: 10 }}>
              <div style={{ width: 20, height: 20, border: '2.5px solid rgba(79,70,229,0.20)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('coverLetter.panel.loading')}</span>
            </div>
          ) : !usable ? (
            <div role="alert" style={{ textAlign: 'center', padding: '60px 24px' }}>
              <p>{t(job.finalCoverLetterId ? 'application.selectedLetterUnavailable' : 'toast.requestFailed')}</p>
              {owner && owner === job.userId && unavailableDraft?.scope === scope && <div>
                <p>{t('resume.correctionChangedDetail')}</p>
                <textarea readOnly aria-label={t('coverLetter.panel.autosaveFailed')} value={unavailableDraft.content} />
                <Btn onClick={() => void navigator.clipboard.writeText(unavailableDraft.content)}>{t('common.copy')}</Btn>
              </div>}
              {owner && owner === job.userId && unsavedGeneration && <div>
                <p>{t('resume.correctionChangedDetail')}</p>
                <textarea readOnly aria-label={t('toast.saveFailed')} value={unsavedGeneration} />
                <Btn onClick={() => void navigator.clipboard.writeText(unsavedGeneration)}>{t('common.copy')}</Btn>
                <Btn variant="danger" onClick={() => { memoryGenerated.delete(generatedKey); syncUnloadWarning(); setUnsavedGeneration('') }}>{t('common.delete')}</Btn>
              </div>}
              <Btn onClick={() => setReload(value => value + 1)}>{t('common.tryAgain')}</Btn>
            </div>
          ) : generating || generationBusy ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 0', gap: 10 }}>
              <div style={{ width: 20, height: 20, border: '2.5px solid rgba(79,70,229,0.20)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('coverLetter.panel.generating')}</span>
            </div>
          ) : unsavedGeneration ? (
            <div role="alert">
              <p>{t('resume.correctionChangedDetail')}</p>
              <textarea readOnly aria-label={t('toast.saveFailed')} value={unsavedGeneration} style={{ width: '100%', minHeight: 240 }} />
              <Btn onClick={() => void navigator.clipboard.writeText(unsavedGeneration)}>{t('common.copy')}</Btn>
              <Btn variant="danger" onClick={() => { memoryGenerated.delete(generatedKey); syncUnloadWarning(); setUnsavedGeneration('') }}>{t('common.delete')}</Btn>
            </div>
          ) : coverLetters.length === 0 && !generating ? (
            <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--text-muted)', fontSize: 12 }}>
              {t('coverLetter.panel.empty')}
            </div>
          ) : previewing ? (
            <CoverLetterPreview
              content={localContent}
              applicant={resumeContent?.contact}
              fallbackName={resumeName}
              company={job.company}
              role={job.role}
              templateId={templateId}
              templateOptions={templateOptions}
            />
          ) : (
            <textarea
              ref={textareaRef}
              value={localContent}
              disabled={switching || deleting || deletionBusy || Boolean(activeId && uncertainWrites.has(draftKey(activeId)) && !memoryDrafts.has(draftKey(activeId)))}
              onChange={e => editDraft(e.target.value, localTone)}
              placeholder={t('coverLetter.panel.placeholder')}
              style={{
                width:       '100%',
                minHeight:   320,
                fontSize:    12,
                lineHeight:  1.8,
                border:      '0.5px solid var(--border)',
                borderRadius: 6,
                padding:     14,
                outline:     'none',
                color:       'var(--text)',
                background:  'var(--bg)',
                resize:      'none',
                overflow:    'hidden',
                boxSizing:   'border-box',
                fontFamily:  'inherit',
              }}
            />
          )}
        </div>

        {/* ── PDF Preview placeholder (bottom) ────────────────────────── */}
        <div style={{ borderTop: '0.5px solid var(--border)', padding: '10px 16px', background: 'var(--bg-secondary)', flexShrink: 0 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4, fontWeight: 500, letterSpacing: '0.05em' }}>{t('coverLetter.panel.pdfHeader')}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', flex: 1 }}>
              📄 with {resumeName}{templateName ? ` · ${templateName}` : ''} — {t('coverLetter.panel.pdfCaption')}
            </div>
            {activeCL && (
              <button
                onClick={handlePdfDownload}
                disabled={downloading || deleting || deletionBusy || generationBusy}
                style={{
                  fontSize:     10,
                  padding:      '3px 8px',
                  border:       '0.5px solid var(--border)',
                  borderRadius: 5,
                  background:   'var(--bg)',
                  color:        'var(--text-muted)',
                  cursor:       downloading ? 'wait' : 'pointer',
                  opacity:      downloading ? 0.65 : 1,
                  flexShrink:   0,
                }}>
                {downloading ? 'Preparing…' : t('coverLetter.panel.downloadPdf')}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

export function CoverLetterPreview({
  content, applicant, fallbackName, company, role, templateId, templateOptions,
}: {
  content: string
  applicant?: ResumeContent['contact']
  fallbackName: string
  company: string
  role: string
  templateId: string
  templateOptions: TemplateOptions
}) {
  const accent = templateOptions.accentColor || 'var(--primary)'
  const fontFamily = templateOptions.fontFamily === 'serif'
    ? "Georgia, 'Times New Roman', serif"
    : templateOptions.fontFamily === 'mono'
      ? "'Courier New', Consolas, monospace"
      : "Inter, 'Segoe UI', Arial, sans-serif"
  const padding = templateOptions.density === 'compact' ? 28 : templateOptions.density === 'spacious' ? 42 : 34
  const name = applicant?.name || fallbackName || 'Applicant'
  const contact = [applicant?.email, applicant?.phone, applicant?.location, applicant?.linkedin].filter(Boolean).join(' · ')
  const paragraphs = content.split(/\n\s*\n/).filter(Boolean)
  const executive = templateId === 'executive'
  const sidebar = templateId === 'sidebar'
  const timeline = templateId === 'timeline'
  const compact = templateId === 'compact'

  const letter = (
    <div style={{ flex: 1, padding, color: '#1F2937', fontSize: compact ? 11 : 12, lineHeight: 1.7 }}>
      {!sidebar && !executive && (
        <div style={{ display: 'flex', gap: timeline ? 12 : 0, alignItems: 'stretch', borderBottom: compact ? `2px solid ${accent}` : `2px solid ${accent}`, paddingBottom: 10, marginBottom: 18 }}>
          {timeline && <div style={{ width: 5, borderRadius: 3, background: accent }} />}
          <div>
            <div style={{ color: compact ? '#111827' : accent, fontSize: compact ? 20 : 23, fontWeight: 700, letterSpacing: '-0.4px' }}>{name}</div>
            {contact && <div style={{ color: '#64748B', fontSize: 10, marginTop: 3 }}>{contact}</div>}
          </div>
        </div>
      )}
      <div style={{ fontSize: 11, color: '#475569', marginBottom: 14 }}>{new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</div>
      <div style={{ marginBottom: 18, fontSize: 11 }}><strong>{company}</strong><br />{role}</div>
      <div style={{ whiteSpace: 'pre-wrap' }}>
        {paragraphs.map((paragraph, index) => <p key={index} style={{ margin: index ? '0 0 15px' : '0 0 15px' }}>{paragraph}</p>)}
      </div>
    </div>
  )

  return (
    <div style={{ minHeight: 420, border: '0.5px solid var(--border)', borderRadius: 7, overflow: 'hidden', background: '#fff', boxShadow: '0 4px 16px rgba(15,23,42,0.08)', fontFamily }}>
      {executive && (
        <div style={{ background: accent, padding: `${padding - 4}px ${padding}px 22px`, color: '#fff' }}>
          <div style={{ fontSize: 25, fontWeight: 800, letterSpacing: '-0.5px' }}>{name}</div>
          {contact && <div style={{ marginTop: 5, fontSize: 10, color: 'rgba(255,255,255,0.82)' }}>{contact}</div>}
        </div>
      )}
      {sidebar ? (
        <div style={{ display: 'flex', minHeight: 420 }}>
          <aside style={{ width: 132, flexShrink: 0, background: accent, color: '#fff', padding: '24px 14px' }}>
            <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.2 }}>{name}</div>
            <div style={{ marginTop: 18, paddingTop: 7, borderTop: '1px solid rgba(255,255,255,0.25)', fontSize: 9, lineHeight: 1.6, color: 'rgba(255,255,255,0.85)', wordBreak: 'break-word' }}>{contact}</div>
          </aside>
          {letter}
        </div>
      ) : letter}
    </div>
  )
}
