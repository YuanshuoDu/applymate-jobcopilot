import { historicalSourceStepCallChainSql } from "./pg-store-expiry-historical-source-step-call-binding.js"

/** Failure probes expose only bounded booleans while reusing the production predicates. */
export function historicalSourceStepCallChainDiagnosticSql(path: string): Readonly<{
  itemCardinality: string; allItems: string; commentCardinality: string; eventCardinality: string; anchorChain: string; finalClose: string
  validCallCount: string; callCount: string; perCallChecks: string
}> {
  const parts = historicalSourceStepCallChainSql(path)
  const perCallChecks = `(SELECT COALESCE(jsonb_agg(checks."flags" ORDER BY checks."callItemId"), '[]'::jsonb) FROM (
    SELECT callItem."id" AS "callItemId", jsonb_build_object('isSourceWait', callItem."id" = boundSourceCall."id",
      'contentValid', (${parts.validCallItem}), 'eventChainValid', ${parts.chain}) AS "flags"
    FROM "agent_items" AS callItem WHERE ${parts.callScope} ORDER BY callItem."id" LIMIT 17) AS checks)`
  return { itemCardinality: parts.itemCardinality, allItems: parts.allItems, commentCardinality: parts.commentCardinality,
    eventCardinality: parts.eventCardinality, anchorChain: parts.anchorChain, finalClose: parts.finalClose,
    validCallCount: parts.validCallCount, callCount: parts.callCount, perCallChecks }
}
