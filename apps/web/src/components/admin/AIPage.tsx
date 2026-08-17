'use client'

import React, { useEffect, useState } from 'react'
import { Bot, CheckCircle2, Plus, RefreshCw, Save, TestTube2, XCircle } from 'lucide-react'
import type { AiModelDto, AiProviderDto } from '@/lib/admin/ai'
import { useI18n } from '@/lib/i18n'

interface AiRoute { id: string; featureKey: string; defaultProvider: string; defaultModel: string; fallbackProvider?: string; fallbackModel?: string; version: number }
interface ModelRef { provider: string; model: string; label: string }

export function providerHealthLabel(value: Pick<AiProviderDto, 'credentialConfigured' | 'enabled'>): string { return !value.enabled ? 'Disabled' : value.credentialConfigured ? 'Ready' : 'Credential missing' }
export function routeLabel(value: Pick<AiRoute, 'defaultProvider' | 'defaultModel' | 'fallbackProvider' | 'fallbackModel'>): string { const primary = `${value.defaultProvider}/${value.defaultModel}`; return value.fallbackProvider && value.fallbackModel ? `${primary} → ${value.fallbackProvider}/${value.fallbackModel}` : primary }
export function providerEnabledPatch(value: Pick<AiProviderDto, 'enabled'>): { enabled: boolean } { return { enabled: !value.enabled } }

export function AIPage() {
  const { t } = useI18n()
  const [providers, setProviders] = useState<AiProviderDto[]>([])
  const [routes, setRoutes] = useState<AiRoute[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreateProvider, setShowCreateProvider] = useState(false)
  async function load() {
    setLoading(true); setError('')
    try { const [providersResponse, routesResponse] = await Promise.all([fetch('/api/admin/v1/ai/providers', { cache: 'no-store' }), fetch('/api/admin/v1/ai/routes', { cache: 'no-store' })]); const providersBody = await providersResponse.json() as { items?: AiProviderDto[]; error?: string }; const routesBody = await routesResponse.json() as { items?: AiRoute[]; error?: string }; if (!providersResponse.ok) throw new Error(providersBody.error ?? 'Unable to load providers'); if (!routesResponse.ok) throw new Error(routesBody.error ?? 'Unable to load routes'); setProviders(providersBody.items ?? []); setRoutes(routesBody.items ?? []) } catch (loadError) { setError(loadError instanceof Error ? loadError.message : 'Unable to load AI configuration') } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  const models: ModelRef[] = providers.flatMap(provider => provider.models.filter(model => model.active).map(model => ({ provider: provider.key, model: model.model, label: model.label })))
  return <div style={{ maxWidth: 1180, margin: '0 auto' }}><header style={headerStyle}><div><div style={eyebrow}>{t('ai.platformOperations')}</div><h1 style={titleStyle}>{t('ai.title')}</h1><p style={muted}>{t('ai.description')}</p></div><button type="button" title={t('ai.refresh')} onClick={() => void load()} style={iconButton}><RefreshCw size={16} aria-hidden="true" /></button></header>{error && <ErrorBox text={error} />}{loading ? <p style={muted}>{t('ai.loading')}</p> : <><section style={section}><div style={sectionHeader}><h2 style={heading}>{t('ai.providers')}</h2><button type="button" title={t('ai.createProvider')} onClick={() => setShowCreateProvider(value => !value)} style={secondary}><Plus size={14} aria-hidden="true" /> {t('ai.createProvider')}</button></div>{showCreateProvider && <CreateProviderForm onCreated={async () => { setShowCreateProvider(false); await load() }} />}{providers.length > 0 && <div style={providerGrid}>{providers.map(provider => <ProviderCard key={provider.id} provider={provider} onSaved={load} />)}</div>}{providers.length === 0 && <p style={muted}>{t('ai.noProviders')}</p>}</section><section style={section}><h2 style={heading}>{t('ai.featureRouting')}</h2><div style={{ display: 'grid', gap: 8 }}>{routes.map(route => <RouteRow key={route.id} route={route} models={models} onSaved={load} />)}</div>{routes.length === 0 && <p style={muted}>{t('ai.noRoutes')}</p>}</section></>}</div>
}

function CreateProviderForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const { t } = useI18n()
  const [key, setKey] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [apiBase, setApiBase] = useState('https://')
  const [secretRef, setSecretRef] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  async function create() {
    if (!key.trim() || !displayName.trim() || !apiBase.trim() || reason.trim().length < 10) return
    setBusy(true)
    try {
      const response = await fetch('/api/admin/v1/ai/providers', { method: 'POST', headers: headers(), body: JSON.stringify({ key, displayName, apiBase, secretRef: secretRef || undefined, reason }) })
      if (!response.ok) throw new Error('Provider creation failed')
      await onCreated()
    } finally { setBusy(false) }
  }
  return <div style={createGrid}><input value={key} onChange={event => setKey(event.target.value)} placeholder="Provider key" style={input} /><input value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder={t('ai.displayName')} style={input} /><input value={apiBase} onChange={event => setApiBase(event.target.value)} placeholder="HTTPS API base" style={input} /><input value={secretRef} onChange={event => setSecretRef(event.target.value)} placeholder={t('ai.secretReference')} style={input} /><input value={reason} onChange={event => setReason(event.target.value)} placeholder={t('ai.reasonPlaceholder')} style={input} /><button type="button" disabled={busy || reason.trim().length < 10} onClick={() => void create()} style={primary}><Save size={14} aria-hidden="true" /> {t('ai.create')}</button></div>
}

