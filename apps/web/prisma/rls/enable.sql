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

ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_plan_changes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_plan_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_feature_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Job" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "application_tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "application_task_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Resume" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ResumeVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "persona_facts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "persona_evidence_chunks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Activity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_api_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentConfig" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentRole" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "apply_results" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "form_patterns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_budgets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_usage_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "external_api_usage_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_budget_adjustments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_budget_reset_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gmail_sync_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gmail_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gmail_recommendations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentRunQuestion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_executions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sub_agent_tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_transcript_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_approvals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_automations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CustomAgentRole" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Direction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoverLetter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_cases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_case_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_case_escalations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "admin_data_deletion_requests" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS candidate_user_isolation ON "User";
CREATE POLICY candidate_user_isolation ON "User" USING ("id" = app_current_user_id()) WITH CHECK ("id" = app_current_user_id());
DROP POLICY IF EXISTS candidate_account_isolation ON "Account";
CREATE POLICY candidate_account_isolation ON "Account" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_session_isolation ON "Session";
CREATE POLICY candidate_session_isolation ON "Session" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_plan_change_isolation ON "user_plan_changes";
CREATE POLICY candidate_plan_change_isolation ON "user_plan_changes" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_plan_subscription_isolation ON "user_plan_subscriptions";
CREATE POLICY candidate_plan_subscription_isolation ON "user_plan_subscriptions" USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
DROP POLICY IF EXISTS candidate_feature_override_isolation ON "user_feature_overrides";
CREATE POLICY candidate_feature_override_isolation ON "user_feature_overrides" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_job_isolation ON "Job";
CREATE POLICY candidate_job_isolation ON "Job" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_application_task_isolation ON "application_tasks";
CREATE POLICY candidate_application_task_isolation ON "application_tasks" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_application_task_event_isolation ON "application_task_events";
CREATE POLICY candidate_application_task_event_isolation ON "application_task_events"
  USING (EXISTS (SELECT 1 FROM "application_tasks" task WHERE task."id" = "taskId" AND task."userId" = app_current_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "application_tasks" task WHERE task."id" = "taskId" AND task."userId" = app_current_user_id()));
DROP POLICY IF EXISTS candidate_resume_isolation ON "Resume";
CREATE POLICY candidate_resume_isolation ON "Resume" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_resume_version_isolation ON "ResumeVersion";
CREATE POLICY candidate_resume_version_isolation ON "ResumeVersion" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_persona_fact_isolation ON "persona_facts";
CREATE POLICY candidate_persona_fact_isolation ON "persona_facts" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_persona_evidence_isolation ON "persona_evidence_chunks";
CREATE POLICY candidate_persona_evidence_isolation ON "persona_evidence_chunks" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_activity_isolation ON "Activity";
CREATE POLICY candidate_activity_isolation ON "Activity" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_api_key_isolation ON "user_api_keys";
CREATE POLICY candidate_api_key_isolation ON "user_api_keys" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_agent_config_isolation ON "AgentConfig";
CREATE POLICY candidate_agent_config_isolation ON "AgentConfig" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_agent_role_isolation ON "AgentRole";
CREATE POLICY candidate_agent_role_isolation ON "AgentRole" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_apply_result_isolation ON "apply_results";
CREATE POLICY candidate_apply_result_isolation ON "apply_results" USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
DROP POLICY IF EXISTS candidate_form_pattern_isolation ON "form_patterns";
CREATE POLICY candidate_form_pattern_isolation ON "form_patterns" USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
DROP POLICY IF EXISTS candidate_ai_budget_isolation ON "ai_budgets";
CREATE POLICY candidate_ai_budget_isolation ON "ai_budgets" USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
DROP POLICY IF EXISTS candidate_ai_usage_event_isolation ON "ai_usage_events";
CREATE POLICY candidate_ai_usage_event_isolation ON "ai_usage_events" USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
DROP POLICY IF EXISTS candidate_external_api_usage_event_isolation ON "external_api_usage_events";
CREATE POLICY candidate_external_api_usage_event_isolation ON "external_api_usage_events" USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
DROP POLICY IF EXISTS candidate_ai_budget_adjustment_isolation ON "ai_budget_adjustments";
CREATE POLICY candidate_ai_budget_adjustment_isolation ON "ai_budget_adjustments"
  USING (EXISTS (SELECT 1 FROM "ai_budgets" budget WHERE budget."id" = "budget_id" AND budget."user_id" = app_current_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "ai_budgets" budget WHERE budget."id" = "budget_id" AND budget."user_id" = app_current_user_id()));
