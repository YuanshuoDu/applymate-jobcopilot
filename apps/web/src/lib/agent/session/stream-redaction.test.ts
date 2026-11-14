import { describe, expect, it } from "vitest"
import { TASK_GRAPH_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { projectFinalAnswerContent } from "./final-answer-evidence-projection"
import { canonicalTaskGraphSourceKey } from "./final-task-graph-source-detail"
import { TASK_GRAPH_SOURCES_SCHEMA_VERSION } from "./final-task-graph-source-manifest"

import { isPrivateNativeVerificationEventType, redactStreamEventPayload, redactStreamString, redactStreamValue } from "./stream-redaction"

const turnId = "p3-task-graph-resume-turn-12345678-1234-4234-8234-123456789012"
const rootTaskId = `root-${turnId}`
const childTaskId = "subagent-12345678-1234-4234-8234-123456789012"
const secondChildTaskId = "subagent-87654321-9876-4abc-8def-012345678901"
const sessionId = "session-12345678-1234-4234-8234-123456789012"
const itemId = `task-graph-${"12345678".repeat(8)}`
const identity = { sessionId, turnId, itemId, taskId: rootTaskId }
const childIdentity = { ...identity, taskId: childTaskId }
const graphVersion = TASK_GRAPH_SCHEMA_VERSION

function item(content: unknown, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "agent-harness.v2", id: itemId, sessionId, turnId, stepId: null,
    taskId: rootTaskId, type: "task_graph", status: "streaming", phase: null, revision: 1, content,
    startedAt: "2026-09-28T00:00:00.000Z", completedAt: null,
    createdAt: "2026-09-28T00:00:00.000Z", updatedAt: "2026-09-28T00:00:00.000Z", ...overrides,
  }
}

function node(key: string, taskId: string, dependsOn: string[] = [], overrides: Record<string, unknown> = {}) {
  return {
    key, templateId: `template-${key}`, goal: "Inspect the role", successCriteria: ["Summarize fit"],
    dependsOn, depth: 1, taskId, ...overrides,
  }
}

function content(nodes: unknown[], schemaVersion = graphVersion, extra: Record<string, unknown> = {}) {
  return { schemaVersion, nodes, ...extra }
}

