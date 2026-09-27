export const PLAN_LEDGER_SCHEMA_VERSION = 'agent-harness.v2.plan-ledger'

const GRAPH_VERSION = 'agent-harness.v2.task-graph', RESULT_VERSION = 'agent-harness.v2.subagent.result'
const MAX_NODES = 8, MAX_ID = 128, MAX_LEDGER_BYTES = 16_000
const STATUSES = ['queued', 'running', 'retrying', 'waiting', 'waiting_for_user', 'completed', 'failed', 'interrupted', 'cancelled', 'closed'] as const
const TERMINAL = new Set(['completed', 'failed', 'interrupted', 'cancelled', 'closed'])
const BLOCKING = new Set(['failed', 'interrupted', 'cancelled', 'closed'])
const SOURCES = new Set(['greenhouse', 'lever', 'workday', 'smartrecruiters', 'personio', 'jobs.search', 'persona.retrieve', 'resume.retrieve'])
const KINDS = ['job', 'persona', 'resume', 'source'] as const

export type PlanLedgerStatus = typeof STATUSES[number]
export type PlanLedgerReadiness = 'ready' | 'waiting_for_dependencies' | 'blocked_dependency' | 'active' | 'terminal' | 'unavailable'
export type PlanLedgerEvidencePreview = Readonly<{
  role: 'scout' | 'analyst'
  summary: string
  itemCount: number
  evidence: readonly Readonly<{ kind: typeof KINDS[number]; source: string; reference: null }>[]
}>
export type PlanLedger = Readonly<{ schemaVersion: typeof PLAN_LEDGER_SCHEMA_VERSION; sessionId: string; revision: number; goal: string | null; nodes: readonly Readonly<{
  key: string; goal: string; status: PlanLedgerStatus | null; resultAvailable: boolean; evidencePreview: PlanLedgerEvidencePreview | null
  readiness: PlanLedgerReadiness; dependencies: readonly Readonly<{ key: string; label: string; status: PlanLedgerStatus | null }>[]
}>[] }>
interface TextEncoderLike { encode(input: string): Uint8Array }
const RuntimeTextEncoder = (globalThis as typeof globalThis & { TextEncoder?: new () => TextEncoderLike }).TextEncoder

/** Converts persisted graph/task records into the bounded public Workbench contract. */
export function projectPlanLedger(value: unknown): PlanLedger | null {
  try {
    if (!record(value) || !identifier(value.sessionId) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
      || (value.rootTaskId !== null && !identifier(value.rootTaskId)) || !dense(value.tasks, MAX_NODES + 1)) return null
    const graph = parseGraph(value.graph)
    if (!graph || graph.nodes.length === 0 || value.tasks.length > MAX_NODES + 1) return null
    const tasks = new Map<string, Record<string, unknown>>()
    for (const row of value.tasks) {
      if (!record(row) || row.sessionId !== value.sessionId || !identifier(row.id)) continue
      const previous = tasks.get(row.id)
      const currentTime = timestamp(row.updatedAt), previousTime = timestamp(previous?.updatedAt)
      if (!previous || (Number.isFinite(currentTime) && Number.isFinite(previousTime) && currentTime > previousTime)) tasks.set(row.id, row)
    }
    const selected = (id: string) => tasks.get(id)
    const root = value.rootTaskId ? selected(value.rootTaskId) : undefined
    const statuses = new Map(graph.nodes.map(node => [node.key, taskStatus(selected(node.taskId)?.status)] as const))
    const nodes = graph.nodes.map(node => {
      const task = selected(node.taskId)
      const status = statuses.get(node.key) ?? null
      const preview = status === 'completed' ? projectTaskEvidencePreview(task ?? null) : null
      return { key: node.key, goal: displayText(task?.goal) || displayText(node.goal), status,
        resultAvailable: task?.hasResult === true || (task && task.result !== null && task.result !== undefined) || false,
        evidencePreview: preview, readiness: readiness(node, status, statuses, graph.nodes),
        dependencies: node.dependsOn.map(key => {
          const dependency = graph.nodes.find(candidate => candidate.key === key)!, dependencyTask = selected(dependency.taskId)
          return { key, label: displayText(dependencyTask?.goal) || displayText(dependency.goal), status: statuses.get(key) ?? null }
        }) }
    })
    return parsePlanLedger({
      schemaVersion: PLAN_LEDGER_SCHEMA_VERSION,
      sessionId: value.sessionId,
      revision: Number(value.revision),
      goal: displayText(root?.goal) || null,
      nodes,
    })
  } catch { return null }
}

