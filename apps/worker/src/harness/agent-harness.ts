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

/** Config passed to AgentHarness constructor */
export interface HarnessConfig {
  userId: string;
  maxTurns: number;
  dryRun: boolean;
  mode: "dom" | "vision" | "hybrid";
}

/** Task data passed to harness.run() */
export type HarnessResult = Pick<import("@jobcopilot/shared").ApplyResult, "status" | "error" | "durationMs"> & { turns?: number; log?: unknown[] };

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
  async run(page: Page, task: ApplyTask): Promise<ApplyResult> {
    this.turns = [];
    const startedAt = Date.now();

    try {
      const systemPrompt = buildSystemPrompt(task.persona,
        {
          title: task.jobTitle,
          company: task.jobCompany,
          keywords: task.jobKeywords,
        }
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
          const logEntry: TurnLog = {
            turn,
            perceived: fields,
            action: { type: "done", reasoning: `URL pattern match: ${url}` },
            durationMs: Date.now() - turnStart,
          };
          this.turns.push(logEntry);
          this.logTurn(logEntry);
          return this.buildResult("submitted", task.jobId, Date.now() - startedAt);
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
          return this.buildResult("submitted", task.jobId, Date.now() - startedAt);
        }
        if (action.type === "manual") {
          return this.buildResult("manual", task.jobId, Date.now() - startedAt, action.reasoning);
        }

        // ── Execute ──
        if (this.config.dryRun) {
          if (["fill", "click", "select", "upload", "submit"].includes(action.type)) {
            continue;
          }
        }

        try {
          await this.executeAction(page, action, task);
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

  private async executeAction(page: Page, action: AgentAction, task: ApplyTask): Promise<void> {
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
        const filePath = action.filePath ?? task.resumePath;
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
    error?: string
  ): ApplyResult {
    return {
      userId: this.config.userId,
      jobId,
      mode: "unattended",
      status,
      error: error ?? null,
      durationMs,
    };
  }

  private logTurn(log: TurnLog): void {
    console.log(JSON.stringify(log));
  }
}