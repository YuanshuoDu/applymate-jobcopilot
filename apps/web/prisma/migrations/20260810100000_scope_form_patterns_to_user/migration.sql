DO $$
BEGIN
  IF to_regclass('public.form_patterns') IS NULL THEN
    CREATE TABLE form_patterns (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      ats_host TEXT NOT NULL,
      url_pattern TEXT NOT NULL,
      field_mapping JSONB NOT NULL,
      success_count INTEGER NOT NULL DEFAULT 1,
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_success_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  ELSE
    ALTER TABLE form_patterns ADD COLUMN IF NOT EXISTS user_id TEXT;
    UPDATE form_patterns SET user_id = 'legacy-global' WHERE user_id IS NULL;
    ALTER TABLE form_patterns ALTER COLUMN user_id SET NOT NULL;
  END IF;
END $$;

ALTER TABLE form_patterns DROP CONSTRAINT IF EXISTS form_patterns_ats_host_url_pattern_key;
CREATE UNIQUE INDEX IF NOT EXISTS form_patterns_user_host_pattern_key
  ON form_patterns (user_id, ats_host, url_pattern);
