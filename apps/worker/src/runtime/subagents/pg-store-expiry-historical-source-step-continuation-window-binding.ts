/** Requires the full bigint event window to equal the disjoint source-plus-successor proof. */
export function historicalSourceStepWindowUnionBinding(path: string): string {
  const source = `(CASE WHEN jsonb_typeof(${path}->'events') = 'array' THEN ${path}->'events' ELSE '[]'::jsonb END)`
  const continuation = `(CASE WHEN jsonb_typeof(${path}->'continuationPrefix'->'events') = 'array'
    THEN ${path}->'continuationPrefix'->'events' ELSE '[]'::jsonb END)`
  const sourceIds = `ARRAY(SELECT item.value->>'id' FROM jsonb_array_elements(${source}) AS item(value))`
  const continuationIds = `ARRAY(SELECT item.value->>'id' FROM jsonb_array_elements(${continuation}) AS item(value))`
  const sourceSequences = `ARRAY(SELECT event."sequence" FROM jsonb_array_elements(${source}) AS item(value)
    JOIN "agent_events" AS event ON event."id" = item.value->>'id' AND event."sessionId" = boundSource."sessionId"
      AND event."turnId" = boundSource."turnId" AND event."taskId" = boundSource."taskId")`
  const continuationSequences = `ARRAY(SELECT event."sequence" FROM jsonb_array_elements(${continuation}) AS item(value)
    JOIN "agent_events" AS event ON event."id" = item.value->>'id' AND event."sessionId" = boundSource."sessionId"
      AND event."turnId" = boundSource."turnId" AND event."taskId" = boundSource."taskId")`
  const first = `(SELECT event."sequence" FROM "agent_events" AS event WHERE event."id" = ${source}->0->>'id'
    AND event."sessionId" = boundSource."sessionId" AND event."turnId" = boundSource."turnId" AND event."taskId" = boundSource."taskId")`
  const last = `(SELECT event."sequence" FROM "agent_events" AS event
    WHERE event."id" = ${source}->(jsonb_array_length(${source}) - 1)->>'id'
      AND event."sessionId" = boundSource."sessionId" AND event."turnId" = boundSource."turnId" AND event."taskId" = boundSource."taskId")`
  const allWindowCount = `(SELECT COUNT(*) FROM "agent_events" AS windowEvent WHERE windowEvent."sessionId" = boundSource."sessionId"
    AND windowEvent."turnId" = boundSource."turnId" AND windowEvent."taskId" = boundSource."taskId"
    AND windowEvent."sequence" BETWEEN ${first} AND ${last})`
  const noUnknown = `NOT EXISTS (SELECT 1 FROM "agent_events" AS outsideProof WHERE outsideProof."sessionId" = boundSource."sessionId"
    AND outsideProof."turnId" = boundSource."turnId" AND outsideProof."taskId" = boundSource."taskId"
    AND outsideProof."sequence" BETWEEN ${first} AND ${last}
    AND NOT (outsideProof."id" = ANY(${sourceIds}) OR outsideProof."id" = ANY(${continuationIds})))`
  const noOverlap = `NOT EXISTS (SELECT 1 FROM unnest(${sourceIds}) AS sourceId(id)
      JOIN unnest(${continuationIds}) AS continuationId(id) USING (id))
    AND NOT EXISTS (SELECT 1 FROM unnest(${sourceSequences}) AS sourceSequence(sequence)
      JOIN unnest(${continuationSequences}) AS continuationSequence(sequence) USING (sequence))`
  return `CASE WHEN ${path} ? 'continuationPrefix' THEN
    ${allWindowCount} = jsonb_array_length(${source}) + jsonb_array_length(${continuation})
    AND ${noOverlap} AND ${noUnknown}
  ELSE ${allWindowCount} = jsonb_array_length(${source}) AND ${noUnknown} END`
}

/** Rechecks reader-bound source and sanitized continuation input digests under the locked owner scope. */
export function historicalSourceStepContinuationInputBinding(path: string): string {
  const continuation = `(${path}->'continuationPrefix')`
  const sourceContent = `${continuation}->>'sourceCallContentDigest'`
  const sourceInput = `${continuation}->>'sourceInputDigest'`
  const redactedInput = `${continuation}->>'redactedInputDigest'`
  return `(${sourceContent} ~ '^[0-9a-f]{64}$' AND ${sourceInput} ~ '^[0-9a-f]{64}$'
    AND ${redactedInput} ~ '^[0-9a-f]{64}$'
    AND encode(sha256(convert_to(boundSourceCall."content"::text,'UTF8')),'hex') = ${sourceContent}
    AND encode(sha256(convert_to((boundSourceCall."content"->'input')::text,'UTF8')),'hex') = ${sourceInput}
    AND encode(sha256(convert_to((continuationItem."content"->'input')::text,'UTF8')),'hex') = ${redactedInput})`
}
