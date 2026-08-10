import type { Page } from "playwright-core";
import type { ApplyTaskPayload, ApplyResult } from "@jobcopilot/shared";
import { loadWorkerAiConfig, callLlmText, type AiConfig } from "@jobcopilot/shared/llm";
import { perceiveFields, type PerceivedField } from "./dom-extractor.js";
import {
  buildSystemPrompt,
  buildUserMessage,
  parseAction,
  type AgentAction,
  type TurnLog,
} from "./harness-prompt.js";

const SENSITIVE_FIELD = /salary|compensation|pay|visa|sponsor|work.?authori[sz]|citizen|nationality|legal|criminal|disability|gender|race|ethnic|signature|e-?sign/i;

/** Config passed to AgentHarness constructor */
export interface HarnessConfig {
  userId: string;
  maxTurns: number;
  dryRun: boolean;
  mode: "dom" | "vision" | "hybrid";
}

/** Task data passed to harness.run() */
export type HarnessResult = Pick<ApplyResult, "status" | "error" | "durationMs"> &
  Partial<Pick<ApplyResult, "id" | "userId" | "jobId" | "mode" | "atsType" | "flowUsed" | "createdAt">> & {
  turns?: number;
  log?: unknown[];
  fieldMappings?: Record<string, string>;
  /** The form was filled but intentionally not submitted. */
  reviewReady?: boolean;
};

export interface ApplyTask {
  jobId: string;
  applyUrl: string;
  persona: Record<string, string>;
  jobTitle: string;
  jobCompany: string;
  jobKeywords?: string;
  resumePath: string;
  coverLetterPath?: string;
  dryRun?: boolean;
  allowSubmit?: boolean;
  /** Re-evaluates runtime controls before a submit or generic click can advance a form. */
  beforeSubmit?: () => Promise<boolean>;
  /** Per-application values explicitly entered by the candidate after a pause. */
  confirmedAnswers?: Record<string, string>;
}

const SUCCESS_URL_PATTERNS = [
  /thank/i,
  /success/i,
  /confirmation/i,
  /submitted/i,
];

export class AgentHarness {
  private config: HarnessConfig;
  private turns: TurnLog[] = [];
  private aiConfig: AiConfig | null = null;

  constructor(config: HarnessConfig) {
    this.config = config;
  }

  /** Resolve AI config lazily (cached per instance) */
  private async getAiConfig(): Promise<AiConfig> {
    if (!this.aiConfig) {
      this.aiConfig = await loadWorkerAiConfig(this.config.userId);
    }
    return this.aiConfig;
  }

  /** Call the LLM with chat messages */
  private async callLLM(
    messages: Array<{ role: string; content: string }>
  ): Promise<string> {
    const config = await this.getAiConfig();
    return callLlmText(
      messages as Array<{ role: "system" | "user" | "assistant"; content: string }>,
      config
    );
  }

