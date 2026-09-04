'use client'

import { MessageCircle, Plus, RefreshCw, Send, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { useI18n } from '@/lib/i18n'

type SupportMessage = { id: string; authorType: 'customer_reply' | 'staff_reply'; body: string; redacted: boolean; createdAt: string }
type SupportCase = { id: string; subject: string; category: string; status: string; priority: string; slaDueAt: string | null; createdAt: string; updatedAt: string; messages: SupportMessage[] }
type ApiPayload = { cases?: SupportCase[]; case?: { id: string; subject: string; status: string }; message?: SupportMessage; error?: string }

const categories = ['account', 'billing', 'technical', 'auto_apply', 'feedback', 'other'] as const

export function supportStatusLabel(status: string, t?: (key: string) => string) {
  const fallback: Record<string, string> = { open: 'Open', in_progress: 'In progress', waiting_on_customer: 'Waiting on you', resolved: 'Resolved', closed: 'Closed' }
  return t?.(`contact.status.${status}`) ?? fallback[status] ?? status
}

export function supportCategoryLabel(category: string, t?: (key: string) => string) {
  const fallback: Record<string, string> = { account: 'Account', billing: 'Billing', technical: 'Technical issue', auto_apply: 'Auto-apply', feedback: 'Feedback', other: 'Other' }
  return t?.(`contact.category.${category}`) ?? fallback[category] ?? category
}

function formatDate(value: string) {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function ContactUsPage() {
  const { t } = useI18n()
  const [cases, setCases] = useState<SupportCase[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [subject, setSubject] = useState('')
  const [category, setCategory] = useState<(typeof categories)[number]>('technical')
  const [message, setMessage] = useState('')
  const [reply, setReply] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const selected = useMemo(() => cases.find(item => item.id === selectedId) ?? cases[0] ?? null, [cases, selectedId])

  const loadCases = useCallback(async (preferredId?: string) => {
    setLoading(true)
    try {
      const response = await fetch('/api/contact-us/cases', { cache: 'no-store' })
      const payload = await response.json().catch(() => null) as ApiPayload | null
      if (!response.ok) throw new Error(payload?.error ?? t('contact.loadFailed'))
      const nextCases = payload?.cases ?? []
      setCases(nextCases)
      setSelectedId(current => {
        const requested = preferredId ?? new URLSearchParams(window.location.search).get('case')
        if (requested && nextCases.some(item => item.id === requested)) return requested
        if (current && nextCases.some(item => item.id === current)) return current
        return nextCases[0]?.id ?? null
      })
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('contact.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => { void loadCases() }, [loadCases])

  function selectCase(id: string) {
    setSelectedId(id)
    const url = new URL(window.location.href)
    url.searchParams.set('case', id)
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    setError('')
  }

  async function createCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!subject.trim() || !message.trim()) return
    setSubmitting(true); setError(''); setNotice('')
    try {
      const response = await fetch('/api/contact-us/cases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subject, category, message }) })
      const payload = await response.json().catch(() => null) as ApiPayload | null
      if (!response.ok) throw new Error(payload?.error ?? t('contact.createFailed'))
      setSubject(''); setMessage('')
      setNotice(t('contact.created'))
      await loadCases(payload?.case?.id)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t('contact.createFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  async function sendReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selected || !reply.trim() || selected.status === 'closed') return
    setSubmitting(true); setError(''); setNotice('')
    try {
      const response = await fetch(`/api/contact-us/cases/${selected.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: reply }) })
      const payload = await response.json().catch(() => null) as ApiPayload | null
      if (!response.ok) throw new Error(payload?.error ?? t('contact.replyFailed'))
      setReply(''); setNotice(t('contact.replySent')); await loadCases(selected.id)
    } catch (replyError) {
      setError(replyError instanceof Error ? replyError.message : t('contact.replyFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return <main className="contact-page">
    <header className="contact-page-header"><div><span className="contact-eyebrow">{t('contact.eyebrow')}</span><h1>{t('contact.title')}</h1><p>{t('contact.description')}</p></div><button type="button" className="contact-refresh" onClick={() => void loadCases(selected?.id)} disabled={loading}><RefreshCw size={16} aria-hidden="true" /> {t('common.refresh')}</button></header>
    <div className="contact-privacy"><ShieldCheck size={22} aria-hidden="true" /><span>{t('contact.privacy')}</span></div>
    {error && <div className="contact-alert" role="alert">{error}</div>}
    {notice && <div className="contact-notice" role="status">{notice}</div>}
    <div className="contact-layout">
      <aside className="contact-sidebar">
        <form className="contact-new-case" onSubmit={event => void createCase(event)}>
          <div className="contact-section-heading"><div><h2>{t('contact.newCase')}</h2><p>{t('contact.newCaseDescription')}</p></div><Plus size={18} aria-hidden="true" /></div>
          <label>{t('contact.subject')}<input value={subject} onChange={event => setSubject(event.target.value)} maxLength={160} required placeholder={t('contact.subjectPlaceholder')} /></label>
          <label>{t('contact.category')}<select value={category} onChange={event => setCategory(event.target.value as (typeof categories)[number])}>{categories.map(item => <option value={item} key={item}>{supportCategoryLabel(item, t)}</option>)}</select></label>
          <label>{t('contact.message')}<textarea value={message} onChange={event => setMessage(event.target.value)} maxLength={5000} required placeholder={t('contact.messagePlaceholder')} /></label>
          <small>{t('contact.sensitiveDataHint')}</small>
          <button type="submit" className="contact-primary" disabled={submitting || !subject.trim() || !message.trim()}><Send size={15} aria-hidden="true" /> {submitting ? t('contact.sending') : t('contact.submit')}</button>
        </form>
        <section className="contact-case-list" aria-label={t('contact.yourCases')}><div className="contact-section-heading"><h2>{t('contact.yourCases')}</h2><span>{cases.length}</span></div>{loading && <p className="contact-muted">{t('contact.loading')}</p>}{!loading && cases.length === 0 && <p className="contact-muted">{t('contact.empty')}</p>}{cases.map(item => <button type="button" className="contact-case-row" data-active={item.id === selected?.id} key={item.id} onClick={() => selectCase(item.id)}><span><strong>{item.subject}</strong><small>{supportCategoryLabel(item.category, t)} · {formatDate(item.updatedAt)}</small></span><em data-status={item.status}>{supportStatusLabel(item.status, t)}</em></button>)}</section>
      </aside>
      <section className="contact-thread" aria-live="polite">{selected ? <><div className="contact-thread-header"><div><span className="contact-case-id">#{selected.id.slice(-8)}</span><h2>{selected.subject}</h2><p>{supportCategoryLabel(selected.category, t)} · {t('contact.opened')} {formatDate(selected.createdAt)}</p></div><span className="contact-status" data-status={selected.status}>{supportStatusLabel(selected.status, t)}</span></div><div className="contact-messages">{selected.messages.map(item => <article className={`contact-message ${item.authorType}`} key={item.id}><strong>{item.authorType === 'staff_reply' ? t('contact.supportTeam') : t('contact.you')}</strong><p>{item.body}</p><time>{formatDate(item.createdAt)}</time></article>)}</div><form className="contact-reply" onSubmit={event => void sendReply(event)}><textarea value={reply} onChange={event => setReply(event.target.value)} maxLength={5000} disabled={selected.status === 'closed' || submitting} placeholder={selected.status === 'closed' ? t('contact.closedHint') : t('contact.replyPlaceholder')} /><div><small>{t('contact.replyHint')}</small><button type="submit" className="contact-primary" disabled={submitting || !reply.trim() || selected.status === 'closed'}><Send size={15} aria-hidden="true" /> {t('contact.sendReply')}</button></div></form></> : <div className="contact-thread-empty"><MessageCircle size={30} aria-hidden="true" /><h2>{t('contact.selectCase')}</h2><p>{t('contact.selectCaseDescription')}</p></div>}</section>
    </div>
  </main>
}
