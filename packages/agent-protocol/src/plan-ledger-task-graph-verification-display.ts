import { parsePlanLedger, parseTaskGraphSnapshot, type PlanLedger } from "./plan-ledger.js"
import { parsePersistedTaskGraphNode } from "./plan-ledger-task-graph-metadata.js"
import { hasCurrentTaskGraphVerificationLineage } from "./plan-ledger-task-graph-verification-lineage.js"

export const TASK_GRAPH_VERIFICATION_DISPLAY_VERSION = 1 as const
type VerificationStatus = "passed" | "failed" | "unverified"
type CheckStatus = VerificationStatus
type CountCheck = Readonly<{ kind: "candidate_count_gte" | "finding_count_gte" | "evidence_count_gte"; minimum: number; status: CheckStatus }>
type EvidenceCheck = Readonly<{ kind: "all_candidates_have_evidence" | "all_findings_have_evidence"; minimumItems: number; status: CheckStatus }>
type ScoreCheck = Readonly<{ kind: "reported_score_gte"; minimumScore: number; minimumFindings: number; aggregation: "any" | "all"; status: CheckStatus }>
type DependencyCheck = Readonly<{ kind: "findings_from_scout_dependency"; status: CheckStatus }>
type CoverageCheck = Readonly<{ kind: "findings_cover_scout_candidates_gte"; minimumPercent: number; status: CheckStatus }>
export type TaskGraphVerificationDisplayCheck = CountCheck | EvidenceCheck | ScoreCheck | DependencyCheck | CoverageCheck
export type TaskGraphVerificationDisplayNode = null | Readonly<{ status: "unavailable" }> | Readonly<{
  status: VerificationStatus
  checks: readonly TaskGraphVerificationDisplayCheck[]
  totalCount: number
  passedCount: number
  failedCount: number
  unverifiedCount: number
}>
export type TaskGraphVerificationSummary = Readonly<{
  schemaVersion: typeof TASK_GRAPH_VERIFICATION_DISPLAY_VERSION
  nodes: readonly TaskGraphVerificationDisplayNode[]
}>

type RawNode = Record<string, unknown>
type Scope = Readonly<{ sessionId: string; turnId: string; rootTaskId: string; revision: number; graph: unknown; tasks: readonly unknown[];
  digestCanonicalJson?: (canonicalJson: string) => string | null }>

/** Projects current owner-scoped rows into a display-only, identifier-free positional summary. */
export function projectTaskGraphVerificationSummary(input: Scope, projection: PlanLedger): TaskGraphVerificationSummary | null {
  try {
    if (!id(input.sessionId) || !id(input.turnId) || !id(input.rootTaskId) || !Number.isSafeInteger(input.revision) || input.revision < 1) return null
    const plan = parsePlanLedger(projection)
    const graph = record(parseJsonValue(input.graph))
    if (!plan || plan.sessionId !== input.sessionId || plan.revision !== input.revision || !graph || !exact(graph, "nodes,schemaVersion")
      || graph.schemaVersion !== "agent-harness.v2.task-graph" || !dense(graph.nodes, 1, 8)) return null
    const snapshot = parseTaskGraphSnapshot(graph)
    if (!snapshot || snapshot.nodes.length !== plan.nodes.length || snapshot.nodes.some((node, index) => node.key !== plan.nodes[index]?.key)) return null
    const rawNodes = graph.nodes.map(record)
    if (rawNodes.some(node => !node)) return null
    const rows = taskRows(input.tasks, input, snapshot.nodes.map(node => node.taskId))
    if (!rows) return null
    if (!rawNodes.some(node => node && hasTypedContract(node))) return null
    const nodes = rawNodes.map(rawNode => {
      if (!rawNode || !hasTypedContract(rawNode)) return null
      const node = parsePersistedTaskGraphNode(rawNode)
      const row = node ? rows.get(node.taskId) : undefined
      return node && row ? projectNode(rawNode, node, row, rawNodes, snapshot.nodes.map(item => item.taskId), rows, input.rootTaskId, input.digestCanonicalJson) : { status: "unavailable" } as const
    })
    return parseTaskGraphVerificationSummary({ schemaVersion: 1, nodes }, plan.nodes.length)
  } catch { return null }
}

