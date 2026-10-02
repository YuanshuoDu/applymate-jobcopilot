'use client'

import React, { useRef, useState } from 'react'
import { Btn } from '@/components/ui'
import { dispatchAgentDiscoveryStart, type AgentDiscoveryStartResult } from './agent-discovery-trigger'

type TaskGraphResult = Extract<AgentDiscoveryStartResult, { mode: 'task_graph' }>

interface AgentDiscoveryLauncherProps {
  onTaskGraphStarted: (result: TaskGraphResult) => void
  t: (key: string) => string
}

type DiscoveryStatus = { kind: 'status' | 'error' | 'unavailable'; text: string }

export function agentDiscoveryAnnouncement(result: AgentDiscoveryStartResult): DiscoveryStatus {
  if (result.mode === 'unavailable') {
    return {
      kind: 'unavailable',
      text: result.reason === 'not_entitled'
        ? 'Job discovery is not included in your current plan.'
        : 'Agent discovery is currently unavailable.',
    }
  }
  return { kind: 'status', text: `Discovery queued · session ${result.sessionId}` }
}

export function AgentDiscoveryStatus({ status }: { status: DiscoveryStatus | null }) {
  if (!status) return null
  const urgent = status.kind === 'error' || status.kind === 'unavailable'
  return <span role={urgent ? 'alert' : 'status'} aria-live={urgent ? 'assertive' : 'polite'} style={{ fontSize: 11, color: urgent ? 'var(--c-danger)' : 'var(--text-muted)' }}>{status.text}</span>
}

export function AgentDiscoveryLauncher({ onTaskGraphStarted, t }: AgentDiscoveryLauncherProps) {
  const requestId = useRef<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [status, setStatus] = useState<DiscoveryStatus | null>(null)
  const unavailable = status?.kind === 'unavailable'

  async function startDiscovery() {
    if (starting || unavailable) return
    requestId.current ??= crypto.randomUUID()
    setStarting(true)
    setStatus(null)
    try {
      const result = await dispatchAgentDiscoveryStart({
        clientMessageId: requestId.current,
        onTaskGraphStarted,
      })
      requestId.current = null
      setStatus(agentDiscoveryAnnouncement(result))
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Could not start Agent discovery.'
      setStatus({ kind: 'error', text: message })
    } finally {
      setStarting(false)
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px' }}>
      <Btn small variant="primary" disabled={unavailable || starting} onClick={startDiscovery}>
        {starting ? 'Starting…' : `▶ ${t('agent.runNow')}`}
      </Btn>
      <AgentDiscoveryStatus status={status} />
    </div>
  )
}