/** Parses the versioned public contract and rejects unknown or unsafe fields. */
export function parsePlanLedger(value: unknown): PlanLedger | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
    if (!record(parsed) || !exact(parsed, ['schemaVersion', 'sessionId', 'revision', 'goal', 'nodes'])
      || parsed.schemaVersion !== PLAN_LEDGER_SCHEMA_VERSION || !identifier(parsed.sessionId)
      || !Number.isSafeInteger(parsed.revision) || Number(parsed.revision) < 1
      || (parsed.goal !== null && !displayTextIsSafe(parsed.goal, 240)) || !dense(parsed.nodes, MAX_NODES) || parsed.nodes.length === 0) return null
    const keys = new Set<string>()
    const nodes: PlanLedger['nodes'][number][] = []
    for (const raw of parsed.nodes) {
      if (!record(raw) || !exact(raw, ['key', 'goal', 'status', 'resultAvailable', 'evidencePreview', 'readiness', 'dependencies'])
        || !identifier(raw.key) || keys.has(raw.key) || !displayTextIsSafe(raw.goal, 240)
        || (raw.status !== null && !isStatus(raw.status)) || typeof raw.resultAvailable !== 'boolean'
        || !isReadiness(raw.readiness) || !dense(raw.dependencies, MAX_NODES) || !safePreview(raw.evidencePreview)) return null
      keys.add(raw.key)
      const dependencies: Array<{ key: string; label: string; status: PlanLedgerStatus | null }> = []
      for (const dependency of raw.dependencies) {
        if (!record(dependency) || !exact(dependency, ['key', 'label', 'status']) || !identifier(dependency.key)
          || !displayTextIsSafe(dependency.label, 240) || (dependency.status !== null && !isStatus(dependency.status))) return null
        dependencies.push({ key: dependency.key, label: dependency.label, status: dependency.status as PlanLedgerStatus | null })
      }
      nodes.push({ key: raw.key, goal: raw.goal, status: raw.status as PlanLedgerStatus | null,
        resultAvailable: raw.resultAvailable, evidencePreview: raw.evidencePreview as PlanLedgerEvidencePreview | null, readiness: raw.readiness, dependencies })
    }
    if (nodes.some(node => new Set(node.dependencies.map(dependency => dependency.key)).size !== node.dependencies.length
      || node.dependencies.some(dependency => !keys.has(dependency.key)))) return null
    if (!acyclic(nodes.map(node => ({ key: node.key, dependsOn: node.dependencies.map(item => item.key) })))) return null
    const result: PlanLedger = { schemaVersion: PLAN_LEDGER_SCHEMA_VERSION, sessionId: parsed.sessionId, revision: Number(parsed.revision),
      goal: parsed.goal as string | null, nodes }
    return bytes(result) <= MAX_LEDGER_BYTES ? result : null
  } catch { return null }
}

