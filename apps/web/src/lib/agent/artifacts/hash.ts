import { createHash } from 'node:crypto'

export class ArtifactHashError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArtifactHashError'
  }
}

/** Canonical JSON is shared with the Worker artifact adapter. */
export function canonicalArtifactJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ArtifactHashError('Artifact content contains a non-finite number.')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalArtifactJson).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalArtifactJson(child)}`).join(',')}}`
  }
  throw new ArtifactHashError('Artifact content must be JSON-compatible.')
}

export function hashArtifactContent(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalArtifactJson(value)).digest('hex')}`
}

export function hashArtifactConstraints(value: unknown): string {
  return hashArtifactContent({ constraintSet: value })
}