function ProviderCard({ provider, onSaved }: { provider: AiProviderDto; onSaved: () => Promise<void> }) {
  const { t } = useI18n()
  const [draft, setDraft] = useState(provider); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [showCreateModel, setShowCreateModel] = useState(false); useEffect(() => setDraft(provider), [provider])
  async function save() { if (reason.trim().length < 10) return; setBusy(true); try { const response = await fetch(`/api/admin/v1/ai/providers/${provider.id}`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ ...draft, version: provider.version, reason }) }); if (!response.ok) throw new Error('Provider update failed'); setReason(''); await onSaved() } finally { setBusy(false) } }
  async function toggleEnabled() { if (reason.trim().length < 10) return; setBusy(true); try { const response = await fetch(`/api/admin/v1/ai/providers/${provider.id}`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ ...draft, ...providerEnabledPatch(draft), version: provider.version, reason }) }); if (!response.ok) throw new Error('Provider status update failed'); setReason(''); await onSaved() } finally { setBusy(false) } }
  async function test() { const testReason = window.prompt(t('ai.reasonPrompt'))?.trim() ?? ''; if (testReason.length < 10) return; setBusy(true); try { const response = await fetch(`/api/admin/v1/ai/providers/${provider.id}/test`, { method: 'POST', headers: headers(), body: JSON.stringify({ model: provider.models.find(model => model.active)?.model, reason: testReason }) }); const body = await response.json() as { ok?: boolean; errorClass?: string; error?: string }; if (!response.ok || !body.ok) window.alert(body.errorClass ?? body.error ?? t('ai.testFailed')); else window.alert(t('ai.testPassed')) } finally { setBusy(false) } }
  return <article style={card}><div style={cardHeader}><div><h3 style={{ margin: 0, fontSize: 16 }}>{provider.displayName}</h3><span style={muted}>{provider.key} · v{provider.version}</span></div><span style={{ ...status, background: providerHealthLabel(provider) === 'Ready' ? '#e7f6ef' : '#fff1e8', color: providerHealthLabel(provider) === 'Ready' ? '#13734f' : '#a34b19' }}>{providerHealthLabel(provider) === 'Ready' ? 'Ready' : t('ai.disabled')}</span></div><div style={metaGrid}><div><span style={muted}>{t('ai.secretReference')}</span><strong style={value}>{provider.secretRef || t('ai.notConfigured')}</strong></div><div><span style={muted}>{t('ai.apiBase')}</span><strong style={value}>{provider.apiBase}</strong></div></div><label style={label}>{t('ai.displayName')}<input value={draft.displayName} onChange={event => setDraft({ ...draft, displayName: event.target.value })} style={input} /></label><label style={label}>{t('ai.auditReason')}<input value={reason} onChange={event => setReason(event.target.value)} placeholder={t('ai.reasonPlaceholder')} style={input} /></label><div style={buttonRow}><button type="button" disabled={busy || reason.trim().length < 10} onClick={() => void save()} style={primary}><Save size={14} aria-hidden="true" /> {t('ai.save')}</button><button type="button" disabled={busy || !provider.credentialConfigured} onClick={() => void test()} style={secondary}><TestTube2 size={14} aria-hidden="true" /> {t('ai.testConnection')}</button><button type="button" disabled={busy || reason.trim().length < 10} onClick={() => void toggleEnabled()} style={secondary}>{draft.enabled ? <CheckCircle2 size={14} aria-hidden="true" /> : <XCircle size={14} aria-hidden="true" />}{draft.enabled ? t('ai.enabled') : t('ai.disabled')}</button></div><div style={modelList}><div style={modelHeader}><strong style={{ fontSize: 12 }}>{t('ai.models')}</strong><button type="button" title={t('ai.create')} onClick={() => setShowCreateModel(value => !value)} style={smallButton}><Plus size={13} aria-hidden="true" /> {t('ai.add')}</button></div>{showCreateModel && <CreateModelForm providerId={provider.id} onCreated={async () => { setShowCreateModel(false); await onSaved() }} />}{provider.models.map(model => <ModelRow key={model.id} provider={provider} model={model} onSaved={onSaved} />)}</div></article>
}

