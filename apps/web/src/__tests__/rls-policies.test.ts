import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const rlsRoot = fileURLToPath(new URL('../../prisma/rls/', import.meta.url))

describe('candidate RLS rollout SQL', () => {
  it('keeps activation deployment-gated and covers tenant child tables', () => {
    const sql = readFileSync(`${rlsRoot}enable.sql`, 'utf8')
    expect(sql).toContain("current_setting('app.applymate_enable_rls', true) <> 'on'")
    for (const table of ['"User"', '"application_tasks"', '"application_task_events"', '"apply_results"', '"form_patterns"', '"ai_budgets"', '"ai_usage_events"', '"external_api_usage_events"', '"ai_budget_adjustments"', '"agent_sessions"', '"sub_agent_tasks"', '"support_cases"', '"support_case_messages"']) {
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
    }
    expect(sql).toContain('candidate_application_task_event_isolation')
    expect(sql).toContain('candidate_form_pattern_isolation')
    expect(sql).toContain('candidate_ai_usage_event_isolation')
    expect(sql).toContain('candidate_support_case_message_isolation')
  })

  it('defines a non-login, non-bypass candidate role with no broad table grant', () => {
    const sql = readFileSync(`${rlsRoot}role-grants.sql`, 'utf8')
    expect(sql).toContain('CREATE ROLE applymate_candidate NOLOGIN NOSUPERUSER')
    expect(sql).toContain('NOBYPASSRLS')
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE')
    expect(sql).toContain('"form_patterns"')
    expect(sql).toContain('"ai_usage_events"')
    expect(sql).not.toContain('GRANT ALL PRIVILEGES ON ALL TABLES')
  })
})
