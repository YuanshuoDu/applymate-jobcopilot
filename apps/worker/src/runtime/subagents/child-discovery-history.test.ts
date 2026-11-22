import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { canonicalJson } from "@jobcopilot/shared"
import { MAX_TOOL_RESULT_BYTES, MAX_TOOL_RESULT_READ_BYTES } from "../tools/tool-result-reference-types.js"
import { redactJobReadOutput } from "../tools/job-read-output-redaction.js"
import { projectChildDiscoveryHistory } from "./child-discovery-history.js"
import type { ContextSeedBlock } from "../context/step-context-builder.js"

const REF = "tool-result-abcdefab-cdef-4abc-8def-abcdefabcdef"
const LIMIT = 256 * 1024

function discoveryOutput() {
  const jobs = [1, 2].map(number => ({ id: `c${number.toString(36).padStart(24, "0")}`, title: "Engineer", company: "Example",
    location: "Dublin", url: `https://jobs.example/${number}`, description: "界".repeat(34_000), fullDescription: "x".repeat(34_000),
    salary: null, logo: null, source: "greenhouse", evidenceRefs: [`source-${number}`] }))
  return {
    jobs, evidence: jobs.map((job, index) => ({ evidenceId: `source-${index + 1}`, jobId: job.id, kind: "source",
      source: "greenhouse", url: job.url, summary: "Source listing" })),
    nextCursor: null, usage: { ledgerKey: "large-discovery", toolName: "jobs.discover", toolVersion: "1", toolCallId: "discover-call",
      sessionId: "session-1", turnId: "turn-1", stepId: "step-1", requests: 1, jobsProcessed: jobs.length, jobsSucceeded: jobs.length,
      jobsFailed: 0, providerFailures: 0, aiCalls: 0, providers: ["greenhouse"], estimatedCostUsd: 0, durationMs: 1 },
  }
}

function readChunks(value: unknown): ContextSeedBlock[] {
  const encoded = Buffer.from(canonicalJson(value), "utf8"), digest = createHash("sha256").update(encoded).digest("hex")
  const chunks: ContextSeedBlock[] = []
  let offset = 0, index = 0
  while (offset < encoded.byteLength) {
    let end = Math.min(encoded.byteLength, offset + MAX_TOOL_RESULT_READ_BYTES)
    const output = () => ({ ref: REF, sha256: digest, byteCount: encoded.byteLength,
      chunk: encoded.subarray(offset, end).toString("utf8"), nextCursor: end < encoded.byteLength ? String(end) : null })
    while (end > offset && (!Buffer.from(output().chunk, "utf8").equals(encoded.subarray(offset, end))
      || Buffer.byteLength(JSON.stringify(output()), "utf8") > MAX_TOOL_RESULT_READ_BYTES)) end -= 1
    if (end <= offset) throw new Error("fixture_chunk_empty")
    const content = { toolCallId: `read-${index}`, toolName: "tool_results.read", input: { referenceId: REF, ...(offset ? { cursor: String(offset) } : {}) },
      status: "completed", output: output(), errorCode: null }
    chunks.push({ id: `read-block-${index}`, content })
    offset = end
    index += 1
  }
  return chunks
}

