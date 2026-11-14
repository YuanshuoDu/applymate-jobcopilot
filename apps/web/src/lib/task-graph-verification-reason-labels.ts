import type { TaskGraphVerificationDisplayReason } from '@jobcopilot/agent-protocol'
import type { Lang } from './i18n'

const labels = {
  en: {
    criterion_unmet: 'Check requirement not met',
    score_below_minimum: 'Reported score below minimum',
    verification_contract_invalid: 'Verification contract invalid',
    evidence_projection_invalid: 'Evidence projection invalid',
    verification_role_mismatch: 'Verification role mismatch',
    required_evidence_missing: 'Required canonical evidence missing',
    evidence_invalid: 'Canonical evidence invalid',
    evidence_ambiguous: 'Canonical evidence ambiguous',
    task_result_invalid: 'Task result invalid',
    task_result_ambiguous: 'Task result ambiguous',
    result_not_evidence_bound: 'Result not bound to evidence',
  },
  zh: {
    criterion_unmet: '检查要求未满足',
    score_below_minimum: '报告分数低于最低要求',
    verification_contract_invalid: '验证契约无效',
    evidence_projection_invalid: '证据投影无效',
    verification_role_mismatch: '验证角色不匹配',
    required_evidence_missing: '缺少所需的规范证据',
    evidence_invalid: '规范证据无效',
    evidence_ambiguous: '规范证据不明确',
    task_result_invalid: '任务结果无效',
    task_result_ambiguous: '任务结果不明确',
    result_not_evidence_bound: '结果未绑定到证据',
  },
} satisfies Record<'en' | 'zh', Record<TaskGraphVerificationDisplayReason, string>>

export function taskGraphVerificationReasonLabel(lang: Lang, reason: TaskGraphVerificationDisplayReason): string {
  return lang === 'zh' ? labels.zh[reason] : labels.en[reason]
}
