import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DeploymentReadiness } from '@/lib/admin/deployment-readiness'
import { DeploymentReadinessPanel } from './DeploymentReadinessPanel'

function readiness(overrides: Partial<DeploymentReadiness> = {}): DeploymentReadiness {
  return {
    candidateSettings: {
      migrations: { state: 'ready', missing: [] },
      superAdminPermission: 'ready',
      currentActorPermission: 'ready',
    },
    workerControl: { state: 'ready', urlConfigured: true, secretConfigured: true, redisConfigured: true },
    ...overrides,
  }
}

describe('DeploymentReadinessPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React)
  })

  it('summarizes a ready deployment without operational secrets', () => {
    const html = renderToStaticMarkup(React.createElement(DeploymentReadinessPanel, { readiness: readiness() }))

    expect(html).toContain('Deployment readiness')
    expect(html).toContain('Settings migrations: Ready')
    expect(html).toContain('Super admin: Ready')
    expect(html).toContain('Current admin: Ready')
    expect(html).toContain('Worker control: Ready')
    expect(html).not.toContain('WORKER_CONTROL_SECRET=')
  })

  it('lists only missing prerequisites for an unavailable settings write path', () => {
    const html = renderToStaticMarkup(React.createElement(DeploymentReadinessPanel, {
      readiness: readiness({
        candidateSettings: {
          migrations: { state: 'missing', missing: ['20260807110000_add_user_preferences_admin_permission'] },
          superAdminPermission: 'missing',
          currentActorPermission: 'missing',
        },
        workerControl: { state: 'missing', urlConfigured: false, secretConfigured: false, redisConfigured: true },
      }),
    }))

    expect(html).toContain('Settings migrations: Missing')
    expect(html).toContain('20260807110000_add_user_preferences_admin_permission')
    expect(html).toContain('Worker controls need: URL and shared secret')
    expect(html).not.toContain('worker-secret')
  })

  it('does not treat the web Redis setting as a Worker control prerequisite', () => {
    const html = renderToStaticMarkup(React.createElement(DeploymentReadinessPanel, {
      readiness: readiness({
        workerControl: { state: 'ready', urlConfigured: true, secretConfigured: true, redisConfigured: false },
      }),
    }))

    expect(html).toContain('Worker control: Ready')
    expect(html).not.toContain('Worker controls need: Redis')
  })

  it('reports checks that cannot be read as unavailable', () => {
    const html = renderToStaticMarkup(React.createElement(DeploymentReadinessPanel, {
      readiness: readiness({
        candidateSettings: {
          migrations: { state: 'unavailable', missing: [] },
          superAdminPermission: 'unavailable',
          currentActorPermission: 'ready',
        },
      }),
    }))

    expect(html).toContain('Settings migrations: Unavailable')
    expect(html).toContain('Super admin: Unavailable')
    expect(html).toContain('Database readiness checks are unavailable.')
  })
})
