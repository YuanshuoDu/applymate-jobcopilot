-- Tenant-scoped readers and writers must never access another user's ledger.
-- Table owners keep their existing bypass for trusted workers and administration.
DO $$
BEGIN
  ALTER TABLE "ai_usage_events" ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "ai_usage_events_user_isolation" ON "ai_usage_events"
    USING ("user_id" = NULLIF(current_setting('app.user_id', true), ''))
    WITH CHECK ("user_id" = NULLIF(current_setting('app.user_id', true), ''));
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'applymate_candidate') THEN
    -- Remove direct table-wide writes before restoring the broker's required columns.
    -- Inherited and PUBLIC privileges are not affected; audit effective grants separately.
    REVOKE UPDATE, DELETE ON TABLE "ai_usage_events" FROM applymate_candidate;
    GRANT SELECT, INSERT ON TABLE "ai_usage_events" TO applymate_candidate;
    GRANT UPDATE (status, input_tokens, output_tokens, estimated_cost_usd, error_code)
      ON TABLE "ai_usage_events" TO applymate_candidate;
  END IF;
END
$$;
