'use client'

import React from 'react'
import { useI18n } from '@/lib/i18n'

interface State { hasError: boolean; error: Error | null }

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback?: React.ReactNode },
  State
> {
  constructor(props: { children: React.ReactNode; fallback?: React.ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State { return { hasError: true, error } }

  componentDidCatch(error: Error, info: React.ErrorInfo) { console.error('[ErrorBoundary]', error, info.componentStack) }

  render() {
    if (!this.state.hasError) return this.props.children
    return this.props.fallback ?? <ErrorFallback error={this.state.error} onRetry={() => this.setState({ hasError: false, error: null })} />
  }
}

function ErrorFallback({ error, onRetry }: { error: Error | null; onRetry: () => void }) {
  const { t } = useI18n()
  return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-tertiary)' }}>
    <div style={{ textAlign: 'center', maxWidth: 360 }}>
      <div style={{ fontSize: 24, marginBottom: 10 }}>⚠</div>
      <div style={{ fontSize: 13, color: 'var(--c-danger)', marginBottom: 6 }}>{t('common.somethingWentWrong')}</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.5 }}>{error?.message ?? t('common.unexpectedError')}</div>
      <button onClick={onRetry} style={{ padding: '6px 14px', borderRadius: 6, border: '0.5px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', cursor: 'pointer', fontSize: 12 }}>{t('common.tryAgain')}</button>
    </div>
  </div>
}
