import type { TaskGraphTaskTemplate } from "./task-graph-command-port.js"
import {
  SCHEDULED_POST_GATE_AUDIT_OUTPUT_SCHEMA, SCHEDULED_POST_GATE_AUDIT_ROLE, SCHEDULED_POST_GATE_AUDIT_TASK_TYPE,
  SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID, SCHEDULED_POST_GATE_EXECUTE_OUTPUT_SCHEMA, SCHEDULED_POST_GATE_EXECUTE_ROLE,
  SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE, SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID,
} from "./scheduled-post-gate-contract.js"

export function scheduledPostGateTaskTemplates(): Readonly<Record<string, TaskGraphTaskTemplate>> {
  return Object.freeze({
    [SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID]: Object.freeze({
      role: SCHEDULED_POST_GATE_EXECUTE_ROLE,
      taskType: SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE,
      allowedActions: Object.freeze([]),
      constraints: Object.freeze([
        "Run only the server-bound packageRefs attached to this scheduled Execute task.",
        "Use the existing non-submitting Execute behavior; never submit applications or send Gmail.",
      ]),
      expectedOutputSchema: SCHEDULED_POST_GATE_EXECUTE_OUTPUT_SCHEMA,
      maxAttempts: 1,
    }),
    [SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID]: Object.freeze({
      role: SCHEDULED_POST_GATE_AUDIT_ROLE,
      taskType: SCHEDULED_POST_GATE_AUDIT_TASK_TYPE,
      allowedActions: Object.freeze([]),
      constraints: Object.freeze([
        "Run existing scheduled Audit behavior after all scheduled Execute dependencies finish.",
        "Preserve current report semantics; never submit applications or send Gmail.",
      ]),
      expectedOutputSchema: SCHEDULED_POST_GATE_AUDIT_OUTPUT_SCHEMA,
      maxAttempts: 1,
    }),
  })
}