/** Produces counts and allowlisted evidence labels; source prose and identifiers never leave this function. */
export function projectTaskEvidencePreview(row: unknown): PlanLedgerEvidencePreview | null {
  try {
    if (!record(row) || (row.status !== 'completed' && row.status !== 'passed') || (row.role !== 'scout' && row.role !== 'analyst')) return null
    if (row.structuredEvidencePreview !== undefined) return parseEvidencePreview(row.structuredEvidencePreview, row.role)
    if (bytes(row.result) > 24 * 1024) return null
    const envelope = parseJsonRecord(row.result)
    if (!envelope || !exact(envelope, ['status', 'stepCount', 'toolCallCount', 'finalItemId', 'finalText', 'structuredResult'])
      || envelope.status !== 'completed' || !smallInteger(envelope.stepCount, 10_000) || !smallInteger(envelope.toolCallCount, 10_000)
      || (envelope.finalItemId !== null && !identifier(envelope.finalItemId)) || typeof envelope.finalText !== 'string'
      || envelope.finalText.length > 8_192) return null
    const result = record(envelope.structuredResult) ? envelope.structuredResult : null
    const role = row.role
    const listKey = role === 'scout' ? 'candidates' : 'findings'
    if (!result || !exact(result, ['schemaVersion', 'role', 'status', listKey, 'evidence', 'summary'])
      || result.schemaVersion !== RESULT_VERSION || result.role !== role || !['completed', 'partial'].includes(String(result.status))
      || typeof result.summary !== 'string' || result.summary.length > 8_192 || !dense(result[listKey], 50) || !dense(result.evidence, 50)) return null
    const evidenceById = new Map<string, { kind: typeof KINDS[number]; source: string; ref: string }>()
    for (const raw of result.evidence) {
      if (!record(raw) || !exact(raw, ['id', 'kind', 'ref', 'source']) || !identifier(raw.id) || !identifier(raw.ref)
        || !identifier(raw.source) || !KINDS.includes(raw.kind as typeof KINDS[number]) || evidenceById.has(raw.id)) return null
      evidenceById.set(raw.id, { kind: raw.kind as typeof KINDS[number], source: raw.source, ref: raw.ref })
    }
    const linked = new Set<string>()
    for (const item of result[listKey]) {
      const expected = role === 'scout' ? ['jobId', 'source', 'url', 'evidenceIds'] : ['jobId', 'score', 'evidenceIds']
      if (!record(item) || !exact(item, expected) || !identifier(item.jobId) || !dense(item.evidenceIds, 50) || item.evidenceIds.length === 0) return null
      if (role === 'scout' && (!identifier(item.source) || (item.url !== null && (typeof item.url !== 'string' || !item.url.trim() || item.url.length > 2_048)))) return null
      if (role === 'analyst' && (typeof item.score !== 'number' || !Number.isFinite(item.score) || item.score < 0 || item.score > 10)) return null
      let linkedJob = false
      for (const id of item.evidenceIds) {
        if (!identifier(id)) return null
        const evidence = evidenceById.get(id)
        if (!evidence || (evidence.kind === 'job' && evidence.ref !== item.jobId)) return null
        if (evidence.kind === 'job' && evidence.ref === item.jobId) linkedJob = true
        linked.add(id)
      }
      if (!linkedJob) return null
    }
    const evidence = [...linked].map(id => evidenceById.get(id)!).slice(0, 5)
      .map(item => ({ kind: item.kind, source: SOURCES.has(item.source) ? item.source : 'other', reference: null as null }))
    const itemCount = result[listKey].length
    const label = role === 'scout' ? 'candidate' : 'finding'
    const completion = result.status === 'partial' ? 'partially completed' : 'completed'
    const summary = `${role === 'scout' ? 'Scout' : 'Analyst'} ${completion}: ${itemCount} ${label}${itemCount === 1 ? '' : 's'}; ${linked.size} linked evidence item${linked.size === 1 ? '' : 's'}.`
    return { role, summary, itemCount, evidence }
  } catch { return null }
}

function parseEvidencePreview(value: unknown, role: unknown): PlanLedgerEvidencePreview | null {
  if (!record(value) || !exact(value, ['role', 'summary', 'itemCount', 'evidence']) || value.role !== role
    || (role !== 'scout' && role !== 'analyst') || !smallInteger(value.itemCount, 50) || !dense(value.evidence, 5)
    || typeof value.summary !== 'string') return null
  const match = /^(Scout|Analyst) (completed|partially completed): (\d+) (candidate|finding)(s?); (\d+) linked evidence item(s?)\.$/.exec(value.summary)
  const label = role === 'scout' ? 'Scout' : 'Analyst', noun = role === 'scout' ? 'candidate' : 'finding'
  if (!match || match[1] !== label || Number(match[3]) !== value.itemCount || match[4] !== noun
    || match[5] !== (Number(match[3]) === 1 ? '' : 's') || match[7] !== (Number(match[6]) === 1 ? '' : 's')) return null
  const evidence: Array<{ kind: typeof KINDS[number]; source: string; reference: null }> = []
  for (const item of value.evidence) {
    if (!record(item) || !exact(item, ['kind', 'source', 'reference']) || !KINDS.includes(item.kind as typeof KINDS[number])
      || typeof item.source !== 'string' || (item.source !== 'other' && !SOURCES.has(item.source)) || item.reference !== null) return null
    evidence.push({ kind: item.kind as typeof KINDS[number], source: item.source, reference: null })
  }
  return { role, summary: value.summary, itemCount: value.itemCount, evidence }
}

function safePreview(value: unknown): value is PlanLedgerEvidencePreview | null {
  if (value === null) return true
  if (!record(value) || !parseEvidencePreview(value, value.role)) return false
  return true
}

