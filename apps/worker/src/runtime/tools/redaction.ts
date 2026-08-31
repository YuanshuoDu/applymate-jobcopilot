import { createHash } from "node:crypto"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { redactSensitiveValue } from "@jobcopilot/shared"
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
    const encoded = JSON.stringify(value)
    const sha256 = createHash("sha256").update(encoded).digest("hex")
    const ref = `tool-result:${sha256.slice(0, 24)}`
    if (!this.values.has(ref) && this.values.size >= this.maxEntries) this.values.delete(this.values.keys().next().value as string)
    this.values.set(ref, value)
    return { ref, sizeBytes: Buffer.byteLength(encoded), sha256 }
  }

  get(ref: string): RepositoryJsonValue | undefined {
    return this.values.get(ref)
  }
}

export async function sanitizeForLifecycle(
  value: unknown,
  references: ToolResultReferenceStore,
  maxBytes = DEFAULT_MAX_LIFECYCLE_BYTES,
): Promise<RepositoryJsonValue> {
  const safe = redactSensitiveValue(value)
  const encoded = JSON.stringify(safe)
  if (Buffer.byteLength(encoded) <= maxBytes) return safe
  const reference = await references.put(safe)
  return { $ref: reference.ref, sizeBytes: reference.sizeBytes, sha256: reference.sha256 }
}
