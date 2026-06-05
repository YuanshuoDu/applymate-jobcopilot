# Agent + Flow 合并页面设计文档

**日期**: 2026-05-19  
**状态**: 已确认，待实现

---

## 目标

将侧边栏的 `agent`（AgentPlaygroundPage）和 `animation`（AgentAnimationPage/Flow Demo）两个分栏合并为一个统一页面，实现：
1. **可视化监控各 Agent 执行过程**（每个 Agent 在做什么、当前处理哪个职位、结果如何）
2. **自然语言聊天窗口控制 Agent 自动化**（内嵌在页面中，常驻可见，替代原来的浮动按钮）
3. **增删自定义 Agent 节点**（自定义节点有完整真实业务逻辑）

---

## 页面布局

```
┌───────────────────────────────────────────────────────────────┐
│ TopBar: "AI Agent"  [status dot]  [▶ Run Now]  [⏸ Pause]    │
├───────────────────────────────────────────────────────────────┤
│ 流水线监控面板（sticky，顶部固定）                               │
│                                                               │
│ [🔍 Scout ✓]──▶[🤖 Analyst ●]──▶[✍️ Writer ○]──▶ ... [＋Add]│
│  42 jobs        Booking.com…      等待中                      │
│  1.2s           score: 84%                                    │
├──────────────────────────────┬────────────────────────────────┤
│  执行日志区（左，约 55% 宽）   │  协调官聊天（右，约 45% 宽）   │
│                              │                               │
│  按 Agent 分组的实时日志        │  内嵌聊天面板，常驻可见         │
│  每条显示：                   │  支持自然语言指令：             │
│  · Agent 名称 + 图标          │  · "把最低分阈值调到 80%"      │
│  · 当前处理的职位               │  · "帮我暂停 Writer Agent"    │
│  · 评分/结果                  │  · "现在有几个职位待审核？"     │
│  · 耗时                      │  · "开始跑一次流水线"           │
│  · 错误信息（红色）            │  · "禁用 Reviewer Agent"      │
│                              │                               │
├──────────────────────────────┴────────────────────────────────┤
│ 全局设置（可折叠，默认收起）                                     │
└───────────────────────────────────────────────────────────────┘
```

---

## 组件设计

### 1. PipelineMonitorBar（流水线监控条，sticky）

**职责**：可视化展示 6 个内置 Agent + 用户自定义 Agent 的实时状态。

**每个节点显示**：
- 图标 + 名称 + 中文名
- 状态指示灯（idle 灰 / running 蓝闪 / done 绿 / error 红）
- 当前处理的职位（公司 + 职位名，running 时显示）
- 完成后统计（处理数量、平均耗时、平均分）
- 右上角 `✕` 删除按钮（仅自定义节点可删）
- 左侧开关（启用/禁用，内置节点也可禁用）
- 末尾 `＋ Add Agent` 按钮

**状态数据来源**：SSE 事件 `role_start`、`role_done`、`job_done` 等。

### 2. ExecutionLogPanel（执行日志，左侧）

**职责**：按 Agent 分组的实时执行日志。

**展示方式**：
- 每个 Agent 一个折叠 section，运行时自动展开
- 日志条目：时间 + 图标 + 职位信息 + 评分/结果
- 颜色编码：高分绿 / 中分黄 / 低分灰 / 错误红
- 自动滚动到最新条目

**数据来源**：与 PipelineMonitorBar 共享同一 SSE 连接。

### 3. OrchestratorChatPanel（聊天面板，右侧，内嵌）

**职责**：自然语言控制 Agent 自动化，替代原浮动聊天按钮。

**支持的自然语言指令（通过 `/api/agent/chat` + action 事件）**：

| 指令示例 | 触发 action |
|---|---|
| "开始跑流水线" | `start_run` |
| "停止" | `stop_run` |
| "把最低分改成 80%" | `update_config { field: minMatchScore, value: 80 }` |
| "禁用 Writer" | `toggle_agent { role: writer, enabled: false }` |
| "现在处理了多少职位？" | 纯文字回复 |
| "添加一个过滤 remote 职位的 agent" | `add_custom_agent { ... }` |