/** Parses the untrusted web-local sidecar without accepting raw Worker fields or identifiers. */
export function parseTaskGraphVerificationSummary(value: unknown, expectedNodeCount: number): TaskGraphVerificationSummary | null {
  try {
    const summary = record(value)
    if (!summary || !exact(summary, "nodes,schemaVersion") || summary.schemaVersion !== 1
      || !Number.isSafeInteger(expectedNodeCount) || expectedNodeCount < 1 || expectedNodeCount > 8
      || !dense(summary.nodes, expectedNodeCount, expectedNodeCount)) return null
    const nodes: TaskGraphVerificationDisplayNode[] = []
    for (const raw of summary.nodes) {
      if (raw === null) { nodes.push(null); continue }
      const node = record(raw)
      if (!node) return null
      if (exact(node, "status") && node.status === "unavailable") { nodes.push({ status: "unavailable" }); continue }
      if (!exact(node, "checks,failedCount,passedCount,status,totalCount,unverifiedCount")
        || !(node.status === "passed" || node.status === "failed" || node.status === "unverified")
        || !dense(node.checks, 1, 8) || ![node.totalCount, node.passedCount, node.failedCount, node.unverifiedCount].every(value => integer(value, 8))) return null
      const checks: TaskGraphVerificationDisplayCheck[] = []
      for (const rawCheck of node.checks) {
        const check = parseDisplayCheck(rawCheck)
        if (!check) return null
        checks.push(check)
      }
      const counts = countStatuses(checks)
      if (node.totalCount !== checks.length || node.passedCount !== counts.passedCount || node.failedCount !== counts.failedCount
        || node.unverifiedCount !== counts.unverifiedCount || node.status === "passed" && counts.passedCount !== checks.length
        || node.status === "failed" && (counts.failedCount === 0 || counts.unverifiedCount > 0)
        || node.status === "unverified" && !(counts.passedCount === checks.length || counts.unverifiedCount === checks.length)) return null
      nodes.push({ status: node.status, checks, totalCount: checks.length, ...counts })
    }
    return { schemaVersion: 1, nodes }
  } catch { return null }
}

function projectNode(raw: RawNode, node: NonNullable<ReturnType<typeof parsePersistedTaskGraphNode>>, row: RawNode,
  graphNodes: readonly (RawNode | null)[], taskIds: readonly string[], rows: Map<string, RawNode>, rootTaskId: string,
  digestCanonicalJson?: (canonicalJson: string) => string | null): TaskGraphVerificationDisplayNode {
  const contract = record(raw.verification)
  if (!contract || row.role !== contract.role) return { status: "unavailable" }
  const result = parseJsonRecord(row.result)
  if (!result || !Object.hasOwn(result, "taskGraphVerificationReport")) return { status: "unavailable" }
  const report = record(result.taskGraphVerificationReport)
  const expected = criteriaRecords(contract.criteria), reportCriteria = report && criteriaRecords(report.criteria)
  if (!report || !expected || !reportCriteria || !hasCurrentTaskGraphVerificationLineage({ rawNode: raw, node, row, result, report, expected, actual: reportCriteria,
    graphNodes, taskIds, rows, rootTaskId, digestCanonicalJson })) return { status: "unavailable" }
  const checks = expected.map((criterion, index) => displayCheck(record(criterion.check), reportCriteria[index]?.status))
  if (checks.some(check => !check)) return { status: "unavailable" }
  const normalized = checks as TaskGraphVerificationDisplayCheck[]
  return { status: report.status as VerificationStatus, checks: normalized, totalCount: normalized.length, ...countStatuses(normalized) }
}

