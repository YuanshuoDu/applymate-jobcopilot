import { canonicalJson, hashContent } from '@jobcopilot/shared'

export class ArtifactHashError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArtifactHashError'
  }
}

export const canonicalArtifactJson = canonicalJson

export function hashArtifactContent(value: unknown): string {
  try {
    return hashContent(value)
  } catch (error: unknown) {
    throw new ArtifactHashError(error instanceof Error ? error.message : 'Artifact content is not JSON-compatible.')
  }
}

export function hashArtifactConstraints(value: unknown): string {
  return hashArtifactContent({ constraintSet: value })
}
