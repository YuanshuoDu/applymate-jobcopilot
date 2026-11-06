import { describe, expect, it } from "vitest"
import { CHILD_WAIT_HISTORICAL_SOURCE_EVENT_BINDING_SQL } from "./pg-store-expiry-historical-wait-event-binding.js"

const unparenthesizedJsonExtractionAfterConcat = /\|\|\s*(?:[a-z_][\w]*\.)?(?:"[^"]+"|[a-z_][\w]*)(?:\s*->>?\s*(?:'[^']+'|"[^"]+"))+/i

describe("historical source lifecycle SQL binding", () => {
  it("binds the exact six-event sequence, causation, payload projection and uniqueness", () => {
    expect(CHILD_WAIT_HISTORICAL_SOURCE_EVENT_BINDING_SQL).toContain('sourceCallStarted."causationId" = sourceItemStarted."id"')
    expect(CHILD_WAIT_HISTORICAL_SOURCE_EVENT_BINDING_SQL).toContain("sourceStepPrefix")
    expect(CHILD_WAIT_HISTORICAL_SOURCE_EVENT_BINDING_SQL).toContain('sourceResultCompleted."causationId" = sourceResultStarted."id"')
    expect(CHILD_WAIT_HISTORICAL_SOURCE_EVENT_BINDING_SQL).toContain("'toolCallId', proof.value->'sourceWait'->>'projectedSourceCallId'")
    expect(CHILD_WAIT_HISTORICAL_SOURCE_EVENT_BINDING_SQL).toContain("'idempotencyKey', '[REDACTED]'")
    expect(CHILD_WAIT_HISTORICAL_SOURCE_EVENT_BINDING_SQL).toContain("= 6")
    expect(CHILD_WAIT_HISTORICAL_SOURCE_EVENT_BINDING_SQL).toContain('extra."causationId" IN (sourceItemStarted."id"')
    expect(CHILD_WAIT_HISTORICAL_SOURCE_EVENT_BINDING_SQL).not.toMatch(unparenthesizedJsonExtractionAfterConcat)
  })

  it("guards target-array expansion against malformed non-array receipt JSON", () => {
    expect(CHILD_WAIT_HISTORICAL_SOURCE_EVENT_BINDING_SQL).toContain("CASE WHEN jsonb_typeof(boundWait.\"targetTaskIds\") = 'array'")
    expect(CHILD_WAIT_HISTORICAL_SOURCE_EVENT_BINDING_SQL).toContain("ELSE '[]'::jsonb END")
  })
})
