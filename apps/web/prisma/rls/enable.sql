-- Deployment-gated PostgreSQL RLS activation. See README.md.
DO $$
BEGIN
  IF current_setting('app.applymate_enable_rls', true) <> 'on' THEN
    RAISE EXCEPTION 'Set app.applymate_enable_rls=on in the controlled deployment session before enabling candidate RLS';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app_current_user_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$ SELECT NULLIF(current_setting('app.user_id', true), '') $$;

ALTER TABLE "Job" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Resume" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ResumeVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoverLetter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApplyResult" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "persona_facts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "persona_evidence_chunks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gmail_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gmail_recommendations" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS candidate_job_isolation ON "Job";
CREATE POLICY candidate_job_isolation ON "Job" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_resume_isolation ON "Resume";
CREATE POLICY candidate_resume_isolation ON "Resume" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_resume_version_isolation ON "ResumeVersion";
CREATE POLICY candidate_resume_version_isolation ON "ResumeVersion" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_cover_letter_isolation ON "CoverLetter";
CREATE POLICY candidate_cover_letter_isolation ON "CoverLetter" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_notification_isolation ON "notifications";
CREATE POLICY candidate_notification_isolation ON "notifications" USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
DROP POLICY IF EXISTS candidate_apply_result_isolation ON "ApplyResult";
CREATE POLICY candidate_apply_result_isolation ON "ApplyResult" USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
DROP POLICY IF EXISTS candidate_persona_fact_isolation ON "persona_facts";
CREATE POLICY candidate_persona_fact_isolation ON "persona_facts" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_persona_evidence_isolation ON "persona_evidence_chunks";
CREATE POLICY candidate_persona_evidence_isolation ON "persona_evidence_chunks" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_gmail_message_isolation ON "gmail_messages";
CREATE POLICY candidate_gmail_message_isolation ON "gmail_messages" USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
DROP POLICY IF EXISTS candidate_gmail_recommendation_isolation ON "gmail_recommendations";
CREATE POLICY candidate_gmail_recommendation_isolation ON "gmail_recommendations" USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