**UI**：
- 右侧面板，固定高度，内部滚动
- 顶部 header 显示"Orchestrator"+ 状态
- 建议 chips（基于当前 pipeline 状态）
- 消息气泡（用户右对齐，助手左对齐）
- 底部输入框 + 发送按钮

### 4. AddAgentModal（添加 Agent 弹窗）

**字段**：
- 名称（text）
- 图标 emoji（picker）
- 描述
- System Prompt（textarea）
- 模型选择（ModelSelector）
- 插入位置（after: scout/analyst/writer/reviewer/executor/auditor）

**提交**：`POST /api/agent/roles`，body `{ role: uuid, type: 'custom', ... }`

### 5. GlobalSettingsPanel（全局设置，可折叠）

保持现有 `GlobalSettingsPanel` 实现，默认收起，点击展开。

---

## API 变更

### 新增接口

**`POST /api/agent/roles`** — 创建自定义 Agent
```ts
body: { name: string; icon: string; description: string; systemPrompt: string; provider: string; model: string; insertAfter: string }
response: AgentRole
```

**`DELETE /api/agent/roles/[role]`** — 删除自定义 Agent（仅 type=custom）
```ts
response: { success: true }
```

### 现有接口扩展

**`PATCH /api/agent/roles/[role]`** — 已存在，无需改动

**`/api/agent/chat`** — 新增 action 类型：
- `stop_run`：关闭 SSE 连接
- `toggle_agent`：启用/禁用某个 Agent
- `add_custom_agent`：触发创建自定义 Agent

**`/api/agent/run` SSE** — 扩展支持 custom role 事件（role_start/role_done 的 role 字段可以是自定义 key）

---

## 数据库变更

`AgentRole` 表新增字段（或已有）：
- `type`: `'builtin' | 'custom'`（默认 builtin）
- `insertAfter`: string（custom agent 的插入位置）
- `icon`: string（emoji，custom agent 用）
- `name`: string（显示名称，custom agent 用）

---

## Pipeline 执行逻辑变更（`pipeline.ts`）

1. 运行前从 DB 读取所有已启用的 custom AgentRoles
2. 按 `insertAfter` 插入到对应阶段后
3. Custom agent 执行逻辑：拿当前 job 数据 + system prompt → 调用 AI 模型 → 返回 `{ pass: boolean; reason?: string; metadata?: object }`
4. 若 `pass: false`，job 标记为 skipped，附上 reason

---

## 导航变更

- `Sidebar.tsx`：删除 `{ id: 'animation', label: 'Flow Demo' }` 导航项
- `AppShell.tsx`：PAGES 映射中 `animation` 入口删除，`AgentAnimationPage` import 删除
- `AgentAnimationPage.tsx`：整个文件删除
- `AgentPage.tsx`：整个文件删除（已废弃，未被使用）

---

## 改动文件清单

| 文件 | 操作 |
|---|---|
| `components/pages/AgentPlaygroundPage.tsx` | 重写（合并新布局） |
| `components/layout/Sidebar.tsx` | 删除 animation 导航项 |
| `components/layout/AppShell.tsx` | 删除 animation 路由 |
| `components/pages/AgentAnimationPage.tsx` | 删除 |
| `components/pages/AgentPage.tsx` | 删除（未使用） |
| `app/api/agent/roles/route.ts` | 新增 POST handler |
| `app/api/agent/roles/[role]/route.ts` | 新增 DELETE handler |
| `app/api/agent/chat/route.ts` | 扩展 action 类型 |
| `lib/agent/pipeline.ts` | 支持 custom agent 注入 |
| `lib/types.ts` | AgentRole 类型更新 |

---

## 成功标准

1. 侧边栏只剩一个 "Agent" 入口
2. 流水线运行时，每个 Agent 节点实时显示正在处理的职位和状态
3. 聊天窗口内嵌在页面右侧，可通过自然语言控制 pipeline
4. 用户可以添加自定义 Agent，提交后立即出现在流水线中
5. 自定义 Agent 在真实 pipeline 运行中被执行，结果体现在日志里
6. 删除自定义 Agent 后不影响内置 Agent 运行
