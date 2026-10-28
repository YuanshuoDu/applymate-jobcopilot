'use client'

import React, { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useApi } from '@/lib/hooks'
import { useI18n } from '@/lib/i18n'
import type { PersonalUsage } from '@/lib/personal-usage'
import { SETTINGS_USAGE_COPY } from './settings-usage-copy'

interface Activity { id: string; text: string; createdAt: string }

export function SettingsUsageActivity() {
  const { lang } = useI18n()
  const c = SETTINGS_USAGE_COPY[lang]
  const [days, setDays] = useState(30)
  const usage = useApi<PersonalUsage>(`/api/me/usage?days=${days}`, { cache: false })
  const activity = useApi<Activity[]>('/api/activity?limit=12', { cache: false })
  const data = usage.data?.days === days ? usage.data : null
  const number = (value: number) => new Intl.NumberFormat(lang).format(value)
  const day = (value: string) => new Intl.DateTimeFormat(lang, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(value))
  const timestamp = (value: string) => new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  const refresh = () => { void usage.refetch(); void activity.refetch() }
  const maxCalls = Math.max(1, ...(data?.daily.map(row => row.calls) ?? []))

  return <section className="settings-usage" aria-label={c.title}>
    <header className="settings-usage-header">
      <div><h2>{c.title}</h2><p>{c.subtitle}</p></div>
      <div className="settings-usage-controls">
        <label><span className="sr-only">{c.period}</span><select aria-label={c.period} value={days} disabled={usage.loading} onChange={event => setDays(Number(event.target.value))}>
          <option value={7}>{c.week}</option><option value={30}>{c.month}</option>
        </select></label>
        <button type="button" onClick={refresh} aria-label={c.refresh} disabled={usage.loading || activity.loading}><RefreshCw size={16} aria-hidden="true" /></button>
      </div>
    </header>
    {usage.error ? <div role="alert" className="settings-usage-card"><p>{c.error}</p><button type="button" onClick={() => void usage.refetch()}>{c.retry}</button></div>
      : usage.loading || !data ? <p role="status">{c.loading}</p> : <>
        <div className="settings-usage-metrics">
          {[{ label: c.requests, value: data.summary.calls }, { label: c.input, value: data.summary.inputTokens }, { label: c.output, value: data.summary.outputTokens }].map(metric =>
            <div className="settings-usage-card" key={metric.label}><span>{metric.label}</span><strong>{number(metric.value)}</strong></div>)}
        </div>
        <p className="settings-usage-note">{c.scope}</p>
        <section className="settings-usage-card">
          <h3>{c.daily}</h3>
          <p className="settings-usage-note">{day(data.from)} – {day(data.to)} · {c.dates}</p>
          {data.summary.calls === 0 ? <p>{c.empty}</p> : <>
            <div className="settings-usage-chart" role="img" aria-label={`${c.daily}: ${day(data.from)} – ${day(data.to)}. ${c.details}`}>
              {data.daily.map(row => <div key={row.date} className="settings-usage-bar-column" title={`${day(row.date)}: ${number(row.calls)}`}>
                <div className="settings-usage-bar" style={{ height: `${row.calls / maxCalls * 100}%` }} />
              </div>)}
            </div>
            <div className="settings-usage-axis"><span>{day(data.from)}</span><span>{day(data.to)}</span></div>
          </>}
          <details><summary>{c.details}</summary><div className="settings-usage-table-scroll">
            <table><caption className="sr-only">{c.daily}</caption><thead><tr><th scope="col">{c.date}</th><th scope="col">{c.requests}</th><th scope="col">{c.tokens}</th></tr></thead>
              <tbody>{data.daily.map(row => <tr key={row.date}><th scope="row">{day(row.date)}</th><td>{number(row.calls)}</td><td>{number(row.totalTokens)}</td></tr>)}</tbody></table>
          </div></details>
        </section>
        {data.models.length > 0 && <section className="settings-usage-card">
          <h3>{c.models}</h3><div className="settings-usage-table-scroll">
            <table><caption className="sr-only">{c.models}</caption><thead><tr><th scope="col">{c.model}</th><th scope="col">{c.requests}</th><th scope="col">{c.tokens}</th></tr></thead>
              <tbody>{data.models.map(row => <tr key={JSON.stringify([row.provider, row.model])}><th scope="row">{row.model}<small>{row.provider}</small></th><td>{number(row.calls)}</td><td>{number(row.totalTokens)}</td></tr>)}</tbody></table>
          </div>
        </section>}
      </>}
    <section className="settings-usage-card">
      <h3>{c.activity}</h3><p className="settings-usage-note">{c.activityHint}</p>
      {activity.error ? <div role="alert"><p>{c.activityError}</p><button type="button" onClick={() => void activity.refetch()}>{c.retry}</button></div>
        : activity.loading ? <p role="status">{c.loadingActivity}</p>
          : !activity.data?.length ? <p>{c.noActivity}</p> : <ul className="settings-usage-activity">
            {activity.data.map(row => <li key={row.id}><span>{row.text}</span><time dateTime={row.createdAt}>{timestamp(row.createdAt)}</time></li>)}
          </ul>}
    </section>
    <style>{`
      .settings-usage { width: 100%; max-width: 1040px; min-width: 0; color: var(--text); }
      .settings-usage h2 { margin: 0 0 6px; font-size: 22px; } .settings-usage h3 { margin: 0 0 8px; font-size: 14px; }
      .settings-usage p { margin: 6px 0; font-size: 13px; line-height: 1.6; color: var(--text-muted); }
      .settings-usage-header, .settings-usage-controls { display: flex; align-items: center; gap: 10px; }
      .settings-usage-header { justify-content: space-between; flex-wrap: wrap; margin-bottom: 20px; }
      .settings-usage button, .settings-usage select { font: inherit; font-size: 13px; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 8px; min-height: 38px; padding: 8px 10px; cursor: pointer; }
      .settings-usage button { display: inline-flex; align-items: center; } .settings-usage button:disabled { opacity: .5; cursor: default; }
      .settings-usage :is(button,select,summary):focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
      .settings-usage-metrics { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 12px; }
      .settings-usage-card { min-width: 0; background: var(--bg); border: 1px solid var(--border); border-radius: 12px; padding: 18px; margin-bottom: 16px; }
      .settings-usage-metrics .settings-usage-card { margin-bottom: 0; } .settings-usage-metrics span { color: var(--text-muted); font-size: 12px; }
      .settings-usage-metrics strong { display: block; font-size: 25px; font-weight: 650; margin-top: 10px; overflow-wrap: anywhere; }
      .settings-usage p.settings-usage-note { font-size: 12px; } .settings-usage > .settings-usage-note { margin: 12px 0 22px; }
      .settings-usage-chart { height: 100px; display: flex; gap: 5px; align-items: end; border-bottom: 1px solid var(--border); margin-top: 20px; }
      .settings-usage-bar-column { height: 100%; flex: 1; display: flex; align-items: end; min-width: 0; }
      .settings-usage-bar { width: 100%; background: var(--primary); border-radius: 3px 3px 0 0; }
      .settings-usage-axis { display: flex; justify-content: space-between; color: var(--text-muted); font-size: 11px; margin: 8px 0 14px; }
      .settings-usage summary { cursor: pointer; font-size: 12px; color: var(--text-muted); padding: 8px 0; }
      .settings-usage-table-scroll { overflow: auto; max-height: 260px; } .settings-usage table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .settings-usage th, .settings-usage td { padding: 10px 8px; text-align: right; border-bottom: 1px solid var(--border); }
      .settings-usage th:first-child { text-align: left; overflow-wrap: anywhere; } .settings-usage thead th { font-weight: 500; color: var(--text-muted); }
      .settings-usage tbody th { font-weight: 500; } .settings-usage small { display: block; margin-top: 4px; color: var(--text-muted); }
      .settings-usage-activity { list-style: none; padding: 0; margin: 12px 0 0; } .settings-usage-activity li { display: flex; align-items: start; justify-content: space-between; gap: 16px; padding: 12px 0; font-size: 13px; border-top: 1px solid var(--border); }
      .settings-usage-activity span { overflow-wrap: anywhere; } .settings-usage-activity time { font-size: 11px; color: var(--text-muted); flex-shrink: 0; }
      @media(max-width: 600px) { .settings-usage-card { padding: 14px; } .settings-usage-metrics { gap: 8px; } .settings-usage-metrics strong { font-size: 20px; } .settings-usage-activity li { flex-direction: column; gap: 5px; } }
    `}</style>
  </section>
}
