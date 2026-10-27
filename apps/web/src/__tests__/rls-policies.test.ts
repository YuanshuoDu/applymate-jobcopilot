import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const rlsRoot = fileURLToPath(new URL('../../prisma/rls/', import.meta.url))

describe('candidate RLS rollout SQL', () => {
  it('keeps activation deployment-gated and covers tenant child tables', () => {
    const sql = readFileSync(`${rlsRoot}enable.sql`, 'utf8')
    expect(sql).toContain("current_setting('app.applymate_enable_rls', true) <> 'on'")
    for (const table of ['"User"', '"application_tasks"', '"application_task_events"', '"apply_results"', '"form_patterns"', '"ai_budgets"', '"job_api_usage_events"', '"discovery_optimization_events"', '"ai_usage_events"', '"external_api_usage_events"', '"ai_budget_adjustments"', '"agent_sessions"', '"agent_turns"', '"agent_steps"', '"agent_inputs"', '"agent_items"', '"agent_events"', '"agent_outbox"', '"sub_agent_tasks"', '"agent_mailbox_messages"', '"agent_action_reservations"', '"support_cases"', '"support_case_messages"']) {
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
    }
    expect(sql).toContain('candidate_application_task_event_isolation')
    expect(sql).toContain('candidate_form_pattern_isolation')
    expect(sql).toContain('candidate_ai_usage_event_isolation')
    expect(sql).toContain('candidate_job_api_usage_event_isolation')
    expect(sql).toContain('candidate_discovery_optimization_event_isolation')
    expect(sql).toContain('candidate_agent_turn_isolation')
    expect(sql).toContain('candidate_agent_step_isolation')
    expect(sql).toContain('candidate_agent_input_isolation')
    expect(sql).toContain('candidate_agent_item_isolation')
    expect(sql).toContain('candidate_agent_event_isolation')
    expect(sql).toContain('candidate_agent_outbox_isolation')
    expect(sql).toContain('candidate_agent_mailbox_message_isolation')
    expect(sql).toContain('candidate_agent_action_reservation_isolation')
    expect(sql).toContain('candidate_support_case_message_isolation')
  })

  it('defines a non-login, non-bypass candidate role with no broad table grant', () => {
    const sql = readFileSync(`${rlsRoot}role-grants.sql`, 'utf8')
    expect(sql).toContain('CREATE ROLE applymate_candidate NOLOGIN NOSUPERUSER')
    expect(sql).toContain('NOBYPASSRLS')
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE')
    expect(sql).toContain('"form_patterns"')
    expect(sql).toContain('"ai_usage_events"')
    expect(sql).toContain('"job_api_usage_events"')
    expect(sql).toContain('"discovery_optimization_events"')
    for (const table of ['"agent_turns"', '"agent_steps"', '"agent_inputs"', '"agent_items"', '"agent_events"', '"agent_outbox"', '"agent_action_reservations"']) {
      expect(sql).toContain(table)
    }
    expect(sql).toContain('GRANT SELECT ON TABLE "agent_wait_conditions" TO applymate_candidate')
    const broadGrantStart = sql.indexOf('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE')
    const broadGrantEnd = sql.indexOf('\nTO applymate_candidate;', broadGrantStart)
    expect(broadGrantStart).toBeGreaterThanOrEqual(0)
    expect(broadGrantEnd).toBeGreaterThan(broadGrantStart)
    expect(sql.slice(broadGrantStart, broadGrantEnd)).not.toContain('"agent_wait_conditions"')
    expect(sql).not.toContain('GRANT ALL PRIVILEGES ON ALL TABLES')
  })

  it('keeps agent wait visibility scoped to the current tenant', () => {
    const migration = readFileSync(fileURLToPath(new URL('../../prisma/migrations/20260908030000_add_agent_tool_result_references/migration.sql', import.meta.url)), 'utf8')
    expect(migration).toContain('ALTER TABLE "agent_wait_conditions" ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('CREATE POLICY agent_wait_condition_user_isolation')
    expect(migration).toContain('USING ("userId" = NULLIF(current_setting(\'app.user_id\', true), \'\'))')
    expect(migration).toContain('WITH CHECK ("userId" = NULLIF(current_setting(\'app.user_id\', true), \'\'))')
  })
})
