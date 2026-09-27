import { describe, expect, it } from 'vitest'

import {
  PLAN_LEDGER_SCHEMA_VERSION,
  parsePlanLedger,
  projectPlanLedger,
  projectTaskEvidencePreview,
} from './plan-ledger.js'

const sessionId = 'session-1'
const rootTaskId = 'root-task'
const graph = {
  schemaVersion: 'agent-harness.v2.task-graph',
  nodes: [
    { key: 'scout', templateId: 'scout', goal: 'Find Dublin backend jobs', successCriteria: ['Save relevant evidence'], dependsOn: [], depth: 1, taskId: 'child-scout' },
    { key: 'analyse', templateId: 'analyst', goal: 'Score the findings', successCriteria: ['Use the saved evidence'], dependsOn: ['scout'], depth: 2, taskId: 'child-analyst' },
  ],
}
const result = {
  status: 'completed', stepCount: 2, toolCallCount: 1, finalItemId: 'private-final-item', finalText: 'PRIVATE_RAW_MODEL_PROSE',
  structuredResult: {
    schemaVersion: 'agent-harness.v2.subagent.result', role: 'scout', status: 'completed', summary: 'PRIVATE_STRUCTURED_PROSE',
    candidates: [{ jobId: 'private-job-77', source: 'greenhouse', url: 'https://private.example/job/77', evidenceIds: ['private-evidence-1'] }],
    evidence: [{ id: 'private-evidence-1', kind: 'job', ref: 'private-job-77', source: 'greenhouse' }],
  },
}
const rows = [
  { id: rootTaskId, sessionId, status: 'running', goal: 'Review roles in Dublin', hasResult: false },
  { id: 'child-scout', sessionId, status: 'completed', role: 'scout', goal: 'Find Dublin backend jobs', result },
  { id: 'child-analyst', sessionId, status: 'waiting', role: 'analyst', goal: 'Score the findings', result: null },
  { id: 'other-session-task', sessionId: 'session-2', status: 'completed', goal: 'CROSS_SESSION_SECRET', result },
]

function projection() {
  return projectPlanLedger({ sessionId, revision: 4, rootTaskId, graph, tasks: rows })
}

describe('versioned Plan Ledger contract', () => {
  it('projects persisted graph and task rows into a bounded, redacted contract', () => {
    const ledger = projection()
    expect(ledger).toEqual({
      schemaVersion: PLAN_LEDGER_SCHEMA_VERSION,
      sessionId,
      revision: 4,
      goal: 'Review roles in Dublin',
      nodes: [
        {
          key: 'scout', goal: 'Find Dublin backend jobs', status: 'completed', resultAvailable: true,
          evidencePreview: {
            role: 'scout', summary: 'Scout completed: 1 candidate; 1 linked evidence item.', itemCount: 1,
            evidence: [{ kind: 'job', source: 'greenhouse', reference: null }],
          },
          readiness: 'terminal', dependencies: [],
        },
        {
          key: 'analyse', goal: 'Score the findings', status: 'waiting', resultAvailable: false,
          evidencePreview: null, readiness: 'active',
          dependencies: [{ key: 'scout', label: 'Find Dublin backend jobs', status: 'completed' }],
        },
      ],
    })
    const serialized = JSON.stringify(ledger)
    for (const secret of ['private-job-77', 'private-evidence-1', 'private-final-item', 'private.example', 'PRIVATE_RAW_MODEL_PROSE', 'PRIVATE_STRUCTURED_PROSE', 'child-scout']) {
      expect(serialized).not.toContain(secret)
    }
    expect(parsePlanLedger(serialized)).toEqual(ledger)
  })

  it('parses API-safe previews and rejects untrusted prose, refs, and unknown fields', () => {
    const safe = projectTaskEvidencePreview({
      status: 'completed', role: 'scout', structuredEvidencePreview: {
        role: 'scout', summary: 'Scout completed: 1 candidate; 1 linked evidence item.', itemCount: 1,
        evidence: [{ kind: 'job', source: 'greenhouse', reference: null }],
      },
    })
    expect(safe).toMatchObject({ role: 'scout', itemCount: 1, evidence: [{ source: 'greenhouse', reference: null }] })
    expect(projectTaskEvidencePreview({ status: 'completed', role: 'scout', structuredEvidencePreview: {
      ...safe, summary: 'PRIVATE_MODEL_PROSE',
    } })).toBeNull()
    expect(parsePlanLedger({ ...projection(), private: 'unexpected' })).toBeNull()
  })

  it('fails closed on malformed snapshots, cyclic dependencies, wrong session records, and oversize text', () => {
    expect(projectPlanLedger({ sessionId, revision: 4, rootTaskId, graph: { ...graph, nodes: [{ ...graph.nodes[0], dependsOn: ['missing'] }] }, tasks: rows })).toBeNull()
    expect(projectPlanLedger({ sessionId, revision: 4, rootTaskId, graph: {
      ...graph, nodes: graph.nodes.map((node, index) => ({ ...node, dependsOn: [index === 0 ? 'analyse' : 'scout'] })),
    }, tasks: rows })).toBeNull()
    expect(projectPlanLedger({ sessionId, revision: 4, rootTaskId, graph, tasks: [rows[3]] })?.goal).toBeNull()
    expect(projectPlanLedger({ sessionId, revision: 4, rootTaskId, graph: {
      ...graph, nodes: [{ ...graph.nodes[0], goal: 'x'.repeat(1_201) }],
    }, tasks: rows })).toBeNull()
    expect(parsePlanLedger({ ...projection(), nodes: [{ ...projection()!.nodes[0]!, goal: 'call@example.com' }] })).toBeNull()
  })
})
