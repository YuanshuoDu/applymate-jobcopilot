/** Browser-safe public commitment contract for one private TaskGraph artifact reference. */
export const TASK_GRAPH_FINAL_ARTIFACT_MANIFEST_SCHEMA = "agent-harness.v2.task-graph-sources.v3" as const

export type FinalTaskGraphArtifactRef = Readonly<{
  artifactId: string
  version: number
  contentHash: string
  sourceDigest: string
}>

const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256 = /^sha256:[a-f0-9]{64}$/
const SOURCE_KEY = /^src_[A-Za-z0-9_-]{43}$/
const VERSION_PROOF = /^avp_[a-f0-9]{64}$/

/** Copies only the closed, JSON-safe reference shape used by final artifact proofs. */
export function parseFinalTaskGraphArtifactRef(value: unknown): FinalTaskGraphArtifactRef | null {
  const row = snapshotRecord(value, ["artifactId", "version", "contentHash", "sourceDigest"])
  if (!row || typeof row.artifactId !== "string" || !ARTIFACT_ID.test(row.artifactId)
    || !Number.isSafeInteger(row.version) || Number(row.version) < 1
    || typeof row.contentHash !== "string" || !SHA256.test(row.contentHash)
    || typeof row.sourceDigest !== "string" || !SHA256.test(row.sourceDigest)) return null
  return { artifactId: row.artifactId, version: Number(row.version), contentHash: row.contentHash, sourceDigest: row.sourceDigest }
}

export function isFinalTaskGraphArtifactVersionProof(value: unknown): value is string {
  return typeof value === "string" && VERSION_PROOF.test(value)
}

/** Canonical JSON tuple shared by browser and server SHA-256 implementations. */
export function finalTaskGraphArtifactProofInput(sourceKey: string, value: FinalTaskGraphArtifactRef): string {
  if (typeof sourceKey !== "string" || !SOURCE_KEY.test(sourceKey)) throw new Error("task_graph_final_source_key_invalid")
  const artifactRef = parseFinalTaskGraphArtifactRef(value)
  if (!artifactRef) throw new Error("task_graph_final_artifact_ref_invalid")
  return JSON.stringify(["taskGraphSourceArtifact:v1", sourceKey, artifactRef.artifactId, artifactRef.version,
    artifactRef.contentHash, artifactRef.sourceDigest])
}

function snapshotRecord(value: unknown, expected: readonly string[]): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || keys.length !== expected.length) return null
    const snapshot: Record<string, unknown> = {}
    for (const key of keys) {
      if (typeof key !== "string" || !expected.includes(key)) return null
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null
      snapshot[key] = descriptor.value
    }
    return snapshot
  } catch { return null }
}
