import { describe, expect, it } from "vitest"
import { waitResolverErrorCodesFromOutput } from "./nested-scout-wait-resolver-diagnostic.js"

describe("nested Scout wait-resolver diagnostic allowlist", () => {
  it("filters unknown values before adding the diagnostic snapshot", () => {
    expect(waitResolverErrorCodesFromOutput([
      "P1143_WAIT_RESOLVER_ERROR:task_graph_prepare_or_load",
      "P1143_WAIT_RESOLVER_ERROR:error",
      "P1143_WAIT_RESOLVER_ERROR:raw_exception_message_with_identifier",
      "P1143_WAIT_RESOLVER_ERROR:task_graph_prepare_or_load:extra",
    ])).toEqual(["task_graph_prepare_or_load", "error"])
  })
})