function CreateModelForm({ providerId, onCreated }: { providerId: string; onCreated: () => Promise<void> }) {
  const { t } = useI18n()
  const [model, setModel] = useState(''); const [label, setLabel] = useState(''); const [tier, setTier] = useState('standard'); const [contextK, setContextK] = useState('128'); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false)
  async function create() {
    if (!model.trim() || !label.trim() || reason.trim().length < 10) return
    setBusy(true)
    try { const response = await fetch(`/api/admin/v1/ai/providers/${providerId}/models`, { method: 'POST', headers: headers(), body: JSON.stringify({ model, label, tier, priceIn: 0, priceOut: 0, contextK: Number(contextK), active: true, reason }) }); if (!response.ok) throw new Error('Model creation failed'); await onCreated() } finally { setBusy(false) }
  }
  return <div style={createGrid}><input value={model} onChange={event => setModel(event.target.value)} placeholder={t('ai.modelIdentifier')} style={input} /><input value={label} onChange={event => setLabel(event.target.value)} placeholder={t('ai.label')} style={input} /><select value={tier} onChange={event => setTier(event.target.value)} style={input}><option value="fast">{t('ai.fast')}</option><option value="standard">{t('ai.standard')}</option><option value="premium">{t('ai.premium')}</option></select><input type="number" min="1" value={contextK} onChange={event => setContextK(event.target.value)} placeholder={t('ai.contextK')} style={input} /><input value={reason} onChange={event => setReason(event.target.value)} placeholder={t('ai.reasonPlaceholder')} style={input} /><button type="button" disabled={busy || reason.trim().length < 10} onClick={() => void create()} style={primary}><Save size={14} aria-hidden="true" /> {t('ai.create')}</button></div>
}

function ModelRow({ provider, model, onSaved }: { provider: AiProviderDto; model: AiModelDto; onSaved: () => Promise<void> }) {
  const { t } = useI18n()
  async function toggle() { const reason = window.prompt(t('ai.reasonPrompt'))?.trim() ?? ''; if (reason.length < 10) return; const response = await fetch(`/api/admin/v1/ai/providers/${provider.id}/models/${model.id}`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ model: model.model, label: model.label, description: model.description, tier: model.tier, priceIn: model.priceIn, priceOut: model.priceOut, contextK: model.contextK, active: !model.active, reason }) }); if (response.ok) await onSaved() }
  return <div style={modelRow}><span>{model.label}<small style={muted}>{model.model}</small></span><span style={muted}>{model.contextK}K · ${model.priceIn}/{model.priceOut}</span><button type="button" title={model.active ? t('ai.disableModel') : t('ai.enableModel')} onClick={() => void toggle()} style={smallButton}>{model.active ? t('ai.active') : t('ai.inactive')}</button></div>
}

