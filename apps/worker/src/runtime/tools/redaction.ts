import { createHash } from "node:crypto"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { canonicalJson, redactSensitiveValue } from "@jobcopilot/shared"
export const DEFAULT_MAX_LIFECYCLE_BYTES = 8 * 1024

export interface ToolResultReference {
  readonly ref: string
  readonly sizeBytes: number
  readonly sha256: string
}
export interface ToolResultReferenceStore {
  put(value: RepositoryJsonValue): Promise<ToolResultReference>
}

export class InMemoryToolResultReferenceStore implements ToolResultReferenceStore {
  private readonly values = new Map<string, RepositoryJsonValue>()

  constructor(private readonly maxEntries = 256) {}

  async put(value: RepositoryJsonValue): Promise<ToolResultReference> {
    const encoded = canonicalJson(value)
    const sha256 = createHash("sha256").update(encoded, "utf8").digest("hex")
    const ref = `tool-result:${sha256.slice(0, 24)}`
    if (!this.values.has(ref) && this.values.size >= this.maxEntries) this.values.delete(this.values.keys().next().value as string)
    this.values.set(ref, value)
    return { ref, sizeBytes: Buffer.byteLength(encoded), sha256 }
  }

  get(ref: string): RepositoryJsonValue | undefined {
    return this.values.get(ref)
  }
}

export type PreparedLifecycleValue = {
  readonly safe: RepositoryJsonValue
  readonly encoded: string
  readonly sizeBytes: number
  readonly sha256: string
}

export function prepareLifecycleValue(value: unknown): PreparedLifecycleValue {
  const safe = redactSensitiveValue(value)
  const encoded = canonicalJson(safe)
  return {
    safe,
    encoded,
    sizeBytes: Buffer.byteLength(encoded, "utf8"),
    sha256: createHash("sha256").update(encoded, "utf8").digest("hex"),
  }
}

export function sanitizeLifecyclePreview(value: unknown, maxBytes = DEFAULT_MAX_LIFECYCLE_BYTES): RepositoryJsonValue {
  const prepared = prepareLifecycleValue(value)
  if (prepared.sizeBytes <= maxBytes) return prepared.safe
  return {
    $truncated: true,
    sizeBytes: prepared.sizeBytes,
    sha256: prepared.sha256,
    summary: "Payload omitted from the lifecycle event because it exceeds its inline byte limit",
  }
}

export async function sanitizeForLifecycle(
  value: unknown,
  _references: ToolResultReferenceStore,
  maxBytes = DEFAULT_MAX_LIFECYCLE_BYTES,
): Promise<RepositoryJsonValue> {
  return sanitizeLifecyclePreview(value, maxBytes)
}