describe("agent stream redaction", () => {
  it("redacts credential-shaped strings", () => {
    expect(redactStreamString("Bearer very-secret-token sk-12345678")).toBe("Bearer [REDACTED] [REDACTED]")
  })

  it("preserves a redacted terminal identity only for a matching generated UUID composite", () => {
    const phoneShapedTurnId = "12345678-9012-4def-8abc-123456789abc"
    const generatedTaskId = `root-${phoneShapedTurnId}`
    const stepId = `turn:${phoneShapedTurnId}:step:12:${phoneShapedTurnId}`
    const generatedFinalItemId = `turn:${phoneShapedTurnId}:item:final:${stepId}`
    expect(redactStreamString(phoneShapedTurnId)).not.toBe(phoneShapedTurnId)
    expect(generatedFinalItemId.length).toBeGreaterThan(128)
    expect(generatedFinalItemId.length).toBeLessThanOrEqual(256)

    const terminalIdentity = { ...identity, turnId: phoneShapedTurnId, taskId: generatedTaskId, itemId: generatedFinalItemId }
    const payload = {
      turnId: phoneShapedTurnId, taskId: generatedTaskId, finalItemId: generatedFinalItemId,
      note: "Call +353 86 123 4567 or alex@example.test. Bearer very-secret-token",
      usage: { inputTokens: 1 },
    }
    const preserved = redactStreamEventPayload("turn.completed", payload, terminalIdentity) as Record<string, unknown>
    expect(preserved).toMatchObject({ turnId: phoneShapedTurnId, taskId: generatedTaskId, finalItemId: generatedFinalItemId })
    expect(preserved.note).toBe("Call [REDACTED_PHONE] or [REDACTED_EMAIL]. Bearer [REDACTED]")

    const phoneShapedStepUuid = "87654321-0987-4def-8abc-987654321098"
    expect(redactStreamString(phoneShapedStepUuid)).not.toBe(phoneShapedStepUuid)
    const nestedStepId = `turn:${phoneShapedTurnId}:step:13:${phoneShapedStepUuid}`
    const nestedFinalItemId = `turn:${phoneShapedTurnId}:item:final:${nestedStepId}`
    const nested = redactStreamEventPayload("turn.completed", {
      turnId: phoneShapedTurnId, taskId: generatedTaskId, finalItemId: nestedFinalItemId,
    }, { ...identity, turnId: phoneShapedTurnId, taskId: generatedTaskId, itemId: nestedFinalItemId }) as Record<string, unknown>
    expect(nested).toMatchObject({ turnId: phoneShapedTurnId, taskId: generatedTaskId, finalItemId: nestedFinalItemId })

    const phoneShapedLegacyTurnId = "+353 86 123 4567"
    const legacyTaskId = `root-${phoneShapedLegacyTurnId}`
    const legacyFinalItemId = `turn:${phoneShapedLegacyTurnId}:item:final:turn:${phoneShapedLegacyTurnId}:step:12`
    const rejectedLegacy = redactStreamEventPayload("turn.completed", {
      turnId: phoneShapedLegacyTurnId, taskId: legacyTaskId, finalItemId: legacyFinalItemId,
    }, { ...identity, turnId: phoneShapedLegacyTurnId, taskId: legacyTaskId, itemId: legacyFinalItemId }) as Record<string, unknown>
    expect(rejectedLegacy).not.toHaveProperty("turnId")
    expect(rejectedLegacy).not.toHaveProperty("taskId")
    expect(rejectedLegacy).not.toHaveProperty("finalItemId")
  })

  it("preserves a phone-shaped generated step UUID for a historical CUID turn", () => {
    const turnId = "c123456789012345678901234"
    const taskId = `root-${turnId}`
    const phoneShapedStepUuid = "12345678-9012-4def-8abc-123456789abc"
    const stepId = `turn:${turnId}:step:7:${phoneShapedStepUuid}`
    const finalItemId = `turn:${turnId}:item:final:${stepId}`
    expect(redactStreamString(phoneShapedStepUuid)).not.toBe(phoneShapedStepUuid)

    const projected = redactStreamEventPayload("turn.completed", {
      turnId, taskId, finalItemId, note: "Call 415-555-0100; Bearer very-secret-token",
    }, { ...identity, turnId, taskId, itemId: finalItemId }) as Record<string, unknown>
    expect(projected).toMatchObject({ turnId, taskId, finalItemId })
    expect(projected.note).toBe("Call [REDACTED_PHONE]; Bearer [REDACTED]")
  })

  it("preserves a phone-shaped step UUID for a safe historical turn ID", () => {
    const turnId = "turn-legacy"
    const taskId = `root-${turnId}`
    const phoneShapedStepUuid = "87654321-0987-4def-8abc-987654321098"
    const stepId = `turn:${turnId}:step:3:${phoneShapedStepUuid}`
    const finalItemId = `turn:${turnId}:item:final:${stepId}`
    expect(redactStreamString(turnId)).toBe(turnId)
    expect(redactStreamString(phoneShapedStepUuid)).not.toBe(phoneShapedStepUuid)

    const projected = redactStreamEventPayload("turn.completed", {
      turnId, taskId, finalItemId, note: "Contact alex@example.test; Bearer legacy-secret-token",
    }, { ...identity, turnId, taskId, itemId: finalItemId }) as Record<string, unknown>
    expect(projected).toMatchObject({ turnId, taskId, finalItemId })
    expect(projected.note).toBe("Contact [REDACTED_EMAIL]; Bearer [REDACTED]")

    const spacedTurnId = `legacy ${phoneShapedStepUuid} id`
    const spacedTaskId = `root-${spacedTurnId}`
    const spacedStepId = `turn:${spacedTurnId}:step:4:${phoneShapedStepUuid}`
    const spacedFinalItemId = `turn:${spacedTurnId}:item:final:${spacedStepId}`
    expect(redactStreamString(spacedTurnId)).not.toBe(spacedTurnId)
    const spaced = redactStreamEventPayload("turn.completed", {
      turnId: spacedTurnId, taskId: spacedTaskId, finalItemId: spacedFinalItemId,
    }, { ...identity, turnId: spacedTurnId, taskId: spacedTaskId, itemId: spacedFinalItemId }) as Record<string, unknown>
    expect(spaced).toMatchObject({ turnId: spacedTurnId, taskId: spacedTaskId, finalItemId: spacedFinalItemId })

    const slashTurnId = `legacy/${phoneShapedStepUuid}`
    const slashTaskId = `root-${slashTurnId}`
    const slashStepId = `turn:${slashTurnId}:step:5:${phoneShapedStepUuid}`
    const slashFinalItemId = `turn:${slashTurnId}:item:final:${slashStepId}`
    expect(redactStreamString(slashTurnId)).not.toBe(slashTurnId)
    const slash = redactStreamEventPayload("turn.completed", {
      turnId: slashTurnId, taskId: slashTaskId, finalItemId: slashFinalItemId,
    }, { ...identity, turnId: slashTurnId, taskId: slashTaskId, itemId: slashFinalItemId }) as Record<string, unknown>
    expect(slash).toMatchObject({ turnId: slashTurnId, taskId: slashTaskId, finalItemId: slashFinalItemId })
  })

  it("omits all identity fields for matched or mismatched sensitive IDs", () => {
    const phoneShapedUuid = "12345678-9012-4def-8abc-123456789abc"
    const sameLengthPlaceholder = "a".repeat(phoneShapedUuid.length)
    expect(redactStreamString(`Bearer ${sameLengthPlaceholder}`)).toBe("Bearer [REDACTED]")
    expect(redactStreamString(`sk-${sameLengthPlaceholder}`)).toBe("[REDACTED]")
    expect(redactStreamString("id_353861234567")).toBe("id_353861234567")
    expect(redactStreamString(`z${phoneShapedUuid}z`)).toBe(`z${phoneShapedUuid}z`)
    const sensitiveComponents = [
      `legacy Bearer ${phoneShapedUuid}`,
      `legacy sk-${phoneShapedUuid}`,
      `prefixBearer ${phoneShapedUuid}`,
      `prefixsk-${phoneShapedUuid}`,
      `prefixghp_${phoneShapedUuid}`,
      `prefixxoxb-${phoneShapedUuid}`,
      `legacy glpat-${phoneShapedUuid}`,
      `legacy AIza${phoneShapedUuid}`,
      `legacy ya29.${phoneShapedUuid}`,
      `prefixglpat-${phoneShapedUuid}`,
      `xAIza${phoneShapedUuid}`,
      `prefixya29.${phoneShapedUuid}`,
      `candidate+${phoneShapedUuid}@example.test`,
      "id_353861234567",
      `z${phoneShapedUuid}z`,
    ]
    const canonical = { turnId: "turn-legacy", taskId: "task-legacy", finalItemId: "final-legacy" }
    const identityFor = (ids: typeof canonical) => ({ ...identity, turnId: ids.turnId, taskId: ids.taskId, itemId: ids.finalItemId })
    const assertNoIdentity = (projected: Record<string, unknown>) => {
      for (const key of ["turnId", "taskId", "finalItemId"]) expect(projected).not.toHaveProperty(key)
      expect(projected.note).toBe("Call [REDACTED_PHONE]; Bearer [REDACTED]")
    }

    for (const field of ["turnId", "taskId", "finalItemId"] as const) {
      for (const component of sensitiveComponents) {
        const matchedIds = { ...canonical, [field]: component }
        const matched = redactStreamEventPayload("turn.completed", {
          ...matchedIds, note: "Call +353 86 123 4567; Bearer very-secret-token",
        }, identityFor(matchedIds)) as Record<string, unknown>
        assertNoIdentity(matched)
        expect(JSON.stringify(matched)).not.toContain(component)

        const mismatched = redactStreamEventPayload("turn.completed", {
          ...matchedIds, note: "Call +353 86 123 4567; Bearer very-secret-token",
        }, identityFor(canonical)) as Record<string, unknown>
        assertNoIdentity(mismatched)
        expect(JSON.stringify(mismatched)).not.toContain(component)
      }
    }

    const shortSimilarValues = ["prefixBearer ok", "prefixsk-short", "prefixghp_note", "prefixxoxb-team"]
    for (const field of ["turnId", "taskId", "finalItemId"] as const) {
      for (const value of shortSimilarValues) {
        const safeIds = { ...canonical, [field]: value }
        const projected = redactStreamEventPayload("turn.completed", safeIds, identityFor(safeIds)) as Record<string, unknown>
        expect(projected).toMatchObject(safeIds)
      }
    }
  })

  it("fails closed for each missing or wrongly typed terminal identity field", () => {
    const turnId = "12345678-9012-4def-8abc-123456789abc"
    const taskId = `root-${turnId}`
    const stepId = `turn:${turnId}:step:4:${turnId}`
    const finalItemId = `turn:${turnId}:item:final:${stepId}`
    const canonical = { turnId, taskId, finalItemId }
    const terminalIdentity = { ...identity, turnId, taskId, itemId: finalItemId }
    const fields = ["turnId", "taskId", "finalItemId"] as const
    const invalid: Array<Record<string, unknown>> = []
    for (const field of fields) {
      const missing: Record<string, unknown> = { ...canonical }
      delete missing[field]
      invalid.push(missing)
      invalid.push({ ...canonical, [field]: field === "turnId" ? 7 : field === "taskId" ? null : { id: finalItemId } })
    }

    for (const payload of invalid) {
      const projected = redactStreamEventPayload("turn.completed", payload, terminalIdentity) as Record<string, unknown>
      expect(projected).not.toHaveProperty("turnId")
      expect(projected).not.toHaveProperty("taskId")
      expect(projected).not.toHaveProperty("finalItemId")
    }
  })

  it("preserves unchanged legacy terminal IDs but never repairs a mismatched identity", () => {
    const legacy = { turnId: "turn legacy id", taskId: "root legacy id", finalItemId: "final item legacy" }
    const legacyIdentity = { ...identity, ...legacy, itemId: legacy.finalItemId }
    const preserved = redactStreamEventPayload("turn.completed", legacy, legacyIdentity) as Record<string, unknown>
    expect(preserved).toMatchObject(legacy)

    const phoneShapedTurnId = "12345678-9012-4def-8abc-123456789abc"
    const generatedTaskId = `root-${phoneShapedTurnId}`
    const stepId = `turn:${phoneShapedTurnId}:step:12:${phoneShapedTurnId}`
    const finalItemId = `turn:${phoneShapedTurnId}:item:final:${stepId}`
    const terminalIdentity = { ...identity, turnId: phoneShapedTurnId, taskId: generatedTaskId, itemId: finalItemId }
    const mismatches = [
      { turnId: "different-turn" },
      { taskId: "different-task" },
      { finalItemId: `turn:${phoneShapedTurnId}:item:final:other-step` },
    ]
    for (const mismatch of mismatches) {
      const redacted = redactStreamEventPayload("turn.completed", {
        turnId: phoneShapedTurnId, taskId: generatedTaskId, finalItemId, ...mismatch,
      }, terminalIdentity) as Record<string, unknown>
      expect(redacted).not.toHaveProperty("turnId")
      expect(redacted).not.toHaveProperty("taskId")
      expect(redacted).not.toHaveProperty("finalItemId")
    }
  })

  it("keeps malformed, overlong, or sensitive step identities redacted", () => {
    const phoneShapedTurnId = "12345678-9012-4def-8abc-123456789abc"
    const generatedTaskId = `root-${phoneShapedTurnId}`
    const stepId = `turn:${phoneShapedTurnId}:step:12:${phoneShapedTurnId}`
    const generatedFinalItemId = `turn:${phoneShapedTurnId}:item:final:${stepId}`
    const longStepId = `turn:${phoneShapedTurnId}:step:${"x".repeat(500)}`
    const longFinalItemId = `turn:${phoneShapedTurnId}:item:final:${longStepId}`
    const cases = [
      { turnId: 123, taskId: generatedTaskId, finalItemId: generatedFinalItemId },
      { turnId: " ", taskId: generatedTaskId, finalItemId: generatedFinalItemId },
      { turnId: "x".repeat(257), taskId: generatedTaskId, finalItemId: generatedFinalItemId },
      { turnId: phoneShapedTurnId, taskId: ` ${generatedTaskId}`, finalItemId: generatedFinalItemId },
      { turnId: phoneShapedTurnId, taskId: "x".repeat(257), finalItemId: generatedFinalItemId },
      { turnId: phoneShapedTurnId, taskId: generatedTaskId, finalItemId: ` ${generatedFinalItemId}` },
      { turnId: phoneShapedTurnId, taskId: generatedTaskId, finalItemId: "x".repeat(257) },
    ]
    for (const payload of cases) {
      const event = { ...payload, note: "Call 415-555-0100; Bearer very-secret-token" }
      const projected = redactStreamEventPayload("turn.completed", event, {
        ...identity, turnId: typeof payload.turnId === "string" ? payload.turnId : phoneShapedTurnId,
        taskId: payload.taskId,
        itemId: typeof payload.finalItemId === "string" ? payload.finalItemId : null,
      }) as Record<string, unknown>
      expect(projected).not.toHaveProperty("turnId")
      expect(projected).not.toHaveProperty("taskId")
      expect(projected).not.toHaveProperty("finalItemId")
      expect(projected.note).toBe("Call [REDACTED_PHONE]; Bearer [REDACTED]")
      expect(JSON.stringify(projected)).not.toContain("very-secret-token")
    }

    const sensitiveStep = `turn:${phoneShapedTurnId}:step:12:Bearer very-secret-token`
    const sensitiveFinalItemId = `turn:${phoneShapedTurnId}:item:final:${sensitiveStep}`
    const sensitive = redactStreamEventPayload("turn.completed", {
      turnId: phoneShapedTurnId, taskId: generatedTaskId, finalItemId: sensitiveFinalItemId,
      note: "Call 415-555-0100; Bearer very-secret-token",
    }, { ...identity, turnId: phoneShapedTurnId, taskId: generatedTaskId, itemId: sensitiveFinalItemId }) as Record<string, unknown>
    expect(sensitive).not.toHaveProperty("turnId")
    expect(sensitive).not.toHaveProperty("taskId")
    expect(sensitive).not.toHaveProperty("finalItemId")
    expect(sensitive.note).toBe("Call [REDACTED_PHONE]; Bearer [REDACTED]")
    expect(JSON.stringify(sensitive)).not.toContain("very-secret-token")
  })

  it("projects completed final event content to the same safe DTO as timeline replay", () => {
    const text = "A match. [[source:S1]] Filtered [[source:S2]] Unknown [[source:E-private-key]] malformed [[source:S1]"
    const payload = {
      itemId: "final-item", status: "completed",
      content: {
        text,
        final: {
          response: text, summary: "Good fit.",
          answerEvidence: {
            schemaVersion: 1,
            sources: [
              { key: "S1", kind: "job", label: "Engineer at Example Co", excerpt: "Dublin. alex@example.test" },
              { key: "S2", kind: "job", label: "Private listing", excerpt: "https://private.example/job" },
            ],
          },
          evidenceRefs: ["PRIVATE_TOOL_CALL_ID"], usage: { tokens: 9 }, goal: "PRIVATE_GOAL",
        },
      },
    }
    const projected = redactStreamEventPayload("item.completed", payload, { ...identity, itemId: "final-item" })
    expect(projected).toEqual({
      itemId: "final-item", status: "completed",
      content: {
        text: "A match. [[source:S1]] Filtered  Unknown  malformed ", summary: "Good fit.",
        answerEvidence: {
          schemaVersion: 1,
          sources: [{ key: "S1", kind: "job", label: "Engineer at Example Co", excerpt: "Dublin. [REDACTED_EMAIL]" }],
        },
      },
    })
    expect((projected as { content: unknown }).content).toEqual(projectFinalAnswerContent(payload.content))
    expect(JSON.stringify(projected)).not.toMatch(/PRIVATE_TOOL_CALL_ID|PRIVATE_GOAL|private\.example|alex@example\.test/)
  })

  it("preserves legacy markers without evidence and removes all markers when evidence is rejected", () => {
    const legacyText = "Saved answer [[source:E-old-key]] and [[source:S9]]."
    const legacy = redactStreamEventPayload("item.completed", {
      itemId: "final-item", status: "completed",
      content: { text: legacyText, final: { response: legacyText } },
    }, { ...identity, itemId: "final-item" })
    const rejectedText = "Keep prose [[source:S1]] and [[source:E-private-key]]."
    const rejected = redactStreamEventPayload("item.completed", {
      itemId: "final-item", status: "completed",
      content: {
        text: rejectedText,
        final: {
          response: rejectedText,
          answerEvidence: {
            schemaVersion: 1,
            sources: [{ key: "S1", kind: "job", label: "Private", excerpt: "https://private.example/job" }],
          },
        },
      },
    }, { ...identity, itemId: "final-item" })

    expect(legacy).toMatchObject({ content: { text: legacyText } })
    expect(rejected).toMatchObject({ content: { text: "Keep prose  and ." } })
    expect(JSON.stringify(rejected)).not.toContain("E-private-key")
  })

  it("uses the existing fail-closed redaction for malformed final completion payloads", () => {
    const payload = { itemId: "final-item", status: "completed", content: { text: "Safe", final: { response: "Different" } } }
    expect(redactStreamEventPayload("item.completed", payload, { ...identity, itemId: "final-item" }))
      .toEqual({ itemId: "final-item", status: "completed", content: "[REDACTED]" })
    expect(redactStreamEventPayload("item.completed", payload, identity))
      .toEqual({ itemId: "final-item", status: "completed", content: "[REDACTED]" })
  })

  it("streams only a canonical TaskGraph source manifest beside the ordinary final answer", () => {
    const source = { sourceKey: canonicalTaskGraphSourceKey("final-item", 3, 0), nodeIndex: 0,
      role: "scout", taskStatus: "completed", resultState: "missing" }
    const manifest = { schemaVersion: TASK_GRAPH_SOURCES_SCHEMA_VERSION, graphRevision: 3, sources: [source] }
    const payload = { itemId: "final-item", status: "completed", content: {
      text: "Safe answer", final: { response: "Safe answer" }, taskGraphSources: manifest,
      taskId: "PRIVATE_TASK_ID", rawResult: "PRIVATE_RAW_RESULT",
    } }
    const projected = redactStreamEventPayload("item.completed", payload, { ...identity, itemId: "final-item" })
    expect(projected).toEqual({ itemId: "final-item", status: "completed", content: { text: "Safe answer", taskGraphSources: manifest } })
    expect(JSON.stringify(projected)).not.toMatch(/PRIVATE_TASK_ID|PRIVATE_RAW_RESULT|sessionId|graphItemId/)

    const malformed = redactStreamEventPayload("item.completed", { ...payload, content: {
      ...payload.content, taskGraphSources: { ...manifest, sources: [{ ...source, sourceKey: `src_${"A".repeat(43)}` }] },
    } }, { ...identity, itemId: "final-item" })
    expect(malformed).toEqual({ itemId: "final-item", status: "completed", content: { text: "Safe answer" } })
  })

  it("redacts nested credential, resume, and raw payload keys", () => {
    expect(redactStreamValue({ data: { token: "private", resume: "full CV", rawContent: "raw" }, title: "safe" })).toEqual({
      data: { token: "[REDACTED]", resume: "[REDACTED]", rawContent: "[REDACTED]" }, title: "safe",
    })
  })

  it("preserves only a valid TaskGraph item and still redacts its goal strings", () => {
    const validPayload = { kind: "lifecycle", event: { type: "task.completed", nodeKey: "research" }, revision: 1, item: item(content([
      node("research", childTaskId, [], {
        goal: "Review this role 123-456-7890; Bearer very-secret-token",
        successCriteria: ["Call 987-654-3210", "Bearer very-secret-token"],
      }),
    ])) }
    const preserved = redactStreamEventPayload("item.delta", validPayload, childIdentity) as {
      item: { id: string | null; sessionId: string; turnId: string; taskId: string; content: { nodes: Array<{ goal: string; successCriteria: string[]; taskId: string }> } }
    }
    expect(preserved.item).toMatchObject({ id: identity.itemId, sessionId: identity.sessionId, turnId, taskId: rootTaskId })
    expect(preserved.item.content.nodes[0]?.goal).toBe("Review this role [REDACTED_PHONE]; Bearer [REDACTED]")
    expect(preserved.item.content.nodes[0]?.successCriteria).toEqual(["Call [REDACTED_PHONE]", "Bearer [REDACTED]"])
    expect(preserved.item.content.nodes[0]?.taskId).toBe(childTaskId)

    const unrelated = redactStreamEventPayload("item.delta", {
      item: item({ text: "private transcript" }, { type: "agent_message" }),
    }, identity) as { item: { content: unknown } }
    expect(unrelated.item.content).toBe("[REDACTED]")

    const wrongEventType = redactStreamEventPayload("task_graph", validPayload, childIdentity) as {
      item: { content: unknown }
    }
    expect(wrongEventType.item.content).toBe("[REDACTED]")

    const malformedEvent = redactStreamEventPayload("item.delta", { item: item(content([node("research", "task-1")])) }, childIdentity) as {
      item: { content: unknown }
    }
    expect(malformedEvent.item.content).toBe("[REDACTED]")
  })

  it("preserves legacy TaskGraph identifiers with surrounding whitespace when generic redaction leaves them unchanged", () => {
    const legacyTaskId = " task-1 "
    const legacyIdentity = { sessionId: "session-legacy", turnId: "turn-legacy", itemId: "graph-legacy", taskId: legacyTaskId }
    const payload = {
      kind: "lifecycle", event: { type: "task.completed", nodeKey: " research " }, revision: 1,
      item: item(content([node(" research ", legacyTaskId)]), {
        id: legacyIdentity.itemId, sessionId: legacyIdentity.sessionId, turnId: legacyIdentity.turnId, taskId: "root-legacy",
      }),
    }
    const result = redactStreamEventPayload("item.delta", payload, legacyIdentity) as {
      item: { content: { nodes: Array<{ key: string; taskId: string }> } }
    }

    expect(result.item.content.nodes[0]).toMatchObject({ key: " research ", taskId: legacyTaskId })
  })

  it("fails closed for an arbitrary phone-like task ID", () => {
    const unsafeTaskId = "unsafe-12345678-1234-4234-8234-123456789012"
    const payload = {
      kind: "lifecycle", event: { type: "task.completed", nodeKey: "research" }, revision: 1,
      item: item(content([node("research", unsafeTaskId)])),
    }
    const result = redactStreamEventPayload("item.delta", payload, { ...identity, taskId: unsafeTaskId }) as {
      item: { taskId: string; content: unknown }
    }

    expect(result.item.content).toBe("[REDACTED]")
    expect(result.item.taskId).not.toBe(rootTaskId)
    expect(result.item.taskId).toContain("[REDACTED_PHONE]")
  })

  it("fails closed when the root task ID is not generated from its turn ID", () => {
    const unsafeRootTaskId = "root-12345678-1234-4234-8234-123456789012"
    const payload = {
      kind: "lifecycle", event: { type: "task.completed", nodeKey: "research" }, revision: 1,
      item: item(content([node("research", childTaskId)]), { taskId: unsafeRootTaskId }),
    }
    const result = redactStreamEventPayload("item.delta", payload, childIdentity) as {
      item: { taskId: string; content: unknown }
    }

    expect(result.item.content).toBe("[REDACTED]")
    expect(result.item.taskId).not.toBe(unsafeRootTaskId)
    expect(result.item.taskId).toContain("[REDACTED_PHONE]")
  })

  it("keeps proposal snapshots strictly attributed to the root task", () => {
    const proposal = {
      kind: "proposal", fingerprint: "task-graph:fingerprint", receipt: { status: "accepted" }, revision: 1,
      item: item(content([node("research", childTaskId)])),
    }
    const rootResult = redactStreamEventPayload("item.delta", proposal, identity) as { item: { content: { nodes: unknown[] } } }
    expect(rootResult.item.content.nodes).toHaveLength(1)

    const childResult = redactStreamEventPayload("item.delta", proposal, childIdentity) as { item: { content: unknown } }
    expect(childResult.item.content).toBe("[REDACTED]")
  })

  it("preserves a generated subagent root ID when the graph owner was created without a parent", () => {
    const proposal = {
      kind: "proposal", fingerprint: "task-graph:fingerprint", receipt: { status: "accepted" }, revision: 1,
      item: item(content([node("research", childTaskId)]), { taskId: secondChildTaskId }),
    }
    const result = redactStreamEventPayload("item.delta", proposal, { ...identity, taskId: secondChildTaskId }) as {
      item: { taskId: string; content: { nodes: Array<{ taskId: string }> } }
    }

    expect(result.item.taskId).toBe(secondChildTaskId)
    expect(result.item.content.nodes[0]?.taskId).toBe(childTaskId)
  })

  it.each([
    ["unknown node key", "missing", childTaskId],
    ["node key owned by a different child", "analyst", childTaskId],
    ["child node attributed to the root task", "research", rootTaskId],
    ["missing node key", undefined, childTaskId],
  ])("generically redacts a lifecycle snapshot with %s", (_case, nodeKey, taskId) => {
    const event = { type: "task.completed", ...(nodeKey === undefined ? {} : { nodeKey }) }
    const payload = {
      kind: "lifecycle", event, revision: 1,
      item: item(content([node("research", childTaskId), node("analyst", secondChildTaskId)])),
    }
    const result = redactStreamEventPayload("item.delta", payload, { ...identity, taskId }) as { item: { content: unknown } }
    expect(result.item.content).toBe("[REDACTED]")
  })

  it.each([
    ["sessionId", { ...childIdentity, sessionId: "other-session" }],
    ["turnId", { ...childIdentity, turnId: "other-turn" }],
    ["itemId", { ...childIdentity, itemId: "other-graph" }],
    ["taskId", { ...childIdentity, taskId: "other-child" }],
  ])("generically redacts a valid snapshot when its %s differs from the stream envelope", (_field, eventIdentity) => {
    const validPayload = { kind: "lifecycle", event: { type: "task.completed", nodeKey: "research" }, revision: 1, item: item(content([node("research", childTaskId)])) }
    const result = redactStreamEventPayload("item.delta", validPayload, eventIdentity) as { item: { content: unknown } }
    expect(result.item.content).toBe("[REDACTED]")
  })

  it.each([
    ["unknown schema version", content([node("research", childTaskId)], "future.task-graph")],
    ["extra snapshot key", content([node("research", childTaskId)], graphVersion, { raw: "private" })],
    ["extra node key", content([{ ...node("research", childTaskId), prompt: "private" }])],
    ["duplicate graph keys", content([node("same", childTaskId), node("same", secondChildTaskId)])],
    ["duplicate task IDs", content([node("research", childTaskId), node("review", childTaskId)])],
    ["duplicate dependencies", content([node("base", childTaskId), node("next", secondChildTaskId, ["base", "base"])])],
    ["missing dependency", content([node("research", childTaskId, ["missing"])])],
    ["cyclic dependencies", content([node("research", childTaskId, ["review"]), node("review", secondChildTaskId, ["research"])])],
    ["depth beyond MAX_DEPTH", content([node("research", childTaskId, [], { depth: 9 })])],
    ["goal beyond its bound", content([node("research", childTaskId, [], { goal: "g".repeat(1_201) })])],
    ["success criteria count beyond its bound", content([node("research", childTaskId, [], { successCriteria: Array(9).fill("criterion") })])],
    ["success criterion beyond its bound", content([node("research", childTaskId, [], { successCriteria: ["c".repeat(321)] })])],
    ["dependency count beyond its bound", content([node("research", childTaskId, Array(9).fill("dependency"))])],
    ["node count beyond MAX_NODES", content(Array.from({ length: 9 }, (_, index) => node(`n${index}`, `task-${index}`)))],
    ["encoded bytes beyond their bound", content(Array.from({ length: 8 }, (_, index) => node(
      `n${index}`, `task-${index}`, [], { goal: "€".repeat(1_200), successCriteria: Array(8).fill("€".repeat(320)) },
    )))],
  ])("falls back to generic redaction for a snapshot with %s", (_name, invalidSnapshot) => {
    const result = redactStreamEventPayload("item.started", { item: item(invalidSnapshot) }, identity) as {
      item: { content: unknown }
    }
    expect(result.item.content).toBe("[REDACTED]")
  })

  it("uses generic redaction for non-TaskGraph content even inside a TaskGraph event type", () => {
    expect(redactStreamEventPayload("item.delta", { content: "ordinary content" }, identity)).toEqual({ content: "[REDACTED]" })
  })

  it("fails closed for private native verification receipt events, including future namespace types", () => {
    const receipt = {
      controlTaskId: "PRIVATE_CONTROL_TASK_ID", controlOperationId: "PRIVATE_CONTROL_OPERATION_ID",
      ownerDigest: "PRIVATE_OWNER_DIGEST", targetDigest: "PRIVATE_TARGET_DIGEST",
      goalDigest: "PRIVATE_GOAL_DIGEST", criteriaDigest: "PRIVATE_CRITERIA_DIGEST",
      evidencePacketDigest: "PRIVATE_PACKET_DIGEST", secret: "PRIVATE_RECEIPT_SECRET",
    }
    for (const type of ["native_verification.requested", "native_verification.result.v2"]) {
      expect(isPrivateNativeVerificationEventType(type)).toBe(true)
      expect(redactStreamEventPayload(type, receipt, identity)).toEqual({})
    }
    expect(JSON.stringify(redactStreamEventPayload("native_verification.requested", receipt, identity)))
      .not.toMatch(/PRIVATE_|DIGEST|SECRET/)
  })

  it("does not hide ordinary lookalike event types or their existing payload redaction", () => {
    const payload = { controlTaskId: "ordinary-value", text: "Review role; Bearer very-secret-token" }
    expect(isPrivateNativeVerificationEventType("native_verificationish.requested")).toBe(false)
    expect(isPrivateNativeVerificationEventType("agent.native_verification.requested")).toBe(false)
    expect(redactStreamEventPayload("native_verificationish.requested", payload, identity)).toEqual({
      controlTaskId: "ordinary-value", text: "Review role; Bearer [REDACTED]",
    })
  })
})
