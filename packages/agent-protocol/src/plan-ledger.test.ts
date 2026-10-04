import { describe, expect, it } from 'vitest'

import {
  PLAN_LEDGER_SCHEMA_VERSION,
  TASK_GRAPH_MAX_IDENTIFIER_LENGTH,
  TASK_GRAPH_SCHEMA_VERSION,
  parsePlanLedger,
  parseTaskGraphSnapshot,
  projectPlanLedger,
  projectTaskEvidencePreview,
} from './plan-ledger.js'

const sessionId = 'session-1'
const rootTaskId = 'root-task'
const graph = {
  schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
  nodes: [
    { key: 'scout', templateId: 'scout', goal: 'Find Dublin backend jobs', successCriteria: ['Save relevant evidence'], dependsOn: [], depth: 1, taskId: 'child-scout' },
    { key: 'analyse', templateId: 'analyst', goal: 'Score the findings', successCriteria: ['Use the saved evidence'], dependsOn: ['scout'], depth: 2, taskId: 'child-analyst' },
  ],
}

function maximalAsciiSnapshot() {
  const keys = Array.from({ length: 8 }, (_, index) => `${'k'.repeat(127)}${index}`)
  return {
    schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
    nodes: keys.map((key, index) => ({
      key, templateId: 't'.repeat(128), goal: 'g'.repeat(1_200),
      successCriteria: Array.from({ length: 8 }, () => 'c'.repeat(320)),
      dependsOn: keys.slice(0, index), depth: index + 1, taskId: `${'x'.repeat(127)}${index}`,
    })),
  }
}

function snapshotAtUtf8ByteLimit() {
  const snapshot = maximalAsciiSnapshot()
  const first = snapshot.nodes[0]!
  first.goal = '😀'.repeat(600)
  first.successCriteria[0] = '😀'.repeat(160)
  first.successCriteria[1] = '😀'.repeat(160)
  first.successCriteria[2] = '😀'.repeat(160)
  first.successCriteria[3] = '😀'.repeat(13) + 'c'.repeat(294)
  return snapshot
}
const result = {
  status: 'completed', stepCount: 2, toolCallCount: 1, finalItemId: 'private-final-item', finalText: 'PRIVATE_RAW_MODEL_PROSE',
  structuredResult: {
    schemaVersion: 'agent-harness.v2.subagent.result', role: 'scout', status: 'completed', summary: 'PRIVATE_STRUCTURED_PROSE',
    candidates: [{ jobId: 'private-job-77', source: 'greenhouse', url: 'https://private.example/job/77', evidenceIds: ['private-evidence-1'] }],
    evidence: [{ id: 'private-evidence-1', kind: 'job', ref: 'private-job-77', source: 'greenhouse' }],
  },
}
const verification = {
  schemaVersion: 'agent-harness.v2.task-graph-verification.v1', role: 'scout',
  criteria: [{ id: 'candidate-count', check: { kind: 'candidate_count_gte', minimum: 1 } }],
}
const verificationReport = {
  verifierVersion: 'agent-harness.v2.task-graph-verifier.v1', status: 'passed', reasonCode: 'criteria_met',
  criteria: [{ criterionId: 'candidate-count', status: 'passed', reasonCode: 'criteria_met' }],
  evidenceDigest: 'a'.repeat(64), resultDigest: 'b'.repeat(64),
}
const rows = [
  { id: rootTaskId, sessionId, status: 'running', goal: 'Review roles in Dublin', hasResult: false },
  { id: 'child-scout', sessionId, status: 'completed', role: 'scout', goal: 'Find Dublin backend jobs', result },
  { id: 'child-analyst', sessionId, status: 'waiting', role: 'analyst', goal: 'Score the findings', result: null },
  { id: 'other-session-task', sessionId: 'session-2', status: 'completed', goal: 'CROSS_SESSION_SECRET', result },
]

function sparseArrayWithNamedKey(): unknown[] {
  const value: unknown[] = []
  value.length = 1
  Object.defineProperty(value, 'named', { value: true })
  return value
}

function projection() {
  return projectPlanLedger({ sessionId, revision: 4, rootTaskId, graph, tasks: rows })
}

function workerFinalItemId(taskId: string): string {
  const executionId = (prefix: string) => `task:${taskId}:${prefix}`
  const attemptId = (id: string) => `${id}:attempt:1`
  const stepId = attemptId(executionId('step:1'))
  return attemptId(executionId(`item:final:${stepId}`))
}