function RouteRow({ route, models, onSaved }: { route: AiRoute; models: ModelRef[]; onSaved: () => Promise<void> }) {
  const { t } = useI18n()
  const [draft, setDraft] = useState(route); const [busy, setBusy] = useState(false); useEffect(() => setDraft(route), [route])
  async function save() { const reason = window.prompt(t('ai.reasonPrompt'))?.trim() ?? ''; if (reason.length < 10) return; setBusy(true); try { const [defaultProvider, defaultModel] = draft.defaultModel.includes('/') ? draft.defaultModel.split('/', 2) : [draft.defaultProvider, draft.defaultModel]; const [fallbackProvider, fallbackModel] = draft.fallbackModel?.includes('/') ? draft.fallbackModel.split('/', 2) : [draft.fallbackProvider, draft.fallbackModel]; const response = await fetch('/api/admin/v1/ai/routes', { method: 'PATCH', headers: headers(), body: JSON.stringify({ featureKey: draft.featureKey, defaultProvider, defaultModel, fallbackProvider: fallbackProvider || undefined, fallbackModel: fallbackModel || undefined, version: route.version, reason }) }); if (!response.ok) throw new Error('Route update failed'); await onSaved() } finally { setBusy(false) } }
  return <div style={routeRow}><span style={{ fontWeight: 700, fontSize: 12 }}>{route.featureKey}</span><select value={`${draft.defaultProvider}/${draft.defaultModel}`} onChange={event => { const [provider, model] = event.target.value.split('/', 2); setDraft({ ...draft, defaultProvider: provider, defaultModel: model }) }} style={input}>{models.map(model => <option key={`${model.provider}/${model.model}`} value={`${model.provider}/${model.model}`}>{model.label}</option>)}</select><select value={draft.fallbackProvider && draft.fallbackModel ? `${draft.fallbackProvider}/${draft.fallbackModel}` : ''} onChange={event => { if (!event.target.value) { setDraft({ ...draft, fallbackProvider: undefined, fallbackModel: undefined }); return }; const [provider, model] = event.target.value.split('/', 2); setDraft({ ...draft, fallbackProvider: provider, fallbackModel: model }) }} style={input}><option value="">{t('ai.noFallback')}</option>{models.map(model => <option key={`${model.provider}/${model.model}`} value={`${model.provider}/${model.model}`}>{model.label}</option>)}</select><span style={muted}>{routeLabel(draft)}</span><button type="button" disabled={busy || models.length === 0} onClick={() => void save()} style={smallButton}><Save size={13} aria-hidden="true" /> {t('ai.save')}</button></div>
}

function headers(): HeadersInit { return { 'Content-Type': 'application/json', Origin: window.location.origin, 'Idempotency-Key': `${Date.now()}-${Math.random().toString(36).slice(2)}` } }
function ErrorBox({ text }: { text: string }) { return <div role="alert" style={{ marginBottom: 14, padding: 10, border: '1px solid #e6b8b8', color: '#a32d2d', background: '#fff8f8', borderRadius: 6 }}>{text}</div> }
const headerStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 22 }
const eyebrow = { color: '#5b6b80', fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '.08em' }
const titleStyle = { margin: '5px 0 0', fontSize: 28 }
const muted = { color: '#5b6b80', fontSize: 12 }
const value = { display: 'block', marginTop: 4, fontSize: 12, fontWeight: 500, overflowWrap: 'anywhere' as const }
const section = { background: '#fff', border: '1px solid #d9e2ec', borderRadius: 8, padding: 18, marginBottom: 16 }
const heading = { margin: '0 0 14px', fontSize: 16 }
const sectionHeader = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }
const providerGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 14 }
const card = { border: '1px solid #d9e2ec', borderRadius: 7, padding: 15 }
const cardHeader = { display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 14 }
const status = { alignSelf: 'start', padding: '3px 7px', borderRadius: 999, fontSize: 11, fontWeight: 700 }
const metaGrid = { display: 'grid', gap: 8, marginBottom: 13 }
const label = { display: 'grid', gap: 5, color: '#5b6b80', fontSize: 11, marginBottom: 9 }
const input = { minHeight: 32, minWidth: 0, border: '1px solid #c9d5e1', borderRadius: 5, padding: '0 8px', font: 'inherit', color: '#172033', background: '#fff' }
const buttonRow = { display: 'flex', flexWrap: 'wrap' as const, gap: 7, marginBottom: 14 }
const primary = { minHeight: 32, display: 'inline-flex', alignItems: 'center', gap: 5, border: 0, borderRadius: 6, padding: '0 10px', background: '#146c94', color: '#fff', cursor: 'pointer', fontWeight: 700, fontSize: 12 }
const secondary = { ...primary, background: '#fff', color: '#146c94', border: '1px solid #9db8ca' }
const iconButton = { width: 32, height: 32, display: 'inline-grid', placeItems: 'center', border: '1px solid #c9d5e1', borderRadius: 5, background: '#fff', cursor: 'pointer' }
const modelList = { borderTop: '1px solid #e5ebf1', paddingTop: 11, display: 'grid', gap: 7 }
const modelHeader = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }
const createGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 7, padding: '0 0 12px', marginBottom: 12, borderBottom: '1px solid #e5ebf1' }
const modelRow = { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto auto', gap: 8, alignItems: 'center', fontSize: 12 }
const smallButton = { minHeight: 28, display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid #c9d5e1', borderRadius: 5, background: '#fff', color: '#146c94', cursor: 'pointer', padding: '0 8px', fontSize: 11 }
const routeRow = { display: 'grid', gridTemplateColumns: '130px minmax(160px,1fr) minmax(160px,1fr) minmax(180px,1.2fr) auto', gap: 8, alignItems: 'center', padding: '9px 0', borderBottom: '1px solid #e5ebf1' }
