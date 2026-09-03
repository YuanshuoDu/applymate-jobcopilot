import { assertRoleAction, assertTaskRole } from "./role-contracts.js"
import { roleProfile } from "./role-profiles.js"
import { artifactRef, type ArtifactDraftWriter, type ArtifactRef } from "./artifact-adapters.js"
import type { SubagentRoleProfile } from "./role-profiles.js"

export type WriterTaskDescriptor = {
  readonly id: string
  readonly rootTaskId: string
  readonly role: string
}

export type WriterTaskInput = {
  readonly task: WriterTaskDescriptor
  readonly artifactType: string
  readonly content: unknown
  readonly artifactId?: string
  readonly sourceHash?: string | null
  readonly expectedPreviousHash?: string | null
}

export type WriterDraftResult = {
  readonly role: "writer"
  readonly taskId: string
  readonly rootTaskId: string
  readonly artifact: ArtifactRef
  readonly profile: SubagentRoleProfile
  readonly draftOnly: true
}

export class WriterTaskHandler {
  constructor(private readonly artifacts: ArtifactDraftWriter) {}

  async run(input: WriterTaskInput): Promise<WriterDraftResult> {
    assertTaskRole(input.task.role, "writer")
    assertRoleAction("writer", input.expectedPreviousHash === undefined ? "artifact.draft.create" : "artifact.draft.replace")
    const draft = await this.artifacts.writeDraft({
      artifactId: input.artifactId,
      artifactType: input.artifactType,
      content: input.content,
      sourceHash: input.sourceHash,
      writerTaskId: input.task.id,
      expectedPreviousHash: input.expectedPreviousHash,
    })
    return {
      role: "writer",
      taskId: input.task.id,
      rootTaskId: input.task.rootTaskId,
      artifact: artifactRef(draft),
      profile: roleProfile("writer"),
      draftOnly: true,
    }
  }
}
