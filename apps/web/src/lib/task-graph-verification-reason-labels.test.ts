import { describe, expect, it } from 'vitest'

import { taskGraphVerificationReasonLabel } from './task-graph-verification-reason-labels'

const labels = [
  ['criterion_unmet', 'Check requirement not met', '检查要求未满足'],
  ['score_below_minimum', 'Reported score below minimum', '报告分数低于最低要求'],
  ['verification_contract_invalid', 'Verification contract invalid', '验证契约无效'],
  ['evidence_projection_invalid', 'Evidence projection invalid', '证据投影无效'],
  ['verification_role_mismatch', 'Verification role mismatch', '验证角色不匹配'],
  ['required_evidence_missing', 'Required canonical evidence missing', '缺少所需的规范证据'],
  ['evidence_invalid', 'Canonical evidence invalid', '规范证据无效'],
  ['evidence_ambiguous', 'Canonical evidence ambiguous', '规范证据不明确'],
  ['task_result_invalid', 'Task result invalid', '任务结果无效'],
  ['task_result_ambiguous', 'Task result ambiguous', '任务结果不明确'],
  ['result_not_evidence_bound', 'Result not bound to evidence', '结果未绑定到证据'],
] as const

describe('TaskGraph verification reason labels', () => {
  it('maps every bounded display reason to fixed English and Chinese copy', () => {
    for (const [reason, english, chinese] of labels) {
      expect(taskGraphVerificationReasonLabel('en', reason)).toBe(english)
      expect(taskGraphVerificationReasonLabel('zh', reason)).toBe(chinese)
    }
  })
})
