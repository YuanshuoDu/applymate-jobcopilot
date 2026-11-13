import { describe, expect, it } from "vitest"
import { unknownApplicationSubmissionEvidence } from "@/lib/agent/application-submission-evidence"
import { applicationSubmissionEvidenceCopy } from "./application-submission-evidence-copy"

describe("application submission evidence copy", () => {
  it("returns no evidence section for an invisible Task", () => {
    expect(applicationSubmissionEvidenceCopy(unknownApplicationSubmissionEvidence(false, "unknown"), "en")).toBeNull()
  })

  it("uses English for the default and unsupported languages", () => {
    const evidence = unknownApplicationSubmissionEvidence(true, "unavailable")
    const copy = applicationSubmissionEvidenceCopy(evidence, "de")
    expect(copy).toEqual({
      heading: "Submission details",
      workerReportLabel: "Automation result",
      workerReportValue: "Unknown",
      localRecordLabel: "Run record",
      localRecordValue: "Unknown",
      employerReceiptLabel: "Employer receipt",
      employerReceiptValue: "Not verified",
      unavailableNotice: "Detailed submission evidence is unavailable.",
    })
  })

  it("uses focused Chinese copy from the existing language setting", () => {
    const copy = applicationSubmissionEvidenceCopy(unknownApplicationSubmissionEvidence(true, "unknown"), "zh")
    expect(copy).toMatchObject({
      heading: "提交详情",
      workerReportLabel: "执行结果",
      workerReportValue: "未知",
      localRecordLabel: "本次操作记录",
      localRecordValue: "未知",
      employerReceiptLabel: "雇主收件",
      employerReceiptValue: "未核实",
      unavailableNotice: null,
    })
  })
})