function largeHistory() {
  const safe = redactJobReadOutput("jobs.discover", discoveryOutput())
  if (safe === "[REDACTED]") throw new Error("fixture_discovery_redacted")
  const encoded = Buffer.from(canonicalJson(safe), "utf8")
  expect(encoded.byteLength).toBeGreaterThan(LIMIT)
  expect(encoded.byteLength).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES)
  const digest = createHash("sha256").update(encoded).digest("hex")
  const reference = { $ref: REF, sizeBytes: encoded.byteLength, sha256: digest }
  const discovery: ContextSeedBlock = { id: "discovery-block", content: { toolCallId: "discover-call", toolName: "jobs.discover",
    input: { targetRoles: ["Engineer"] }, status: "completed", output: reference, errorCode: null } }
  const wait: ContextSeedBlock = { id: "wait-block", content: { toolCallId: "wait-call", toolName: "wait_subagents", status: "completed", output: { waitId: "wait-1" } } }
  const other: ContextSeedBlock = { id: "other-block", content: { toolCallId: "get-call", toolName: "jobs.get", status: "completed", output: { jobId: "job-1" } } }
  const chunks = readChunks(safe), middle = Math.floor(chunks.length / 2)
  const firstContent = chunks[0]!.content as Record<string, unknown>
  const duplicate: ContextSeedBlock = { id: "duplicate-read-block", content: { ...firstContent, toolCallId: "read-duplicate" } }
  const observations = [discovery, ...chunks.slice(0, middle), wait, ...chunks.slice(middle), other, duplicate]
  return { observations, safe, reference, wait, other, jobs: (safe as { jobs: { id: string; source: string }[] }).jobs }
}

let cachedFixture: ReturnType<typeof largeHistory> | undefined
function getFixture(): ReturnType<typeof largeHistory> { return cachedFixture ??= largeHistory() }

describe("verified Scout discovery history projection", () => {
  it("keeps small histories byte-for-byte unchanged", () => {
    const small: readonly ContextSeedBlock[] = [{ id: "one", content: { toolCallId: "call-1", output: { ok: true } } }]
    expect(projectChildDiscoveryHistory(small)).toBe(small)
  })

  it("compacts only a complete digest-verified group into bounded untrusted candidate facts", () => {
    const fixture = getFixture()
    const rawBytes = Buffer.byteLength(JSON.stringify(fixture.observations), "utf8")
    expect(rawBytes).toBeGreaterThan(LIMIT)
    const projected = projectChildDiscoveryHistory(fixture.observations)
    expect(projected).not.toBe(fixture.observations)
    expect(Buffer.byteLength(JSON.stringify(projected), "utf8")).toBeLessThanOrEqual(LIMIT)
    expect(projected[0]).toBe(fixture.observations[0])
    expect(projected[1]).toBe(fixture.wait)
    expect(projected.at(-1)).toBe(fixture.other)
    const summary = projected.find(block => block.id === `child-discovery-history:${REF}`)
    expect(projected.indexOf(fixture.wait)).toBeLessThan(projected.indexOf(summary!))
    expect(summary?.content).toMatchObject({
      schemaVersion: "agent-harness.v2.child-discovery-history",
      discoveryReference: fixture.reference,
      candidates: fixture.jobs.map(job => ({ jobId: job.id, source: job.source })),
      omitted: { reason: "bounded_context", fields: expect.arrayContaining(["description", "fullDescription", "evidence"]) },
    })
    expect(summary?.content).not.toHaveProperty("toolCallId")
    expect(JSON.stringify(summary?.content)).not.toContain("界".repeat(100))
    expect(projected.filter(block => (block.content as Record<string, unknown>).toolName === "tool_results.read")).toHaveLength(0)
  }, 30_000)

  it.each(["corrupt", "incomplete"] as const)("leaves %s history on the validated path", kind => {
    const fixture = getFixture()
    const reads = fixture.observations.filter(block => (block.content as Record<string, unknown>).toolName === "tool_results.read")
    let candidate = [...fixture.observations]
    if (kind === "corrupt") {
      const first = reads[0]!
      const content = first.content as Record<string, unknown>, output = content.output as Record<string, unknown>
      const position = candidate.indexOf(first)
      candidate[position] = { ...first, content: { ...content, output: { ...output, chunk: `!${String(output.chunk).slice(1)}` } } }
    } else if (kind === "incomplete") {
      const finalRead = reads.find(block => ((block.content as Record<string, unknown>).output as Record<string, unknown>).nextCursor === null)
      candidate = candidate.filter(block => block !== finalRead && block.id !== "duplicate-read-block")
    }
    expect(projectChildDiscoveryHistory(candidate)).toBe(candidate)
  }, 30_000)
})
