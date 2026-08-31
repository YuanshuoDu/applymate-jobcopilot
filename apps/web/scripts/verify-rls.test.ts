import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('RLS deployment verifier contract', () => {
  it('keeps the production SQL deployment-gated and transaction-scoped', () => {
    const sql = readFileSync(new URL('../prisma/rls/enable.sql', import.meta.url), 'utf8')
    expect(sql).toContain("current_setting('app.applymate_enable_rls', true) <> 'on'")
    expect(sql).toContain("current_setting('app.user_id', true)")
    expect(sql).toContain('WITH CHECK ("userId" = app_current_user_id())')
    expect(sql).toContain("agent_turns")
    const verifier = readFileSync(new URL('./verify-rls.ts', import.meta.url), 'utf8')
    expect(verifier).toContain("has_table_privilege(current_user, expected.name, 'SELECT')")
  })
})
