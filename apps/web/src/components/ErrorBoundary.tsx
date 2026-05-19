'use client'

import React from 'react'

interface State { hasError: boolean; error: Error | null }

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback?: React.ReactNode },
  State
> {
  constructor(props: { children: React.ReactNode; fallback?: React.ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--bg-tertiary)',
        }}>
          <div style={{ textAlign: 'center', maxWidth: 360 }}>
            <div style={{ fontSize: 24, marginBottom: 10 }}>⚠</div>
            <div style={{ fontSize: 13, color: 'var(--c-danger)', marginBottom: 6 }}>Something went wrong</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.5 }}>
              {this.state.error?.message ?? 'An unexpected error occurred'}
            </div>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              style={{
                padding: '6px 14px', borderRadius: 6, border: '0.5px solid var(--border)',
                background: 'var(--bg)', color: 'var(--text)', cursor: 'pointer', fontSize: 12,
              }}>
              Try again
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