describe('versioned Plan Ledger contract', () => {
  it('exposes the shared bounded TaskGraph parser for object and JSON payloads', () => {
    expect(parseTaskGraphSnapshot(graph)?.nodes).toHaveLength(2)
    expect(parseTaskGraphSnapshot(JSON.stringify(graph))?.nodes).toHaveLength(2)
    expect(parseTaskGraphSnapshot(' '.repeat(40_001) + JSON.stringify(graph))?.nodes).toHaveLength(2)
    expect(parseTaskGraphSnapshot({ ...graph, schemaVersion: 'future' })).toBeNull()
  })

  it('enforces the canonical UTF-8 cap after parsing JSON transport', () => {
    const atLimit = snapshotAtUtf8ByteLimit()
    const encoded = JSON.stringify(atLimit)
    expect(new TextEncoder().encode(encoded).byteLength).toBe(40_000)
    expect(parseTaskGraphSnapshot(atLimit)?.nodes).toHaveLength(8)
    expect(parseTaskGraphSnapshot(encoded.padEnd(45_000, ' '))?.nodes).toHaveLength(8)
    const escaped = encoded.replaceAll('😀', '\\ud83d\\ude00')
    expect(new TextEncoder().encode(escaped).byteLength).toBeGreaterThan(40_000)
    expect(parseTaskGraphSnapshot(escaped)?.nodes).toHaveLength(8)

    const overLimit = { ...atLimit, nodes: atLimit.nodes.map((node, index) => index === 1
      ? { ...node, goal: `é${node.goal.slice(1)}` } : node) }
    expect(new TextEncoder().encode(JSON.stringify(overLimit)).byteLength).toBe(40_001)
    expect(parseTaskGraphSnapshot(overLimit)).toBeNull()
    expect(parseTaskGraphSnapshot(JSON.stringify(overLimit))).toBeNull()
  })

  it('rejects sparse TaskGraph arrays and preserves legacy whitespace identifiers', () => {
    const first = graph.nodes[0]!
    expect(parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SCHEMA_VERSION, nodes: sparseArrayWithNamedKey() })).toBeNull()
    expect(parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SCHEMA_VERSION, nodes: [{ ...first, successCriteria: sparseArrayWithNamedKey() }] })).toBeNull()
    expect(parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SCHEMA_VERSION, nodes: [{ ...first, dependsOn: sparseArrayWithNamedKey() }] })).toBeNull()
    expect(parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SCHEMA_VERSION, nodes: [{ ...first, key: ' scout ', taskId: ' child-scout ', templateId: ' template ' }] })?.nodes[0]).toMatchObject({
      key: ' scout ', taskId: ' child-scout ', templateId: ' template ',
    })
    expect(parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SCHEMA_VERSION, nodes: [{ ...first, key: 'k'.repeat(TASK_GRAPH_MAX_IDENTIFIER_LENGTH + 1) }] })).toBeNull()
  })

  it('accepts persisted V2 verifier and repair metadata while projecting only the unchanged public graph', () => {
    const typed = {
      ...graph,
      nodes: [
        { ...graph.nodes[0]!, verification, verificationDisposition: 'typed' },
        { ...graph.nodes[1]!, verificationDisposition: 'legacy_unverified' },
      ],
    }
    expect(parseTaskGraphSnapshot(typed)?.nodes[0]).toEqual(graph.nodes[0])
    const repaired = {
      ...graph,
      nodes: [{
        ...graph.nodes[0]!, key: 'scout-repair', taskId: 'child-repair',
        verification, verificationDisposition: 'typed',
        repairOf: { graphRootTaskId: rootTaskId, nodeKey: 'scout', taskId: 'child-scout', criterionIds: ['candidate-count'] },
      }],
    }
    expect(parseTaskGraphSnapshot(repaired)?.nodes[0]).toMatchObject({ key: 'scout-repair', taskId: 'child-repair' })
    expect(JSON.stringify(parseTaskGraphSnapshot(repaired))).not.toMatch(/verification|repairOf|candidate-count/)
  })

  it('keeps the entire projected DTO free of graph and result metadata while retaining safe previews', () => {
    const scoutVerification = {
      schemaVersion: 'agent-harness.v2.task-graph-verification.v1', role: 'scout',
      criteria: [{ id: 'candidate-count', check: { kind: 'candidate_count_gte', minimum: 1 } }],
    }
    const analystVerification = {
      schemaVersion: 'agent-harness.v2.task-graph-verification.v1', role: 'analyst',
      criteria: [{ id: 'finding-count', check: { kind: 'finding_count_gte', minimum: 1 } }],
    }
    const reportFor = (criterionId: string, digest: string) => ({
      verifierVersion: 'agent-harness.v2.task-graph-verifier.v1', status: 'passed', reasonCode: 'criteria_met',
      criteria: [{ criterionId, status: 'passed', reasonCode: 'criteria_met' }],
      evidenceDigest: digest.repeat(64), resultDigest: 'f'.repeat(64),
    })
    const typedGraph = {
      ...graph,
      nodes: [
        { ...graph.nodes[0]!, verification: scoutVerification, verificationDisposition: 'typed' },
        { ...graph.nodes[1]!, verification: analystVerification, verificationDisposition: 'typed' },
        {
          ...graph.nodes[0]!, key: 'scout-repair', taskId: 'child-repair', goal: 'Repair Scout evidence',
          dependsOn: ['analyse'], depth: 3, verification: scoutVerification, verificationDisposition: 'typed',
          repairOf: { graphRootTaskId: rootTaskId, nodeKey: 'scout', taskId: 'child-scout', criterionIds: ['candidate-count'] },
        },
      ],
    }
    const scoutReport = reportFor('candidate-count', 'a')
    const analystReport = reportFor('finding-count', 'b')
    const repairReport = reportFor('candidate-count', 'c')
    const scoutResult = { ...result, taskGraphVerificationReport: scoutReport }
    const analystResult = {
      status: 'completed', stepCount: 2, toolCallCount: 1, finalItemId: 'private-analyst-item',
      finalText: 'PRIVATE_ANALYST_TEXT',
      structuredResult: {
        schemaVersion: 'agent-harness.v2.subagent.result', role: 'analyst', status: 'completed',
        summary: 'PRIVATE_ANALYST_SUMMARY',
        findings: [{ jobId: 'private-job-88', score: 8, evidenceIds: ['private-analyst-evidence'] }],
        evidence: [{ id: 'private-analyst-evidence', kind: 'job', ref: 'private-job-88', source: 'lever' }],
      },
      taskGraphVerificationReport: analystReport,
    }
    const repairResult = {
      ...result, taskGraphVerificationReport: repairReport,
      taskGraphRepairReceipt: {
        schemaVersion: 'agent-harness.v2.task-graph-repair-receipt.v1', graphRootTaskId: rootTaskId,
        targetNodeKey: 'scout', targetTaskId: 'child-scout', criterionIds: ['candidate-count'],
        repairNodeKey: 'scout-repair', repairTaskId: 'child-repair',
        verifierVersion: 'agent-harness.v2.task-graph-verifier.v1', evidenceDigest: repairReport.evidenceDigest,
      },
    }
    const ledger = projectPlanLedger({
      sessionId, revision: 5, rootTaskId, graph: typedGraph,
      tasks: [
        rows[0]!,
        { id: 'child-scout', sessionId, status: 'completed', role: 'scout', goal: 'Find Dublin backend jobs', result: scoutResult },
        { id: 'child-analyst', sessionId, status: 'completed', role: 'analyst', goal: 'Score the findings', result: analystResult },
        { id: 'child-repair', sessionId, status: 'completed', role: 'scout', goal: 'Repair Scout evidence', result: repairResult },
      ],
    })
    expect(ledger).not.toBeNull()
    if (!ledger) throw new Error('expected projected Plan Ledger')
    const forbidden = new Set([
      'verification', 'verificationDisposition', 'repairOf', 'taskGraphVerificationReport', 'taskGraphRepairReceipt',
    ])
    const inspect = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(inspect)
      } else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          expect(forbidden.has(key)).toBe(false)
          inspect(child)
        }
      }
    }
    inspect(ledger)
    expect(ledger.nodes.find(node => node.key === 'scout')?.evidencePreview).toMatchObject({
      role: 'scout', itemCount: 1, evidence: [{ source: 'greenhouse', reference: null }],
    })
    expect(ledger.nodes.find(node => node.key === 'analyse')?.evidencePreview).toMatchObject({
      role: 'analyst', itemCount: 1, evidence: [{ source: 'lever', reference: null }],
    })
    expect(ledger.nodes.find(node => node.key === 'scout-repair')?.evidencePreview).toMatchObject({
      role: 'scout', itemCount: 1, evidence: [{ source: 'greenhouse', reference: null }],
    })
    const serialized = JSON.stringify(ledger)
    for (const privateValue of ['candidate-count', 'finding-count', 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64),
      'PRIVATE_RAW_MODEL_PROSE', 'PRIVATE_ANALYST_TEXT', 'PRIVATE_ANALYST_SUMMARY', 'private-analyst-evidence']) {
      expect(serialized).not.toContain(privateValue)
    }
  })

  it('keeps evidence previews when a valid report and repair receipt are stored beside the result', () => {
    const receipt = {
      schemaVersion: 'agent-harness.v2.task-graph-repair-receipt.v1', graphRootTaskId: rootTaskId,
      targetNodeKey: 'scout', targetTaskId: 'child-scout', criterionIds: ['candidate-count'],
      repairNodeKey: 'scout-repair', repairTaskId: 'child-repair',
      verifierVersion: 'agent-harness.v2.task-graph-verifier.v1', evidenceDigest: verificationReport.evidenceDigest,
    }
    const preview = projectTaskEvidencePreview({
      status: 'completed', role: 'scout',
      result: { ...result, taskGraphVerificationReport: verificationReport, taskGraphRepairReceipt: receipt },
    })
    expect(preview).toMatchObject({ role: 'scout', itemCount: 1, evidence: [{ kind: 'job', source: 'greenhouse', reference: null }] })
    expect(JSON.stringify(preview)).not.toMatch(/verification|repairReceipt|candidate-count|evidenceDigest/)
  })

  it('accepts Worker-generated final item IDs up to 256 without widening graph IDs', () => {
    const taskId = `subagent-${'0'.repeat(36)}`
    const jobId = 'private-job-77'
    const cases = [
      {
        role: 'scout' as const, criterionId: 'candidate-count',
        structuredResult: {
          schemaVersion: 'agent-harness.v2.subagent.result', role: 'scout', status: 'completed',
          candidates: [{ jobId, source: 'fixture', url: null, evidenceIds: ['private-evidence-1'] }],
          evidence: [{ id: 'private-evidence-1', kind: 'job', ref: jobId, source: 'greenhouse' }], summary: 'one candidate',
        },
      },
      {
        role: 'analyst' as const, criterionId: 'finding-count',
        structuredResult: {
          schemaVersion: 'agent-harness.v2.subagent.result', role: 'analyst', status: 'completed',
          findings: [{ jobId, score: 8, evidenceIds: ['private-evidence-1'] }],
          evidence: [{ id: 'private-evidence-1', kind: 'job', ref: jobId, source: 'greenhouse' }], summary: 'one finding',
        },
      },
    ]
    for (const item of cases) {
      const finalItemId = workerFinalItemId(taskId)
      expect(finalItemId).toHaveLength(139)
      const result = {
        status: 'completed', stepCount: 2, toolCallCount: 1, finalItemId,
        finalText: JSON.stringify(item.structuredResult), structuredResult: item.structuredResult,
        taskGraphVerificationReport: {
          verifierVersion: 'agent-harness.v2.task-graph-verifier.v1', status: 'passed', reasonCode: 'criteria_met',
          criteria: [{ criterionId: item.criterionId, status: 'passed', reasonCode: 'criteria_met' }],
          evidenceDigest: 'a'.repeat(64), resultDigest: 'b'.repeat(64),
        },
      }
      const project = (value: unknown) => projectTaskEvidencePreview({ status: 'completed', role: item.role, result: { ...result, finalItemId: value } })
      const preview = project(finalItemId)
      expect(preview).toMatchObject({ role: item.role, itemCount: 1 })
      expect(JSON.stringify(preview)).not.toContain(finalItemId)
      expect(preview && 'finalItemId' in preview).toBe(false)
      const maxLengthPreview = project('x'.repeat(256))
      expect(maxLengthPreview).not.toBeNull()
      expect(JSON.stringify(maxLengthPreview)).not.toContain('x'.repeat(256))
      for (const malformed of ['', '   ', ' x ', 'x'.repeat(257), 123]) expect(project(malformed)).toBeNull()
    }
    expect(parseTaskGraphSnapshot({
      ...graph, nodes: graph.nodes.map((node, index) => index === 0 ? { ...node, taskId: 'x'.repeat(129) } : node),
    })).toBeNull()
  })

  it('counts accepted verifier metadata against the raw result size cap before discarding it', () => {
    const makeEnvelope = (count: number) => {
      const evidence = Array.from({ length: count }, (_, index) => ({
        id: 'evidence-' + index, kind: index === 0 ? 'job' : 'persona',
        ref: index === 0 ? 'private-job-77' : 'r'.repeat(128), source: 's'.repeat(128),
      }))
      return {
        ...result, finalText: 'f'.repeat(8_192),
        structuredResult: {
          ...result.structuredResult, summary: 's'.repeat(8_192),
          candidates: [{ jobId: 'private-job-77', source: 'greenhouse', url: 'u'.repeat(2_048), evidenceIds: evidence.map(item => item.id) }],
          evidence,
        },
      }
    }
    const underLimit = Array.from({ length: 50 }, (_, index) => makeEnvelope(index + 1))
      .filter(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 24 * 1024).at(-1)
    expect(underLimit).toBeDefined()
    expect(projectTaskEvidencePreview({ status: 'completed', role: 'scout', result: underLimit })).not.toBeNull()
    const withMetadata = {
      ...underLimit!, taskGraphVerificationReport: verificationReport,
      taskGraphRepairReceipt: {
        schemaVersion: 'agent-harness.v2.task-graph-repair-receipt.v1', graphRootTaskId: rootTaskId,
        targetNodeKey: 'scout', targetTaskId: 'child-scout', criterionIds: ['candidate-count'],
        repairNodeKey: 'scout-repair', repairTaskId: 'child-repair',
        verifierVersion: 'agent-harness.v2.task-graph-verifier.v1', evidenceDigest: verificationReport.evidenceDigest,
      },
    }
    expect(new TextEncoder().encode(JSON.stringify(withMetadata)).byteLength).toBeGreaterThan(24 * 1024)
    expect(projectTaskEvidencePreview({ status: 'completed', role: 'scout', result: withMetadata })).toBeNull()
  })

  it('counts accepted verifier metadata against the raw graph size cap before stripping it', () => {
    const keys = Array.from({ length: 8 }, (_, index) => 'node-' + index + '-' + 'k'.repeat(90))
    const large = {
      schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
      nodes: keys.map((key, index) => ({
        key, templateId: 'scout', taskId: 'task-' + index + '-' + 't'.repeat(90), goal: 'g'.repeat(1_200),
        successCriteria: Array.from({ length: 8 }, () => 'c'.repeat(320)),
        dependsOn: keys.slice(0, index), depth: index + 1, verificationDisposition: 'typed',
        verification: {
          schemaVersion: verification.schemaVersion, role: 'scout',
          criteria: Array.from({ length: 8 }, (_, criterionIndex) => ({
            id: 'c' + criterionIndex + 'x'.repeat(62), check: { kind: 'evidence_count_gte', minimum: 50 },
          })),
        },
      })),
    }
    const baseGraph = { ...large, nodes: large.nodes.map(({ verification: _verification, verificationDisposition: _disposition, ...node }) => node) }
    expect(new TextEncoder().encode(JSON.stringify(baseGraph)).byteLength).toBeLessThan(40_000)
    expect(new TextEncoder().encode(JSON.stringify(large)).byteLength).toBeGreaterThan(40_000)
    expect(parseTaskGraphSnapshot(large)).toBeNull()
    expect(parseTaskGraphSnapshot(JSON.stringify(large))).toBeNull()
  })

  it('keeps the Plan Ledger projection strict about canonical TaskGraph identifiers', () => {
    const first = graph.nodes[0]!
    const invalidGraphs = [
      { ...graph, nodes: [{ ...first, taskId: ' child-scout ' }, graph.nodes[1]!] },
      { ...graph, nodes: [{ ...first, templateId: ' scout ' }, graph.nodes[1]!] },
    ]

    for (const invalidGraph of invalidGraphs) {
      expect(projectPlanLedger({ sessionId, revision: 4, rootTaskId, graph: invalidGraph, tasks: rows })).toBeNull()
    }
  })

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
    expect(projectTaskEvidencePreview({ status: ['completed'], role: 'scout', result })).toBeNull()
    expect(projectTaskEvidencePreview({ status: 'completed', role: ['scout'], result })).toBeNull()
    expect(projectTaskEvidencePreview({ status: 'completed', role: 'scout', result: {
      ...result, structuredResult: { ...result.structuredResult, status: ['completed'] },
    } })).toBeNull()
    const ledger = projection()!
    expect(parsePlanLedger({
      ...ledger, nodes: ledger.nodes.map((node, index) => index === 0 ? { ...node, readiness: ['terminal'] } : node),
    })).toBeNull()
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