function parseGraph(value: unknown): { nodes: Array<{ key: string; goal: string; taskId: string; dependsOn: string[] }> } | null {
  if (!record(value) || !exact(value, ['schemaVersion', 'nodes']) || value.schemaVersion !== GRAPH_VERSION || !dense(value.nodes, MAX_NODES)) return null
  const nodes: Array<{ key: string; goal: string; taskId: string; dependsOn: string[] }> = []
  const keys = new Set<string>(), ids = new Set<string>()
  for (const raw of value.nodes) {
    if (!record(raw) || !exact(raw, ['key', 'templateId', 'goal', 'successCriteria', 'dependsOn', 'depth', 'taskId'])
      || !identifier(raw.key) || !identifier(raw.templateId) || !text(raw.goal, 1_200) || !identifier(raw.taskId)
      || !dense(raw.successCriteria, 8) || raw.successCriteria.length === 0 || !raw.successCriteria.every(item => text(item, 320))
      || !dense(raw.dependsOn, 8) || !raw.dependsOn.every(identifier) || new Set(raw.dependsOn).size !== raw.dependsOn.length
      || !Number.isSafeInteger(raw.depth) || Number(raw.depth) < 1 || Number(raw.depth) > 8 || keys.has(raw.key) || ids.has(raw.taskId)) return null
    keys.add(raw.key); ids.add(raw.taskId); nodes.push({ key: raw.key, goal: raw.goal, taskId: raw.taskId, dependsOn: raw.dependsOn })
  }
  if (nodes.some(node => node.dependsOn.some(key => !keys.has(key))) || !acyclic(nodes)) return null
  return bytes(value) <= 40_000 ? { nodes } : null
}

function readiness(node: { key: string; dependsOn: string[] }, status: PlanLedgerStatus | null,
  statuses: ReadonlyMap<string, PlanLedgerStatus | null>, nodes: readonly { key: string; dependsOn: string[] }[]): PlanLedgerReadiness {
  if (!status) return 'unavailable'
  if (TERMINAL.has(status)) return 'terminal'
  if (status !== 'queued' && status !== 'waiting') return 'active'
  const byKey = new Map(nodes.map(item => [item.key, item] as const))
  const blocked = (key: string, seen = new Set<string>()): boolean => {
    if (seen.has(key)) return false
    seen.add(key)
    const current = byKey.get(key)
    return Boolean(current?.dependsOn.some(dependency => BLOCKING.has(statuses.get(dependency) ?? '') || blocked(dependency, seen)))
  }
  if (blocked(node.key)) return 'blocked_dependency'
  if (!node.dependsOn.every(key => statuses.get(key) === 'completed')) return 'waiting_for_dependencies'
  return status === 'queued' ? 'ready' : 'active'
}

function acyclic(nodes: readonly { key: string; dependsOn: string[] }[]): boolean {
  const visited = new Set<string>(), active = new Set<string>(), byKey = new Map(nodes.map(node => [node.key, node] as const))
  const visit = (key: string): boolean => {
    if (active.has(key)) return false
    if (visited.has(key)) return true
    active.add(key)
    for (const dependency of byKey.get(key)?.dependsOn ?? []) if (!visit(dependency)) return false
    active.delete(key); visited.add(key); return true
  }
  return nodes.every(node => visit(node.key))
}

function taskStatus(value: unknown): PlanLedgerStatus | null { return value === 'passed' ? 'completed' : isStatus(value) ? value : null }
function isStatus(value: unknown): value is PlanLedgerStatus { return typeof value === 'string' && (STATUSES as readonly string[]).includes(value) }
function isReadiness(value: unknown): value is PlanLedgerReadiness { return ['ready', 'waiting_for_dependencies', 'blocked_dependency', 'active', 'terminal', 'unavailable'].includes(String(value)) }
function identifier(value: unknown): value is string { return text(value, MAX_ID) && value.trim() === value }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max }
function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).every(key => typeof key === 'string')
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(value); return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key))
}
function dense(value: unknown, maximum: number): value is unknown[] {
  return Array.isArray(value) && value.length <= maximum && Reflect.ownKeys(value).length === value.length + 1
}
function parseJsonRecord(value: unknown): Record<string, unknown> | null { const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value; return record(parsed) ? parsed : null }
function bytes(value: unknown): number { const encoded = JSON.stringify(value) ?? ''; return RuntimeTextEncoder ? new RuntimeTextEncoder().encode(encoded).byteLength : encoded.length * 3 }
function smallInteger(value: unknown, maximum: number): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum }
function timestamp(value: unknown): number { return typeof value === 'string' ? Date.parse(value) : Number.NaN }
function displayText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return ''
  return value.trim().replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted]')
    .replace(/https?:\/\/[^\s<>]+/gi, url => `[redacted]${/[.,!?;:)]+$/.exec(url)?.[0] ?? ''}`)
    .replace(/(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]){2,}\d{3,}/g, '[redacted]').slice(0, 240)
}
function displayTextIsSafe(value: unknown, maximum: number): value is string {
  return text(value, maximum) && value.trim() === value && !/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)
    && !/https?:\/\/[^\s<>]+/i.test(value) && !/(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]){2,}\d{3,}/.test(value)
}