function displayCheck(check: RawNode | null, status: unknown): TaskGraphVerificationDisplayCheck | null {
  if (!check || !(status === "passed" || status === "failed" || status === "unverified") || typeof check.kind !== "string") return null
  if (["candidate_count_gte", "finding_count_gte", "evidence_count_gte"].includes(check.kind))
    return exact(check, "kind,minimum") && integer(check.minimum, 50, 1) ? { kind: check.kind as CountCheck["kind"], minimum: check.minimum as number, status } : null
  if (["all_candidates_have_evidence", "all_findings_have_evidence"].includes(check.kind))
    return exact(check, "kind,minimumItems") && integer(check.minimumItems, 50, 1) ? { kind: check.kind as EvidenceCheck["kind"], minimumItems: check.minimumItems as number, status } : null
  if (check.kind === "reported_score_gte" && exact(check, "aggregation,kind,minimumFindings,minimumScore")
    && integer(check.minimumFindings, 50, 1) && typeof check.minimumScore === "number" && Number.isFinite(check.minimumScore)
    && check.minimumScore >= 0 && check.minimumScore <= 10 && (check.aggregation === "any" || check.aggregation === "all")) {
    return { kind: "reported_score_gte", minimumScore: check.minimumScore, minimumFindings: check.minimumFindings as number, aggregation: check.aggregation, status }
  }
  if (check.kind === "findings_cover_scout_candidates_gte" && exact(check, "dependencyNodeKey,kind,minimumPercent")
    && id(check.dependencyNodeKey) && integer(check.minimumPercent, 100, 1)) {
    return { kind: "findings_cover_scout_candidates_gte", minimumPercent: check.minimumPercent, status }
  }
  return check.kind === "findings_from_scout_dependency" && exact(check, "dependencyNodeKey,kind")
    && id(check.dependencyNodeKey) ? { kind: "findings_from_scout_dependency", status } : null
}

function parseDisplayCheck(value: unknown): TaskGraphVerificationDisplayCheck | null {
  const check = record(value)
  if (!check || typeof check.status !== "string") return null
  if (check.kind === "findings_from_scout_dependency" && exact(check, "kind,status")
    && ["passed", "failed", "unverified"].includes(check.status)) return { kind: check.kind, status: check.status as CheckStatus }
  if (check.kind === "findings_cover_scout_candidates_gte") {
    if (!exact(check, "kind,minimumPercent,status") || !["passed", "failed", "unverified"].includes(check.status)
      || !integer(check.minimumPercent, 100, 1)) return null
    return { kind: check.kind, minimumPercent: check.minimumPercent, status: check.status as CheckStatus }
  }
  const { status, ...descriptor } = check
  return displayCheck(descriptor, status)
}

function taskRows(values: readonly unknown[], scope: Scope, taskIds: readonly string[]): Map<string, RawNode> | null {
  if (!Array.isArray(values) || !dense(values, 0, 9)) return null
  const rows = new Map<string, RawNode>(), allowed = new Set([scope.rootTaskId, ...taskIds])
  for (const value of values) {
    const row = record(value)
    if (!row || !id(row.id) || !allowed.has(row.id) || row.sessionId !== scope.sessionId || row.turnId !== scope.turnId
      || row.rootTaskId !== scope.rootTaskId || rows.has(row.id)) return null
    rows.set(row.id, row)
  }
  return rows
}

function hasTypedContract(node: RawNode): boolean {
  return Object.hasOwn(node, "verification") && (node.verificationDisposition === undefined || node.verificationDisposition === "typed")
}
function countStatuses(checks: readonly TaskGraphVerificationDisplayCheck[]) {
  return { passedCount: checks.filter(check => check.status === "passed").length, failedCount: checks.filter(check => check.status === "failed").length,
    unverifiedCount: checks.filter(check => check.status === "unverified").length }
}
function parseJsonValue(value: unknown): unknown { return typeof value === "string" ? JSON.parse(value) as unknown : value }
function parseJsonRecord(value: unknown): RawNode | null { const parsed = parseJsonValue(value); return record(parsed) }
function criteriaRecords(value: unknown): RawNode[] | null {
  if (!Array.isArray(value)) return null
  const items = value.map(record)
  return items.every((item): item is RawNode => item !== null) ? items : null
}
function record(value: unknown): RawNode | null {
  try { return value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Reflect.ownKeys(value).every(key => typeof key === "string") ? value as RawNode : null } catch { return null }
}
function exact(value: RawNode, keys: string): boolean { return Reflect.ownKeys(value).sort().join(",") === keys }
function dense(value: unknown, min: number, max: number): value is unknown[] {
  return Array.isArray(value) && value.length >= min && value.length <= max && Reflect.ownKeys(value).length === value.length + 1
    && Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, String(index))).every(Boolean)
}
function integer(value: unknown, max: number, min = 0): value is number { return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max }
function id(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 128 }
