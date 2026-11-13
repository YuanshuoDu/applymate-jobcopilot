import type { ApplicationSubmissionEvidence } from "@/lib/agent/application-submission-evidence"

export type ApplicationSubmissionEvidenceCopy = Readonly<{
  heading: string
  workerReportLabel: string
  workerReportValue: string
  localRecordLabel: string
  localRecordValue: string
  employerReceiptLabel: string
  employerReceiptValue: string
  unavailableNotice: string | null
}>

const ENGLISH = {
  heading: "Submission details",
  workerReportLabel: "Automation result",
  workerSubmitted: "System recorded a submission",
  unknown: "Unknown",
  localRecordLabel: "Run record",
  localRecorded: "Linked",
  employerReceiptLabel: "Receipt from employer",
  employerUnverified: "Not verified",
  unavailableNotice: "Detailed submission evidence is unavailable.",
}

const CHINESE = {
  heading: "提交详情",
  workerReportLabel: "执行结果",
  workerSubmitted: "系统已记录提交",
  unknown: "未知",
  localRecordLabel: "本次操作记录",
  localRecorded: "已关联",
  employerReceiptLabel: "雇主收件",
  employerUnverified: "未核实",
  unavailableNotice: "详细提交证据不可用。",
}

export function applicationSubmissionEvidenceCopy(
  evidence: ApplicationSubmissionEvidence,
  language: string,
): ApplicationSubmissionEvidenceCopy | null {
  if (!evidence.visible) return null
  const copy = language === "zh" ? CHINESE : ENGLISH
  return {
    heading: copy.heading,
    workerReportLabel: copy.workerReportLabel,
    workerReportValue: evidence.workerReport === "submitted" ? copy.workerSubmitted : copy.unknown,
    localRecordLabel: copy.localRecordLabel,
    localRecordValue: evidence.localRecord === "recorded" ? copy.localRecorded : copy.unknown,
    employerReceiptLabel: copy.employerReceiptLabel,
    employerReceiptValue: copy.employerUnverified,
    unavailableNotice: evidence.availability === "unavailable" ? copy.unavailableNotice : null,
  }
}
