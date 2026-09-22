import { describe, expect, it } from "vitest"

import { addJobEvidence } from "./context-memory-job-evidence.js"
import type { CognitiveMemoryJobEvidenceExcerpt } from "./context-memory-schema.js"

function excerpt(sourceRef: string, sequence?: string): CognitiveMemoryJobEvidenceExcerpt {
  return {
    id: `job-evidence:${sourceRef}`,
    referenceId: "job-1",
    sourceRef,
    toolName: "jobs.get",
    trust: "external_untrusted",
    fields: { company: "Example", role: "Engineer" },
    excerpt: "company=Example | role=Engineer",
    ...(sequence === undefined ? {} : { sequence }),
  }
}

describe("context memory job evidence", () => {
  it("keeps the newest sequence and uses a stable source tie-breaker", () => {
    const map = new Map<string, CognitiveMemoryJobEvidenceExcerpt>()
    addJobEvidence(map, excerpt("tool-result:old", "4"))
    addJobEvidence(map, excerpt("tool-result:new", "5"))
    addJobEvidence(map, excerpt("tool-result:older", "3"))
    expect(map.get("job-1")?.sourceRef).toBe("tool-result:new")

    const tied = new Map<string, CognitiveMemoryJobEvidenceExcerpt>()
    addJobEvidence(tied, excerpt("tool-result:a"))
    addJobEvidence(tied, excerpt("tool-result:b"))
    expect(tied.get("job-1")?.sourceRef).toBe("tool-result:b")
  })
})