DROP POLICY IF EXISTS candidate_ai_budget_reset_isolation ON "ai_budget_reset_requests";
CREATE POLICY candidate_ai_budget_reset_isolation ON "ai_budget_reset_requests"
  USING (EXISTS (SELECT 1 FROM "ai_budgets" budget WHERE budget."id" = "budget_id" AND budget."user_id" = app_current_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "ai_budgets" budget WHERE budget."id" = "budget_id" AND budget."user_id" = app_current_user_id()));
DROP POLICY IF EXISTS candidate_notification_isolation ON "notifications";
CREATE POLICY candidate_notification_isolation ON "notifications" USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
DROP POLICY IF EXISTS candidate_gmail_sync_state_isolation ON "gmail_sync_states";
CREATE POLICY candidate_gmail_sync_state_isolation ON "gmail_sync_states" USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
DROP POLICY IF EXISTS candidate_gmail_message_isolation ON "gmail_messages";
CREATE POLICY candidate_gmail_message_isolation ON "gmail_messages" USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
DROP POLICY IF EXISTS candidate_gmail_recommendation_isolation ON "gmail_recommendations";
CREATE POLICY candidate_gmail_recommendation_isolation ON "gmail_recommendations" USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
DROP POLICY IF EXISTS candidate_agent_run_question_isolation ON "AgentRunQuestion";
CREATE POLICY candidate_agent_run_question_isolation ON "AgentRunQuestion" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_agent_run_isolation ON "agent_runs";
CREATE POLICY candidate_agent_run_isolation ON "agent_runs" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_agent_execution_isolation ON "agent_executions";
CREATE POLICY candidate_agent_execution_isolation ON "agent_executions" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_agent_session_isolation ON "agent_sessions";
CREATE POLICY candidate_agent_session_isolation ON "agent_sessions" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_sub_agent_task_isolation ON "sub_agent_tasks";
CREATE POLICY candidate_sub_agent_task_isolation ON "sub_agent_tasks"
  USING (EXISTS (SELECT 1 FROM "agent_sessions" session WHERE session."id" = "sessionId" AND session."userId" = app_current_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "agent_sessions" session WHERE session."id" = "sessionId" AND session."userId" = app_current_user_id()));
DROP POLICY IF EXISTS candidate_agent_transcript_isolation ON "agent_transcript_events";
CREATE POLICY candidate_agent_transcript_isolation ON "agent_transcript_events"
  USING (EXISTS (SELECT 1 FROM "agent_sessions" session WHERE session."id" = "sessionId" AND session."userId" = app_current_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "agent_sessions" session WHERE session."id" = "sessionId" AND session."userId" = app_current_user_id()));
DROP POLICY IF EXISTS candidate_agent_approval_isolation ON "agent_approvals";
CREATE POLICY candidate_agent_approval_isolation ON "agent_approvals" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_agent_automation_isolation ON "agent_automations";
CREATE POLICY candidate_agent_automation_isolation ON "agent_automations" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_custom_agent_role_isolation ON "CustomAgentRole";
CREATE POLICY candidate_custom_agent_role_isolation ON "CustomAgentRole" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_direction_isolation ON "Direction";
CREATE POLICY candidate_direction_isolation ON "Direction" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_cover_letter_isolation ON "CoverLetter";
CREATE POLICY candidate_cover_letter_isolation ON "CoverLetter" USING ("userId" = app_current_user_id()) WITH CHECK ("userId" = app_current_user_id());
DROP POLICY IF EXISTS candidate_support_case_isolation ON "support_cases";
CREATE POLICY candidate_support_case_isolation ON "support_cases" USING ("requester_user_id" = app_current_user_id()) WITH CHECK ("requester_user_id" = app_current_user_id());
DROP POLICY IF EXISTS candidate_support_case_message_isolation ON "support_case_messages";
CREATE POLICY candidate_support_case_message_isolation ON "support_case_messages"
  USING (EXISTS (SELECT 1 FROM "support_cases" support_case WHERE support_case."id" = "case_id" AND support_case."requester_user_id" = app_current_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "support_cases" support_case WHERE support_case."id" = "case_id" AND support_case."requester_user_id" = app_current_user_id()));
DROP POLICY IF EXISTS candidate_support_case_escalation_isolation ON "support_case_escalations";
CREATE POLICY candidate_support_case_escalation_isolation ON "support_case_escalations"
  USING (EXISTS (SELECT 1 FROM "support_cases" support_case WHERE support_case."id" = "case_id" AND support_case."requester_user_id" = app_current_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "support_cases" support_case WHERE support_case."id" = "case_id" AND support_case."requester_user_id" = app_current_user_id()));
DROP POLICY IF EXISTS candidate_deletion_request_isolation ON "admin_data_deletion_requests";
CREATE POLICY candidate_deletion_request_isolation ON "admin_data_deletion_requests" USING ("user_id" = app_current_user_id()) WITH CHECK ("user_id" = app_current_user_id());
