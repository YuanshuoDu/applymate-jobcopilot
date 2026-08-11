'use client'

import { useEffect, useMemo, useState } from 'react'
import { fetchWithTimeout } from '@/lib/hooks'

type Model = { id: string; model: string; label: string; tier: string; priceIn: number; priceOut: number; active: boolean }
type Provider = { id: string; key: string; displayName: string; apiBase: string; enabled: boolean; credentialConfigured: boolean; models: Model[] }
type Route = { id: string; featureKey: string; defaultProvider: string; defaultModel: string; fallbackProvider: string | null; fallbackModel: string | null }
type Config = { providers: Provider[]; routes: Route[]; features: Record<string, string> }

export function AdminAiConfigPanel({ canUpdate }: { canUpdate: boolean }) {
  const [config, setConfig] = useState<Config | null>(null)
  const [notice, setNotice] = useState('')
  const [testing, setTesting] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    try {
      const response = await fetchWithTimeout('/api/admin/v1/ai/config', { cache: 'no-store' })
      const payload = await response.json().catch(() => null) as Config | { error?: string } | null
      if (!response.ok) throw new Error((payload as { error?: string } | null)?.error ?? 'Unable to load AI configuration.')
      setConfig(payload as Config)
      setNotice('')
    } catch (loadError) {
      setNotice(loadError instanceof Error ? loadError.message : 'Unable to load AI configuration.')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [])

  const providerMap = useMemo(() => new Map((config?.providers ?? []).map(provider => [provider.key, provider])), [config?.providers])
  function updateRoute(featureKey: string, patch: Partial<Route>) { setConfig(current => current ? { ...current, routes: current.routes.map(route => route.featureKey === featureKey ? { ...route, ...patch } : route) } : current) }
  async function saveRoute(route: Route) {
    const response = await fetch('/api/admin/v1/ai/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ type: 'route', ...route, reason: 'Updating reviewed platform AI routing policy' }) })
    const payload = await response.json().catch(() => null) as { config?: Config; error?: string } | null
    if (!response.ok) setNotice(payload?.error ?? 'Unable to save AI route.'); else { setConfig(payload?.config ?? null); setNotice(`${route.featureKey} route saved.`) }
  }
  async function testProvider(provider: Provider) {
    setTesting(provider.id)
    const response = await fetch(`/api/admin/v1/ai/providers/${provider.id}/test`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() } })
    const payload = await response.json().catch(() => null) as { status?: string; latencyMs?: number; error?: string } | null
    setTesting(null)
    setNotice(response.ok ? `${provider.displayName}: ${payload?.status ?? 'unknown'}${payload?.latencyMs ? ` · ${payload.latencyMs}ms` : ''}` : payload?.error ?? 'Provider test failed.')
  }

  return <section className="admin-ai-config"><div className="admin-controls-title"><div><h2>Platform AI routing</h2><p>Platform defaults are used only when the user feature setting has no usable credential.</p></div><span role="status">{notice}</span></div>{!config ? <p role="status">{loading ? 'Loading AI configuration...' : notice || 'AI configuration is unavailable.'}</p> : <><div className="admin-ai-providers">{config.providers.map(provider => <article key={provider.id}><div><strong>{provider.displayName}</strong><small>{provider.key} · {provider.models.length} models · {provider.enabled ? 'Enabled' : 'Disabled'}</small></div><span className="admin-ai-credential" data-ready={provider.credentialConfigured}>{provider.credentialConfigured ? 'Credential ready' : 'Credential missing'}</span><button className="admin-secondary" disabled={testing === provider.id} onClick={() => void testProvider(provider)}>{testing === provider.id ? 'Testing...' : 'Test connection'}</button></article>)}</div><div className="admin-ai-routes"><h3>Feature routes</h3>{config.routes.map(route => { const provider = providerMap.get(route.defaultProvider); const models = provider?.models.filter(model => model.active) ?? []; return <article key={route.id}><div><strong>{config.features[route.featureKey] ?? route.featureKey}</strong><small>{route.featureKey}</small></div><select value={route.defaultProvider} disabled={!canUpdate} onChange={event => { const nextProvider = event.target.value; const nextModel = providerMap.get(nextProvider)?.models.find(model => model.active)?.model ?? ''; updateRoute(route.featureKey, { defaultProvider: nextProvider, defaultModel: nextModel }) }}>{config.providers.map(item => <option key={item.key} value={item.key}>{item.displayName}</option>)}</select><select value={route.defaultModel} disabled={!canUpdate} onChange={event => updateRoute(route.featureKey, { defaultModel: event.target.value })}>{models.map(model => <option key={model.model} value={model.model}>{model.label}</option>)}</select><button className="admin-secondary" disabled={!canUpdate} onClick={() => void saveRoute(route)}>Save</button></article> })}</div></>}</section>
}
