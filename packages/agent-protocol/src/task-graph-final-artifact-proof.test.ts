import { describe, expect, it } from "vitest"
import {
  finalTaskGraphArtifactProofInput, isFinalTaskGraphArtifactVersionProof, parseFinalTaskGraphArtifactRef,
  TASK_GRAPH_FINAL_ARTIFACT_MANIFEST_SCHEMA,
} from "./task-graph-final-artifact-proof.js"

const ref = { artifactId: "artifact-1", version: 2, contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"b".repeat(64)}` }
const sourceKey = `src_${"x".repeat(43)}`

describe("TaskGraph final artifact version proof protocol", () => {
  it("defines the v3 manifest and returns a detached closed reference", () => {
    const parsed = parseFinalTaskGraphArtifactRef(ref)
    expect(TASK_GRAPH_FINAL_ARTIFACT_MANIFEST_SCHEMA).toBe("agent-harness.v2.task-graph-sources.v3")
    expect(parsed).toEqual(ref)
    expect(parsed).not.toBe(ref)
  })

  it("rejects extra keys, accessors, unusual prototypes, symbols, and malformed references", () => {
    let getterRead = false
    const accessor = { ...ref, get version() { getterRead = true; return 2 } }
    const symbol = { ...ref, [Symbol("extra")]: true }
    const malformed = [
      null, [], { ...ref, extra: true }, accessor, symbol, Object.assign(Object.create({ inherited: true }), ref),
      { ...ref, artifactId: "../private" }, { ...ref, version: 0 }, { ...ref, version: Number.MAX_SAFE_INTEGER + 1 },
      { ...ref, contentHash: `sha256:${"A".repeat(64)}` }, { ...ref, sourceDigest: "sha256:bad" },
    ]
    for (const value of malformed) expect(parseFinalTaskGraphArtifactRef(value)).toBeNull()
    expect(getterRead).toBe(false)
  })

  it("builds the exact deterministic JSON tuple and validates opaque proof syntax", () => {
    expect(finalTaskGraphArtifactProofInput(sourceKey, ref)).toBe(JSON.stringify([
      "taskGraphSourceArtifact:v1", sourceKey, ref.artifactId, ref.version, ref.contentHash, ref.sourceDigest,
    ]))
    expect(isFinalTaskGraphArtifactVersionProof(`avp_${"c".repeat(64)}`)).toBe(true)
    for (const value of [`avp_${"C".repeat(64)}`, `src_${"c".repeat(64)}`, "avp_short", null]) {
      expect(isFinalTaskGraphArtifactVersionProof(value)).toBe(false)
    }
    expect(() => finalTaskGraphArtifactProofInput("src_bad", ref)).toThrow("task_graph_final_source_key_invalid")
    expect(() => finalTaskGraphArtifactProofInput(sourceKey, { ...ref, version: 0 })).toThrow("task_graph_final_artifact_ref_invalid")
  })
})
