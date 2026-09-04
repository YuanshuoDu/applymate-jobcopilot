import { expect, type Page } from "@playwright/test";

export type HarnessLocale = "en" | "zh";
export type HarnessSnapshot = {
  status: string;
  events: Array<{ type: string; payload: unknown }>;
  messages: Array<{ speaker: string; text: string }>;
  lastEventId: string | null;
  turnCount: number;
  unknownEvents: number;
  unknownTypes: number;
};

export const copy: Record<HarnessLocale, Record<string, string>> = {
  en: {
    workspace: "Agent workspace",
    ready: "Ready",
    working: "Working",
    stopped: "Stopped",
    waitingApproval: "Awaiting approval",
    completed: "Completed",
    reconnected: "Reconnected",
    timedOut: "Approval timed out",
    composer: "Message the Orchestrator",
    send: "Send message",
    stop: "Stop run",
    approve: "Approve",
    reject: "Reject",
    requestApproval: "Request approval",
    reconnect: "Reconnect",
    complete: "Complete turn",
    unknownEvent: "Emit unknown event",
    unknownTypes: "Emit unknown types",
    timeout: "Simulate approval timeout",
    replayed: "Replayed timeline",
    unknownEventIgnored: "Unknown event ignored",
    unknownTypesIgnored: "Unknown item type ignored",
    final: "Final answer: your job-search plan is ready.",
    assistant: "I am checking your saved roles and approval policy.",
    approved: "Approval recorded; the safe action can continue.",
    stopMessage: "The run stopped without an external submission.",
    timeoutMessage: "Approval expired; nothing was submitted.",
    noExternalWrites: "External writes: 0",
  },
  zh: {
    workspace: "智能体工作区",
    ready: "就绪",
    working: "运行中",
    stopped: "已停止",
    waitingApproval: "等待审批",
    completed: "已完成",
    reconnected: "已重连",
    timedOut: "审批已超时",
    composer: "向编排器发送消息",
    send: "发送消息",
    stop: "停止运行",
    approve: "批准",
    reject: "拒绝",
    requestApproval: "请求审批",
    reconnect: "重新连接",
    complete: "完成本轮",
    unknownEvent: "发送未知事件",
    unknownTypes: "发送未知类型",
    timeout: "模拟审批超时",
    replayed: "已重放时间线",
    unknownEventIgnored: "已忽略未知事件",
    unknownTypesIgnored: "已忽略未知条目类型",
    final: "最终答复：你的求职计划已经准备好。",
    assistant: "我正在检查你保存的职位和审批策略。",
    approved: "审批已记录；安全操作可以继续。",
    stopMessage: "运行已停止，未执行外部提交。",
    timeoutMessage: "审批已过期；未提交任何内容。",
    noExternalWrites: "外部写入：0",
  },
};

