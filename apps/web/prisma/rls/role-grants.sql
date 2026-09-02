-- Least-privilege role for candidate requests. Run as the Neon owner in the
-- same controlled rollout as enable.sql. The role is intentionally NOLOGIN:
-- the web connection remains the owner and uses SET LOCAL ROLE per transaction.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'applymate_candidate') THEN
    CREATE ROLE applymate_candidate NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;

GRANT applymate_candidate TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO applymate_candidate;
GRANT EXECUTE ON FUNCTION app_current_user_id() TO applymate_candidate;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "User", "Account", "Session", "user_plan_changes", "user_plan_subscriptions", "user_feature_overrides",
  "Job", "application_tasks", "application_task_events", "Resume", "ResumeVersion", "persona_facts",
  "persona_evidence_chunks", "Activity", "user_api_keys", "AgentConfig", "AgentRole", "apply_results",
  "form_patterns", "ai_budgets", "job_api_usage_events", "discovery_optimization_events", "ai_budget_adjustments", "ai_budget_reset_requests", "ai_usage_events", "external_api_usage_events", "notifications", "gmail_sync_states",
  "gmail_messages", "gmail_recommendations", "AgentRunQuestion", "agent_runs", "agent_executions",
  "agent_sessions", "agent_turns", "agent_steps", "agent_inputs", "agent_items", "agent_events", "agent_outbox",
  "sub_agent_tasks", "agent_mailbox_messages", "agent_transcript_events", "agent_approvals", "agent_action_reservations", "agent_automations",
  "CustomAgentRole", "Direction", "CoverLetter", "support_cases", "support_case_messages",
  "support_case_escalations", "admin_data_deletion_requests"
TO applymate_candidate;

-- These are platform catalogues, not tenant data. Candidate pages may read them,
-- but they must not be writable by the candidate role.
GRANT SELECT ON TABLE "plan_catalogue" TO applymate_candidate;

-- ApplyResult uses a PostgreSQL identity sequence. Sequence privileges are not
-- covered by table INSERT privileges, so grant only sequence usage/read access.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO applymate_candidate;
