'use client'

import React, { createContext, useCallback, useContext, useState } from 'react'
import type { JobStatus } from '@/lib/types'

export { UserAvatar } from './UserAvatar'

// ─── Status config ─────────────────────────────────────────────────────────────
export const STATUS_CONFIG: Record<JobStatus, { label: string; color: string; bg: string }> = {
  saved:     { label: 'Saved',      color: '#6B7280', bg: 'rgba(107,114,128,0.12)' },
  applied:   { label: 'Applied',    color: '#185FA5', bg: 'rgba(24,95,165,0.12)'   },
  review:    { label: 'In Review',  color: '#854F0B', bg: 'rgba(133,79,11,0.12)'   },
  interview: { label: 'Interview',  color: '#3B6D11', bg: 'rgba(59,109,17,0.12)'   },
  offer:     { label: 'Offer',      color: '#0E7490', bg: 'rgba(14,116,144,0.12)'  },
  rejected:  { label: 'Rejected',   color: '#A32D2D', bg: 'rgba(163,45,45,0.12)'   },
}

// ─── StatusBadge ───────────────────────────────────────────────────────────────
export function StatusBadge({ status }: { status: JobStatus }) {
  const cfg = STATUS_CONFIG[status]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: cfg.bg, color: cfg.color,
      borderRadius: 999, padding: '2px 8px',
      fontSize: 11, fontWeight: 500, whiteSpace: 'nowrap',
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: cfg.color, flexShrink: 0 }} />
      {cfg.label}
    </span>
  )
}

// ─── MatchScoreRing ────────────────────────────────────────────────────────────
export function MatchScoreRing({
  score,
  size = 'md',
  showLabel = false,
}: {
  score: number
  size?: 'sm' | 'md' | 'lg'
  showLabel?: boolean
}) {
  const sizes = { sm: 36, md: 48, lg: 64 }
  const px = sizes[size]
  const strokeW = 3
  const r = (px - strokeW * 2) / 2
  const circ = 2 * Math.PI * r
  const offset = circ - (score / 100) * circ
  const color = score >= 80 ? '#185FA5' : score >= 60 ? '#BA7517' : '#E24B4A'
  const fontSize = size === 'sm' ? 10 : size === 'lg' ? 14 : 11
  const [animated, setAnimated] = useState(false)
  React.useEffect(() => {
    const t = setTimeout(() => setAnimated(true), 50)
    return () => clearTimeout(t)
  }, [])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <svg width={px} height={px} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={px/2} cy={px/2} r={r} fill="none" stroke="rgba(0,0,0,0.1)" strokeWidth={strokeW} />
        <circle cx={px/2} cy={px/2} r={r} fill="none" stroke={color} strokeWidth={strokeW}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={animated ? offset : circ}
          style={{ transition: 'stroke-dashoffset 0.6s ease-out' }} />
        <text x={px/2} y={px/2} textAnchor="middle" dominantBaseline="central"
          style={{ fontSize, fontWeight: 500, fill: color, transform: 'rotate(90deg)', transformOrigin: `${px/2}px ${px/2}px` }}>
          {score}%
        </text>
      </svg>
      {showLabel && <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>match</span>}
    </div>
  )
}

// ─── Toast ─────────────────────────────────────────────────────────────────────
interface ToastItem { id: number; variant: 'success'|'info'|'warning'|'error'; title: string; description?: string }
interface ToastCtx { success(t: string, d?: string): void; info(t: string, d?: string): void; warning(t: string, d?: string): void; error(t: string, d?: string): void }