  /** Run the perception-action loop until termination. */
  async run(page: Page, task: ApplyTask): Promise<HarnessResult> {
    this.turns = [];
    const startedAt = Date.now();

    try {
      const systemPrompt = buildSystemPrompt(task.persona,
        {
          title: task.jobTitle,
          company: task.jobCompany,
          keywords: task.jobKeywords,
        },
        task.confirmedAnswers ?? {},
      );

      const messages: Array<{ role: string; content: string }> = [
        { role: "system", content: systemPrompt },
      ];

      for (let turn = 0; turn < this.config.maxTurns; turn++) {
        const turnStart = Date.now();

        // ── Perceive ──
        let fields: PerceivedField[] = [];
        try {
          fields = await perceiveFields(page);
        } catch (err) {
          const logEntry: TurnLog = {
            turn,
            perceived: [],
            action: { type: "manual", reasoning: `DOM perception failed: ${err instanceof Error ? err.message : String(err)}` },
            durationMs: Date.now() - turnStart,
          };
          this.turns.push(logEntry);
          this.logTurn(logEntry);
          return this.buildResult("manual", task.jobId, Date.now() - startedAt, logEntry.action.reasoning);
        }

        const url = page.url();

        // ── Check URL-based success ──
        if (SUCCESS_URL_PATTERNS.some((p) => p.test(url))) {
          const fieldMappings = this.collectFieldMappings();
          const logEntry: TurnLog = {
            turn,
            perceived: fields,
            action: { type: "done", reasoning: `URL pattern match: ${url}` },
            durationMs: Date.now() - turnStart,
          };
          this.turns.push(logEntry);
          this.logTurn(logEntry);
          if (task.allowSubmit === false || !await submissionAuthorized(task)) {
            return this.buildUncertainSubmissionResult(task.jobId, Date.now() - startedAt, fieldMappings);
          }
          return this.buildResult("submitted", task.jobId, Date.now() - startedAt, undefined, fieldMappings);
        }

        // ── Decide ──
        const userMsg = buildUserMessage(fields, url, task.resumePath, task.coverLetterPath);
        messages.push({ role: "user", content: userMsg });

        let rawResponse: string;
        try {
          rawResponse = await this.callLLM(messages);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const logEntry: TurnLog = {
            turn,
            perceived: fields,
            action: { type: "manual", reasoning: `LLM call failed: ${msg}` },
            durationMs: Date.now() - turnStart,
          };
          this.turns.push(logEntry);
          this.logTurn(logEntry);
          return this.buildResult("failed", task.jobId, Date.now() - startedAt, msg);
        }

        messages.push({ role: "assistant", content: rawResponse });

        const action = parseAction(rawResponse);
        if (!action) {
          const logEntry: TurnLog = {
            turn,
            perceived: fields,
            action: { type: "manual", reasoning: `Failed to parse LLM response: ${rawResponse.substring(0, 200)}` },
            durationMs: Date.now() - turnStart,
          };
          this.turns.push(logEntry);
          this.logTurn(logEntry);
          return this.buildResult("manual", task.jobId, Date.now() - startedAt, "LLM response parse failure");
        }

        const durationMs = Date.now() - turnStart;
        const logEntry: TurnLog = { turn, perceived: fields, action, durationMs };
        this.turns.push(logEntry);
        this.logTurn(logEntry);

        // ── Terminal actions ──
        if (action.type === "done") {
          if (task.allowSubmit === false) {
            return this.buildReviewResult(task.jobId, Date.now() - startedAt);
          }
          if (!await submissionAuthorized(task)) {
            return this.buildReviewResult(task.jobId, Date.now() - startedAt);
          }
          return this.buildResult("submitted", task.jobId, Date.now() - startedAt, undefined, this.collectFieldMappings());
        }

        if (!isAllowedSensitiveAction(action, fields, task.confirmedAnswers)) {
          return this.buildResult(
            "manual",
            task.jobId,
            Date.now() - startedAt,
            "A sensitive form answer needs an explicit, matching candidate confirmation.",
          );
        }
        if (action.type === "manual") {
          return this.buildResult("manual", task.jobId, Date.now() - startedAt, action.reasoning);
        }
        if (action.type === "submit") {
          if (task.allowSubmit === false || !await submissionAuthorized(task)) {
            return this.buildReviewResult(task.jobId, Date.now() - startedAt);
          }
        }
        if (action.type === "click" && action.selector) {
          // Fill-only passes may still need safe clicks for custom controls
          // such as comboboxes. Keep the submit heuristic as the boundary so
          // those controls remain usable without enabling form submission.
          if (task.allowSubmit === false) {
            if (await clickMaySubmit(page, action.selector)) {
              return this.buildReviewResult(task.jobId, Date.now() - startedAt);
            }
          } else {
            // A live Worker authorization gates every generic click because a
            // custom form control can submit through a JavaScript handler.
            const needsAuthorization = task.beforeSubmit ? true : await clickMaySubmit(page, action.selector);
            if (needsAuthorization && !await submissionAuthorized(task)) {
              return this.buildReviewResult(task.jobId, Date.now() - startedAt);
            }
          }
        }

        // ── Execute ──
        if (this.config.dryRun) {
          if (["fill", "click", "select", "upload", "submit"].includes(action.type)) {
            continue;
          }
        }

        try {
          await this.executeAction(page, action, task, fields);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const failEntry: TurnLog = {
            turn,
            perceived: fields,
            action: { type: "manual", reasoning: `Action execution failed: ${msg}` },
            durationMs: Date.now() - turnStart,
          };
          this.turns.push(failEntry);
          this.logTurn(failEntry);
          return this.buildResult("failed", task.jobId, Date.now() - startedAt, msg);
        }
      }

      return this.buildResult("failed", task.jobId, Date.now() - startedAt, `Max turns (${this.config.maxTurns}) reached`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.buildResult("failed", task.jobId, Date.now() - startedAt, msg);
    }
  }

  private async executeAction(page: Page, action: AgentAction, task: ApplyTask, fields: PerceivedField[]): Promise<void> {
    switch (action.type) {
      case "fill": {
        if (!action.selector || action.value === undefined) return;
        await this.humanType(page, action.selector, action.value);
        break;
      }
      case "click": {
        if (!action.selector) return;
        await page.click(action.selector);
        break;
      }
      case "select": {
        if (!action.selector || action.value === undefined) return;
        await page.selectOption(action.selector, action.value);
        break;
      }
      case "upload": {
        if (!action.selector) return;
        const filePath = uploadPathForField(action, fields, task);
        if (!filePath) return;
        await page.setInputFiles(action.selector, filePath);
        break;
      }
      case "scroll": {
        await page.evaluate(() => window.scrollBy(0, 400));
        break;
      }
      case "wait": {
        const ms = Math.min(Number(action.value) || 1000, 5000);
        await page.waitForTimeout(ms);
        break;
      }
      case "submit": {
        if (action.selector) {
          await page.click(action.selector);
        }
        try {
          await page.waitForURL(SUCCESS_URL_PATTERNS[0], { timeout: 10_000 });
        } catch {
          // Navigation may take longer
        }
        break;
      }
    }
  }

  private async humanType(page: Page, selector: string, text: string): Promise<void> {
    await page.focus(selector);
    await page.fill(selector, "");
    for (const ch of text) {
      await page.type(selector, ch, { delay: 50 + Math.random() * 70 });
    }
  }

  private buildResult(
    status: ApplyResult["status"],
    jobId: string,
    durationMs: number,
    error?: string,
    fieldMappings?: Record<string, string>
  ): HarnessResult {
    return {
      userId: this.config.userId,
      jobId,
      mode: "unattended",
      status,
      error: error ?? null,
      durationMs,
      ...(fieldMappings && Object.keys(fieldMappings).length > 0 ? { fieldMappings } : {}),
    };
  }

  private buildReviewResult(jobId: string, durationMs: number): HarnessResult {
    return {
      ...this.buildResult("manual", jobId, durationMs, "Form filled and ready for user review.", this.collectFieldMappings()),
      reviewReady: true,
    };
  }

  private buildUncertainSubmissionResult(
    jobId: string,
    durationMs: number,
    fieldMappings: Record<string, string>,
  ): HarnessResult {
    return this.buildResult(
      "manual",
      jobId,
      durationMs,
      "The application may have been submitted, but authorization was revoked and the result could not be confirmed.",
      fieldMappings,
    );
  }

  private collectFieldMappings(): Record<string, string> {
    const fieldMappings: Record<string, string> = {};
    for (const turn of this.turns) {
      const action = turn.action;
      if (action.type === "fill" && action.selector && action.field) {
        fieldMappings[action.selector] = action.field;
      }
    }
    return fieldMappings;
  }

  private logTurn(log: TurnLog): void {
    // Worker logs are retained outside the task boundary. Keep selectors and
    // action types for debugging, but never persist candidate values, DOM
    // currentValue, free-form reasoning, or option text.
    console.log(JSON.stringify({
      turn: log.turn,
      durationMs: log.durationMs,
      perceived: log.perceived.map(field => ({
        selector: field.selector,
        type: field.type,
        label: field.label,
        required: field.required,
      })),
      action: { type: log.action.type, selector: log.action.selector, field: log.action.field },
    }));
  }
}

async function submissionAuthorized(task: ApplyTask): Promise<boolean> {
  try {
    return task.beforeSubmit ? await task.beforeSubmit() : true;
  } catch {
    return false;
  }
}

async function clickMaySubmit(page: Page, selector: string): Promise<boolean> {
  try {
    return await page.$eval(selector, (element) => {
      const tag = element.tagName.toLowerCase();
      const type = element.getAttribute("type")?.toLowerCase() ?? "";
      if (tag === "button" && (type === "submit" || (!type && element.closest("form")))) return true;
      if (tag === "input" && (type === "submit" || type === "image")) return true;
      const label = [
        element.textContent,
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("value"),
      ].filter(Boolean).join(" ");
      return /\b(submit|apply|send|complete|finish|confirm)\b/i.test(label);
    });
  } catch {
    // A selector that cannot be inspected is unsafe to execute after a revocation.
    return true;
  }
}

function isAllowedSensitiveAction(
  action: AgentAction,
  fields: PerceivedField[],
  confirmedAnswers: Record<string, string> | undefined,
): boolean {
  if (action.type !== "fill" && action.type !== "select") return true;
  const perceived = fields.find(field => field.selector === action.selector);
  const observedLabel = perceived?.label ?? action.field ?? "";
  if (!SENSITIVE_FIELD.test(observedLabel)) return true;
  return Object.entries(confirmedAnswers ?? {}).some(([label, value]) =>
    SENSITIVE_FIELD.test(label) && value === action.value && sameField(label, observedLabel),
  );
}

function sameField(left: string, right: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function uploadPathForField(action: AgentAction, fields: PerceivedField[], task: ApplyTask): string | undefined {
  const perceived = fields.find(field => field.selector === action.selector);
  const label = `${perceived?.label ?? ""} ${perceived?.type ?? ""}`.toLowerCase();
  if (/cover\s*letter|motivation|anschreiben/.test(label)) return task.coverLetterPath ?? task.resumePath;
  return task.resumePath;
}
