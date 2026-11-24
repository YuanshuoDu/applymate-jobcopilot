import { describe, expect, it, vi } from "vitest"
import {
  buildObjectiveApplicationSubmissionManifest, OBJECTIVE_APPLICATION_SUBMISSION_MATERIAL_SCHEMA,
  OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA,
} from "@jobcopilot/shared"
import { hashArtifactContent } from "../runtime/subagents/artifact-adapters.js"
import { recordObjectiveSubmissionManifestWithClient, readObjectiveSubmissionManifestWithClient,
  type ObjectiveSubmissionManifestScope } from "./objective-submission-manifest-event.js"

const scope: ObjectiveSubmissionManifestScope = { userId: "user-1", sessionId: "session-1", applicationTaskId: "application-1",
  jobId: "job-1", fillTurnId: "fill-turn-1" }
const source = { schemaVersion: OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA,
  approvalId: `objective-review:objective-review-${"a".repeat(40)}:1`, reviewTurnId: "review-turn-1", materialProofHash: "c".repeat(64) }
const material = { schemaVersion: OBJECTIVE_APPLICATION_SUBMISSION_MATERIAL_SCHEMA, applicationTaskId: scope.applicationTaskId,
  jobId: scope.jobId, resumeId: "resume-1", coverLetterId: null, reviewedCoverLetterHash: "a".repeat(64), objectiveSource: source }
const manifest = buildObjectiveApplicationSubmissionManifest(material, "b".repeat(64))!
const eventId = `objective-submission-manifest:${hashArtifactContent([scope.applicationTaskId, scope.fillTurnId]).slice(7)}`

describe("Objective submission manifest event", () => {
  it("records and exactly replays the current attempt's closed V3 manifest", async () => {
    const test = fixture()
    const first = await recordObjectiveSubmissionManifestWithClient(test.client, scope, manifest)
    expect(first).toEqual({ manifest, hash: hashArtifactContent(manifest) })
    expect(test.event).toMatchObject({ id: eventId, taskId: scope.applicationTaskId,
      type: "objective_submission_manifest_recorded", actor: "worker" })
    expect(test.event?.data).toEqual({
      schemaVersion: "agent-harness.v2.objective-submission-manifest-event.v1", scope, manifest, hash: hashArtifactContent(manifest),
    })
    await expect(readObjectiveSubmissionManifestWithClient(test.client, scope)).resolves.toEqual(first)

    await expect(recordObjectiveSubmissionManifestWithClient(test.client, scope, manifest)).resolves.toEqual(first)
    expect(test.query.mock.calls.filter(([sql]) => String(sql).startsWith("INSERT INTO \"application_task_events\"")).length).toBe(2)
  })

  it("rejects an attempt to replace the same Fill Turn's immutable packet", async () => {
    const test = fixture()
    await expect(recordObjectiveSubmissionManifestWithClient(test.client, scope, manifest)).resolves.toBeTruthy()
    const changed = buildObjectiveApplicationSubmissionManifest(material, "d".repeat(64))!
    await expect(recordObjectiveSubmissionManifestWithClient(test.client, scope, changed)).resolves.toBeNull()
    expect((test.event?.data as Record<string, unknown>).manifest).toEqual(manifest)
  })

  it("rejects stale, foreign, or ambiguous current Task pointers before writing", async () => {
    const stale = fixture(); stale.task.fillTurnId = "later-turn"
    await expect(recordObjectiveSubmissionManifestWithClient(stale.client, scope, manifest)).resolves.toBeNull()
    expect(stale.event).toBeNull()
    const foreign = fixture(); foreign.task.fillTurnUserId = "other-user"
    await expect(readObjectiveSubmissionManifestWithClient(foreign.client, scope)).resolves.toBeNull()
    const ambiguous = fixture({ duplicateTask: true })
    await expect(recordObjectiveSubmissionManifestWithClient(ambiguous.client, scope, manifest)).resolves.toBeNull()
  })

  it("requires manifest Resume/material references and the persisted Objective selector to match", async () => {
    const test = fixture()
    const wrongResume = buildObjectiveApplicationSubmissionManifest({ ...material, resumeId: "resume-other" }, "b".repeat(64))!
    await expect(recordObjectiveSubmissionManifestWithClient(test.client, scope, wrongResume)).resolves.toBeNull()
    test.task.fillInput = { reviewedApplicationMaterialSource: { ...source, materialProofHash: "e".repeat(64) } }
    await expect(recordObjectiveSubmissionManifestWithClient(test.client, scope, manifest)).resolves.toBeNull()
    expect(test.event).toBeNull()
  })

  it("fails closed on malformed or altered event packets", async () => {
    const test = fixture()
    await expect(readObjectiveSubmissionManifestWithClient(test.client, scope)).resolves.toBeNull()
    await recordObjectiveSubmissionManifestWithClient(test.client, scope, manifest)
    test.event!.data = { ...(test.event!.data as Record<string, unknown>), extra: true }
    await expect(readObjectiveSubmissionManifestWithClient(test.client, scope)).resolves.toBeNull()
  })

  it("rejects duplicate logical events for the same current Fill Turn", async () => {
    const test = fixture()
    await expect(recordObjectiveSubmissionManifestWithClient(test.client, scope, manifest)).resolves.toBeTruthy()
    test.addDuplicateEvent()
    await expect(readObjectiveSubmissionManifestWithClient(test.client, scope)).resolves.toBeNull()
  })
})

function fixture(options: { duplicateTask?: boolean } = {}) {
  const task = { id: scope.applicationTaskId, userId: scope.userId, jobId: scope.jobId, sessionId: scope.sessionId,
    fillTurnId: scope.fillTurnId, fillTurnSessionId: scope.sessionId, fillTurnUserId: scope.userId,
    resumeId: "resume-1", coverLetterId: null, fillInput: { reviewedApplicationMaterialSource: source } }
  const events: Record<string, unknown>[] = []
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    if (sql.includes('FROM "application_tasks" AS task')) {
      const matches = task.id === values[0] && task.userId === values[1] && task.jobId === values[2]
        && task.sessionId === values[3] && task.fillTurnId === values[4]
        && task.fillTurnSessionId === values[3] && task.fillTurnUserId === values[1]
      return { rows: matches ? options.duplicateTask ? [task, task] : [task] : [], rowCount: matches ? 1 : 0 }
    }
    if (sql.startsWith('INSERT INTO "application_task_events"')) {
      const inserted = events.length === 0
      if (inserted) events.push({ id: values[0], taskId: values[1], type: values[2], actor: values[3], body: values[4], data: JSON.parse(String(values[5])) })
      return { rows: [], rowCount: inserted ? 1 : 0 }
    }
    if (sql.includes('FROM "application_task_events"')) {
      const found = events.filter(event => event.taskId === values[1] && (event.id === values[0]
        || event.type === values[2] && (event.data as Record<string, Record<string, unknown>>)?.scope?.fillTurnId === values[3]))
      return { rows: found.slice(0, 2), rowCount: found.length }
    }
    throw new Error("Unexpected query")
  })
  return { task, get event() { return events[0] ?? null }, addDuplicateEvent() {
    const original = events[0]
    if (original) events.push({ ...original, id: `${String(original.id)}:duplicate` })
  }, client: { query } as never, query }
}