export function documentFor(locale: HarnessLocale, restoredState?: HarnessSnapshot) {
  const t = copy[locale];
  const restore = restoredState ? JSON.stringify(restoredState) : "null";
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><title>${t.workspace}</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f8fafc;color:#172033;font:14px system-ui,sans-serif}
main{display:flex;flex-direction:column;min-height:100vh;max-width:980px;margin:auto;background:#fff}
header{padding:20px;border-bottom:1px solid #e2e8f0}h1{margin:0;font-size:20px}header p{margin:6px 0 0;color:#64748b}
[data-testid=timeline]{display:flex;flex:1;flex-direction:column;gap:10px;padding:20px;min-height:300px}
article{padding:12px;border:1px solid #dbe3ef;border-left:3px solid #4f46e5;border-radius:8px;line-height:1.5}
article[data-speaker=user]{border-left-color:#64748b}article[data-speaker=system]{border-left-color:#d97706}
form{display:flex;gap:8px;padding:16px;border-top:1px solid #e2e8f0;align-items:flex-end;flex-wrap:wrap}
label{width:100%;font-weight:650}textarea{flex:1;min-width:220px;min-height:70px;padding:10px;border:1px solid #cbd5e1;border-radius:8px;resize:vertical;font:inherit}
button{min-height:40px;padding:0 12px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;color:#172033;font:inherit;cursor:pointer}
button[data-primary=true]{border-color:#4f46e5;background:#4f46e5;color:#fff}button:disabled{opacity:.5;cursor:not-allowed}
button:focus-visible,textarea:focus-visible{outline:3px solid #a5b4fc;outline-offset:2px}
[data-testid=controls]{display:flex;gap:8px;flex-wrap:wrap;padding:0 16px 16px}
[data-testid=diagnostics]{display:flex;gap:12px;padding:12px 16px;background:#f8fafc;color:#64748b;font-size:12px;flex-wrap:wrap}
</style></head><body><main data-testid="agent-workspace">
<header><h1>${t.workspace}</h1><p data-testid="stream-status" aria-live="polite">${t.ready}</p></header>
<section data-testid="timeline" aria-live="polite" aria-label="${t.workspace}"></section>
<form data-testid="composer"><label for="message">${t.composer}</label><textarea id="message" placeholder="${t.composer}"></textarea>
<button data-action="send" data-primary="true" type="submit">${t.send}</button>
<button data-action="stop" type="button" hidden>${t.stop}</button>
<button data-action="approve" type="button" hidden>${t.approve}</button>
<button data-action="reject" type="button" hidden>${t.reject}</button></form>
<div data-testid="controls">
<button data-action="request-approval" type="button">${t.requestApproval}</button><button data-action="reconnect" type="button">${t.reconnect}</button>
<button data-action="complete" type="button">${t.complete}</button><button data-action="unknown-event" type="button">${t.unknownEvent}</button>
<button data-action="unknown-types" type="button">${t.unknownTypes}</button><button data-action="timeout" type="button">${t.timeout}</button>
</div><div data-testid="diagnostics"><span data-testid="last-event-id">last-event-id: none</span><span data-testid="turn-count">turns: 0</span><span data-testid="external-write-count">${t.noExternalWrites}</span></div>
<script>
(() => {
  const t = ${JSON.stringify(t)};
  const key = "applymate:e2e:scripted-harness:v1";
  const initial = { status: "ready", events: [], messages: [], lastEventId: null, turnCount: 0, unknownEvents: 0, unknownTypes: 0 };
  let state = ${restore} || initial;
  try {
    const saved = sessionStorage.getItem(key) || (window.name.startsWith(key + "|") ? window.name.slice(key.length + 1) : "");
    if (saved) state = { ...initial, ...JSON.parse(saved) };
  } catch {}
  const node = (selector) => document.querySelector(selector);
  const action = (name) => node('[data-action="' + name + '"]');
  function save() {
    const serialized = JSON.stringify(state);
    try { sessionStorage.setItem(key, serialized); } catch {}
    window.name = key + "|" + serialized;
  }
  function emit(type, payload) {
    state = { ...state, lastEventId: "event-" + (state.events.length + 1), events: [...state.events, { type, payload }] };
  }
  function message(speaker, text) { state = { ...state, messages: [...state.messages, { speaker, text }] }; }
  function render() {
    const status = node('[data-testid="stream-status"]');
    const timeline = node('[data-testid="timeline"]');
    const lastId = node('[data-testid="last-event-id"]');
    const turns = node('[data-testid="turn-count"]');
    if (status) status.textContent = t[state.status] || state.status;
    if (lastId) lastId.textContent = "last-event-id: " + (state.lastEventId || "none");
    if (turns) turns.textContent = "turns: " + state.turnCount;
    if (timeline) timeline.innerHTML = state.messages.map(item => '<article data-speaker="' + item.speaker + '">' + item.text + '</article>').join("");
    action("stop").hidden = state.status !== "working";
    action("approve").hidden = state.status !== "waitingApproval";
    action("reject").hidden = state.status !== "waitingApproval";
    action("send").disabled = !node("#message").value.trim();
    save();
  }
  window.__applyMateHarnessState = () => state;
  function startTurn() {
    const input = node("#message");
    const text = input.value.trim();
    if (!text) return;
    state = { ...state, status: "working", turnCount: state.turnCount + 1 };
    emit("turn_started", { turn: state.turnCount }); message("user", text); message("assistant", t.assistant); input.value = ""; render();
  }
  node('[data-testid="composer"]').addEventListener("submit", event => { event.preventDefault(); startTurn(); });
  node("#message").addEventListener("input", render);
  node("#message").addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); startTurn(); } });
  action("stop").addEventListener("click", () => { emit("turn_interrupted", {}); state = { ...state, status: "stopped" }; message("system", t.stopMessage); render(); });
  action("request-approval").addEventListener("click", () => { emit("approval_requested", {}); state = { ...state, status: "waitingApproval" }; render(); });
  action("approve").addEventListener("click", () => { emit("approval_resolved", { decision: "approved" }); state = { ...state, status: "completed" }; message("system", t.approved); render(); });
  action("reject").addEventListener("click", () => { emit("approval_resolved", { decision: "rejected" }); state = { ...state, status: "stopped" }; message("system", t.stopMessage); render(); });
  action("complete").addEventListener("click", () => { emit("final", {}); state = { ...state, status: "completed" }; message("assistant", t.final); render(); });
  action("reconnect").addEventListener("click", () => { const id = state.lastEventId; state = { ...state, status: "reconnected" }; message("system", t.replayed + " · " + (id || "none")); render(); });
  action("timeout").addEventListener("click", () => { emit("approval_expired", {}); state = { ...state, status: "timedOut" }; message("system", t.timeoutMessage); render(); });
  action("unknown-event").addEventListener("click", () => { emit("future_event", {}); state = { ...state, unknownEvents: state.unknownEvents + 1, status: "unknownEventIgnored" }; render(); });
  action("unknown-types").addEventListener("click", () => { emit("item", { type: "future_item" }); state = { ...state, unknownTypes: state.unknownTypes + 1, status: "unknownTypesIgnored" }; render(); });
  render();
})();
</script></main></body></html>`;
}

export async function openScriptedHarness(page: Page, locale: HarnessLocale, restoredState?: HarnessSnapshot) {
  await page.setContent(documentFor(locale, restoredState), { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: copy[locale].workspace })).toBeVisible();
}

export async function readHarnessDiagnostics(page: Page) {
  try {
    return await page.locator("[data-testid=diagnostics]").innerText({ timeout: 1000 });
  } catch {
    const lastEventId = await page.evaluate(() => {
      const prefix = "applymate:e2e:scripted-harness:v1|";
      if (!window.name.startsWith(prefix)) return "none";
      try { return (JSON.parse(window.name.slice(prefix.length)) as { lastEventId?: string | null }).lastEventId || "none"; } catch { return "none"; }
    }).catch(() => "none");
    return `last-event-id: ${lastEventId}`;
  }
}

export async function readHarnessState(page: Page): Promise<HarnessSnapshot> {
  return page.evaluate(() => {
    const value = (window as Window & { __applyMateHarnessState?: () => HarnessSnapshot }).__applyMateHarnessState?.();
    if (!value) throw new Error("scripted harness state is unavailable");
    return value;
  });
}
