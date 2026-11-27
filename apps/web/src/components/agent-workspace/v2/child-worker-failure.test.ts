import { describe, expect, it } from "vitest"
import { childWorkerFailureText, projectChildWorkerFailure } from "./child-worker-failure"

describe("child worker failure projection", () => {
  it("maps only exact failed deadline and verification reasons", () => {
    expect(projectChildWorkerFailure("failed", "task_graph_child_deadline_exceeded")).toBe("deadline_exceeded")
    expect(projectChildWorkerFailure("failed", "task_graph_verification_failed")).toBe("verification_failed")
    expect(projectChildWorkerFailure("failed", "task_graph_verification_unverified")).toBe("verification_unverified")
    expect(projectChildWorkerFailure("failed", "task_graph_dependency_scope_mismatch")).toBe("dependency_unavailable_or_incompatible")
    expect(projectChildWorkerFailure("failed", "writer_dependency_unavailable")).toBe("dependency_unavailable_or_incompatible")
    for (const reason of ["child_resume_unavailable", "child_resume_evidence_unavailable", "child_resume_wait_step_lineage"]) {
      expect(projectChildWorkerFailure("failed", reason)).toBe("recovery_unavailable")
    }
    for (const status of ["queued", "running", "completed", "interrupted"]) {
      expect(projectChildWorkerFailure(status, "task_graph_child_deadline_exceeded")).toBeUndefined()
    }
    for (const reason of ["private provider failure", "task_graph_child_deadline_exceeded:secret", "", null, 7]) {
      expect(projectChildWorkerFailure("failed", reason)).toBeUndefined()
    }
  })

  it("renders fixed Chinese or English explanations without exposing reason codes", () => {
    expect(childWorkerFailureText("deadline_exceeded", "en")).toBe("The task reached its time limit.")
    expect(childWorkerFailureText("deadline_exceeded", "zh")).toBe("子任务已达到时间上限。")
    expect(childWorkerFailureText("verification_failed", "en")).toBe("The task did not meet its verification checks.")
    expect(childWorkerFailureText("verification_failed", "zh")).toBe("子任务未通过验证检查。")
    expect(childWorkerFailureText("verification_unverified", "en")).toBe("The task result could not be verified.")
    expect(childWorkerFailureText("verification_unverified", "zh")).toBe("无法验证子任务结果。")
    expect(childWorkerFailureText("dependency_unavailable_or_incompatible", "en")).toBe("A required dependency was unavailable or incompatible.")
    expect(childWorkerFailureText("dependency_unavailable_or_incompatible", "zh")).toBe("必需的依赖项不可用或不兼容。")
    expect(childWorkerFailureText("recovery_unavailable", "en")).toBe("The task's saved state could not be recovered.")
    expect(childWorkerFailureText("recovery_unavailable", "zh")).toBe("无法恢复子任务的已保存状态。")
  })
})
