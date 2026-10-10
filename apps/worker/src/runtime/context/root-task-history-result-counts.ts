const PROJECTION_SCHEMA = "agent-harness.v2.task-graph.result-projection"
const MAX_SAMPLES = 3
const SOURCES = new Set(["greenhouse", "lever", "workday", "smartrecruiters", "personio", "other"])
const EVIDENCE_KINDS = new Set(["job", "persona", "resume", "source"])
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/

export type RootTaskHistoryReportedOutput =
  | Readonly<{ role: "scout"; candidateCount: number; resultStatus: "completed" | "partial" }>
  | Readonly<{ role: "analyst"; findingCount: number; resultStatus: "completed" | "partial" }>

type Row = Record<string, unknown>

function exactDataRecord(value: unknown, keys: string): Row | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const prototype = Object.getPrototypeOf(value), own = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || own.some(key => typeof key !== "string")
      || [...own].sort().join(",") !== keys) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value), result: Row = Object.create(null) as Row
    for (const key of own as string[]) {
      const descriptor = descriptors[key]
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined
      result[key] = descriptor.value
    }
    return result
  } catch { return undefined }
}

function safeArray(value: unknown, maximum: number): unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined
    const own = Reflect.ownKeys(value), length = Object.getOwnPropertyDescriptor(value, "length")?.value
    if (!Number.isSafeInteger(length) || Number(length) < 0 || Number(length) > maximum
      || own.length !== Number(length) + 1 || own.some(key => typeof key !== "string")) return undefined
    const result: unknown[] = []
    for (let index = 0; index < Number(length); index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined
      result.push(descriptor.value)
    }
    return result
  } catch { return undefined }
}

function count(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function evidenceKinds(value: unknown): boolean {
  const values = safeArray(value, EVIDENCE_KINDS.size)
  return !!values && values.every(item => typeof item === "string" && EVIDENCE_KINDS.has(item))
    && new Set(values).size === values.length
}
function scoutSample(value: unknown): boolean {
  const item = exactDataRecord(value, "evidenceKinds,jobId,source")
  return !!item && typeof item.jobId === "string" && SAFE_JOB_ID.test(item.jobId)
    && typeof item.source === "string" && SOURCES.has(item.source) && evidenceKinds(item.evidenceKinds)
}
function analystSample(value: unknown): boolean {
  const item = exactDataRecord(value, "evidenceKinds,jobId,score")
  return !!item && typeof item.jobId === "string" && SAFE_JOB_ID.test(item.jobId)
    && typeof item.score === "number" && Number.isFinite(item.score) && item.score >= 0 && item.score <= 10
    && evidenceKinds(item.evidenceKinds)
}
function header(item: Row | undefined, role: "scout" | "analyst"): item is Row & { status: "completed" | "partial" } {
  return !!item && item.schemaVersion === PROJECTION_SCHEMA && item.trust === "untrusted"
    && item.availability === "available" && item.role === role
    && (item.status === "completed" || item.status === "partial") && count(item.evidenceCount)
}

/** Reconstructs only the closed historical count/status fact from a server-built result projection. */
export function parseRootTaskHistoryReportedOutput(
  value: unknown,
  expectedRole: "scout" | "analyst",
): RootTaskHistoryReportedOutput | undefined {
  if (expectedRole === "scout") {
    const item = exactDataRecord(value, "availability,candidateCount,candidates,evidenceCount,role,schemaVersion,status,trust")
    if (!header(item, "scout") || !count(item.candidateCount)) return undefined
    const candidates = safeArray(item.candidates, MAX_SAMPLES)
    if (!candidates || candidates.length !== Math.min(item.candidateCount, MAX_SAMPLES) || candidates.some(value => !scoutSample(value))) return undefined
    return { role: "scout", candidateCount: item.candidateCount, resultStatus: item.status }
  }
  const item = exactDataRecord(value, "availability,evidenceCount,findingCount,findings,role,schemaVersion,status,trust")
  if (!header(item, "analyst") || !count(item.findingCount)) return undefined
  const findings = safeArray(item.findings, MAX_SAMPLES)
  if (!findings || findings.length !== Math.min(item.findingCount, MAX_SAMPLES) || findings.some(value => !analystSample(value))) return undefined
  return { role: "analyst", findingCount: item.findingCount, resultStatus: item.status }
}