const ToastContext = createContext<ToastCtx | null>(null)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const add = useCallback((variant: ToastItem['variant'], title: string, description?: string) => {
    const id = Date.now()
    setToasts(t => [...t, { id, variant, title, description }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4200)
  }, [])
  const ctx: ToastCtx = {
    success: (t, d) => add('success', t, d),
    info:    (t, d) => add('info', t, d),
    warning: (t, d) => add('warning', t, d),
    error:   (t, d) => add('error', t, d),
  }
  const variantStyle = {
    success: { icon: '✓', bg: 'rgba(59,109,17,0.15)',  color: '#3B6D11' },
    info:    { icon: 'i', bg: 'rgba(24,95,165,0.15)',   color: '#185FA5' },
    warning: { icon: '!', bg: 'rgba(133,79,11,0.15)',   color: '#854F0B' },
    error:   { icon: '✕', bg: 'rgba(163,45,45,0.15)',   color: '#A32D2D' },
  }
  return (
    <ToastContext.Provider value={ctx}>
      {children}
      <div style={{ position: 'fixed', bottom: 16, right: 16, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {toasts.map(t => {
          const vs = variantStyle[t.variant]
          return (
            <div key={t.id} style={{
              width: 300, background: 'var(--bg)', border: '0.5px solid var(--border)',
              borderRadius: 8, padding: '10px 12px',
              display: 'flex', alignItems: 'flex-start', gap: 10,
              animation: 'slideUp 0.2s ease-out',
            }}>
              <div style={{ width: 28, height: 28, borderRadius: 6, background: vs.bg, color: vs.color,
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13, flexShrink: 0 }}>
                {vs.icon}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)' }}>{t.title}</div>
                {t.description && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{t.description}</div>}
                <div style={{ marginTop: 6, height: 2, background: 'var(--border)', borderRadius: 1 }}>
                  <div style={{ height: '100%', background: vs.color, borderRadius: 1, animation: 'drain 4s linear forwards' }} />
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be inside ToastProvider')
  return ctx
}

// ─── Btn ───────────────────────────────────────────────────────────────────────
type BtnVariant = 'primary' | 'ghost' | 'danger' | 'success'
const BTN_VARIANTS: Record<BtnVariant, React.CSSProperties> = {
  primary: { background: '#185FA5', color: '#fff' },
  ghost:   { background: 'transparent', color: 'var(--text)', border: '0.5px solid var(--border)' },
  danger:  { background: 'transparent', color: '#A32D2D', border: '0.5px solid rgba(163,45,45,0.3)' },
  success: { background: 'rgba(59,109,17,0.12)', color: '#3B6D11' },
}

export function Btn({
  variant = 'ghost',
  onClick,
  children,
  style = {},
  disabled = false,
  small = false,
}: {
  variant?: BtnVariant
  onClick?: () => void
  children: React.ReactNode
  style?: React.CSSProperties
  disabled?: boolean
  small?: boolean
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      style={{
        border: 'none', cursor: disabled ? 'not-allowed' : 'pointer', borderRadius: 6,
        fontSize: small ? 11 : 12, fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: small ? '4px 10px' : '6px 12px', whiteSpace: 'nowrap', transition: 'all 0.12s',
        opacity: disabled ? 0.5 : 1,
        ...BTN_VARIANTS[variant],
        ...style,
      }}>
      {children}
    </button>
  )
}

// ─── Card ──────────────────────────────────────────────────────────────────────
export function Card({ children, style = {}, onClick }: { children: React.ReactNode; style?: React.CSSProperties; onClick?: () => void }) {
  return (
    <div onClick={onClick} style={{
      background: 'var(--bg)', border: '0.5px solid var(--border)',
      borderRadius: 12, ...style, cursor: onClick ? 'pointer' : undefined,
    }}>
      {children}
    </div>
  )
}

// ─── Divider ──────────────────────────────────────────────────────────────────
export function Divider({ style = {} }: { style?: React.CSSProperties }) {
  return <div style={{ height: '0.5px', background: 'var(--border)', ...style }} />
}

// ─── CompanyLogo ─────────────────────────────────────────────────────────────
export function CompanyLogo({ logo, size = 24 }: { logo: string; size?: number }) {
  const isUrl = logo?.startsWith('http')
  return (
    <div style={{
      width: size, height: size, borderRadius: 5,
      background: '#f0f4f8', flexShrink: 0, overflow: 'hidden',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {isUrl ? (
        <img src={logo} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
      ) : (
        <span style={{ fontSize: size * 0.38, fontWeight: 700, color: '#185FA5' }}>
          {logo.slice(0, 4).toUpperCase()}
        </span>
      )}
    </div>
  )
}

// ─── ScorePill ───────────────────────────────────────────────────────────────
export function ScorePill({ score }: { score: number }) {
  const color = score >= 80 ? '#3B6D11' : score >= 60 ? '#854F0B' : '#A32D2D'
  const bg    = score >= 80 ? 'rgba(59,109,17,0.12)' : score >= 60 ? 'rgba(133,79,11,0.12)' : 'rgba(163,45,45,0.12)'
  return (
    <span style={{ fontSize: 11, fontWeight: 500, color, background: bg, borderRadius: 999, padding: '2px 7px' }}>
      {score}%
    </span>
  )
}

// ─── Shared form input style ──────────────────────────────────────────────────
/**
 * Common inline style for <input>, <select>, and <textarea> elements.
 * Import this instead of redefining `inputSt` in every component.
 *
 * Usage:
 *   import { INPUT_STYLE } from '@/components/ui'
 *   <input style={INPUT_STYLE} ... />
 *   <textarea style={{ ...INPUT_STYLE, minHeight: 90, resize: 'vertical' }} ... />
 */
export const INPUT_STYLE: React.CSSProperties = {
  width:      '100%',
  padding:    '7px 10px',
  fontSize:   12,
  border:     '0.5px solid var(--border)',
  borderRadius: 6,
  background: 'var(--bg)',
  color:      'var(--text)',
  outline:    'none',
  boxSizing:  'border-box',
}

// ─── ConfirmDialog ────────────────────────────────────────────────────────────
/**
 * In-design-system replacement for window.confirm.
 *
 * Usage:
 *   const [confirm, ConfirmDialog] = useConfirm()
 *   // in JSX: <ConfirmDialog />
 *   // to trigger: await confirm({ title, message, danger })
 */
interface ConfirmOptions {
  title:    string
  message:  string
  /** If true, the confirm button renders in danger style (default: false) */
  danger?:  boolean
  confirmLabel?: string
  cancelLabel?:  string
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>

export function useConfirm(): [ConfirmFn, React.FC] {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null)

  const confirm: ConfirmFn = useCallback(
    (opts) =>
      new Promise<boolean>((resolve) => {
        setState({ ...opts, resolve })
      }),
    [],
  )

  const Dialog: React.FC = useCallback(() => {
    if (!state) return null

    function finish(value: boolean) {
      state!.resolve(value)
      setState(null)
    }

    return (
      <div
        style={{
          position: 'fixed', inset: 0, zIndex: 200,
          background: 'rgba(0,0,0,0.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
        onClick={() => finish(false)}
      >
        <div
          onClick={e => e.stopPropagation()}
          style={{
            background: 'var(--bg)', border: '0.5px solid var(--border)',
            borderRadius: 12, width: 380, padding: 24,
            boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
          }}
        >
          {/* Icon + Title */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            {state.danger && (
              <div style={{
                width: 32, height: 32, borderRadius: 8,
                background: 'rgba(163,45,45,0.12)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 16, flexShrink: 0,
              }}>⚠</div>
            )}
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{state.title}</span>
          </div>

          {/* Message */}
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 20px', lineHeight: 1.6 }}>
            {state.message}
          </p>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn variant="ghost" onClick={() => finish(false)}>
              {state.cancelLabel ?? 'Cancel'}
            </Btn>
            <Btn variant={state.danger ? 'danger' : 'primary'} onClick={() => finish(true)}
              style={state.danger ? { background: 'rgba(163,45,45,0.12)', fontWeight: 600 } : {}}>
              {state.confirmLabel ?? 'Confirm'}
            </Btn>
          </div>
        </div>
      </div>
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  return [confirm, Dialog]
}
