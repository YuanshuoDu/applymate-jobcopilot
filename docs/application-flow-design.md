# Application flow and interaction guide

Issue: [#1052](https://github.com/YuanshuoDu/applymate-jobcopilot/issues/1052)

This guide defines the application experience implemented on the existing Web
surfaces. It follows the [application architecture](scraping-autoapply-design.md#6-auto-apply-flow-architecture)
and the [Agent Harness roadmap](agent-harness-v2-development-roadmap.md).
UI changes do not establish production rollout or actual employer submission.

## 使用说明（中文）

以“申请管理”为每个职位的中心。发现职位负责找工作，简历页负责编辑材料，
Agent 负责原任务的执行和审批，招聘消息负责查看回复。

### 手动申请

1. 在“发现职位”搜索，保存后点击“查看此申请”。保存不会提交申请。
2. 在申请详情选择基础简历并“准备申请材料”。已有材料继续复用。准备过程中，
   如果审核指出缺少事实依据，先查看具体问题：可进入本职位材料编辑器，
   移除或弱化无法支持的表述；希望跨职位复用的真实事实，可自行添加到个人资料。
   本职位专属的新依据目前不能单独保存，编辑后仍需重新检查，不能保证审核通过。
3. 需要手动修改时，展开简历卡并“编辑此简历”。完成保存后“返回此申请”，
   系统恢复原职位和列表条件。查看、返回或刷新不会启动 AI 匹配分析；需要时在
   简历页主动点击“分析匹配度”，简历加载或刷新时请等待完成后再操作。
4. 求职信可选。没有选择时不会自动生成或绑定其他草稿；如需使用，展开求职信
   卡，选择“选择或创建求职信（可选）”，在简历页创建或选择，再返回申请确认。
   已选求职信尚未加载时，刷新并保留原选择。需要修正求职信但尚未选择时，先选择。
5. “确认申请材料”表示选择此职位使用的版本，不会授权向雇主提交。材料内容或
   选择变化后，检查当前版本；旧检查结果不代表新版本已通过。
6. 材料检查通过且仍适用于当前版本后，点击下载申请材料 ZIP。浏览器在生成前读取
   并核对所选材料和已通过的检查，生成后再次读取并比较；变化或读取失败时不会保存
   ZIP，请刷新、核对并重新检查。此复核不是原子操作，下载后仍需自行检查文件。
7. 打开 ZIP，逐页核对简历和所选求职信的文字、分页、字体和排版，再“前往雇主网站”
   完成申请。PDF 排版可能与网页预览不同，字体覆盖有限，遇到不支持的字符时会阻止导出并提示；常见换行、制表符、
   不间断空格和可组合音标会在 PDF 中规范化，原材料不变。
8. 只有实际提交完成后，点击“记录我已在雇主网站提交”。这是用户报告的手动记录，
   不能替代雇主回执。若显示记录已接收但状态待刷新，或结果未知，点击“刷新记录状态”
   只读取状态；若仍未确认，先核对申请历史及雇主回执，不重复记录。
9. 在申请历史与招聘消息查看后续。材料编辑、下载和打开网站都不会记作已提交。

### Agent 协助申请

1. 申请详情已有任务时，点击原任务的进度、问题或审核入口。
2. 在同一个 Agent 会话中补充信息和授权，避免另开任务重复处理。
3. 等待授权、正在填写、正在提交和提交结果待核实分别显示，不合并成“已完成”。
4. 登录、验证码或 MFA 按原会话的交接说明处理；仅在现有系统允许时恢复。
5. 结果待核实时先查看原会话和回执，不再次提交。

### 常见提示

| 提示 | 应如何处理 |
| --- | --- |
| 检查当前材料 | 材料版本变化或旧检查不适用，请检查当前版本 |
| 所选求职信尚未加载 | 先刷新，保留原选择，不用空值覆盖 |
| 状态待刷新 | 当前任务信息不足，刷新或打开原 Agent 查看 |
| 等待审核 | 在原任务查看本次内容；页面跳转不会代替授权 |
| 提交结果待核实 | 查看记录和回执，保持结果未知，不自动重试 |
| 手动记录状态待刷新 | 点击“刷新记录状态”；若仍未确认，先核对记录和雇主回执 |

如果登录状态变化时简历还有未保存的编辑，请保留当前标签页，按提示在新标签页
登录原账号并刷新登录状态。恢复界面提供可复制的内存草稿；请先复制，再打开最新
简历逐项核对，系统不会自动覆盖已保存版本。确认关闭或刷新当前页后草稿会消失。
恢复历史版本会立即修改已保存的简历；若结果无法确认，先重新加载核对，不要重复恢复。
草稿恢复到最新简历后，只有原来进入编辑器时存在可信的职位与返回列表上下文，才会
恢复该职位和筛选条件；否则不会从当前其他账号的地址猜测关联。
查看、返回或刷新简历不会自动启动 AI 分析；需要时请点击“分析匹配度”。

首页和“申请管理 → 需要我处理”展示最近最多 100 个申请任务中的待处理事项，
不能当作全部申请总数。每条可进入原申请或原任务；处理后刷新状态。
招聘邮件没有可靠职位关联时，保留邮件本身，不猜测它属于哪个申请。

## 1. Product responsibilities

| Surface | User question | Primary responsibility |
| --- | --- | --- |
| Dashboard | What should I do next? | Show recent task attention, a saved application to continue, and follow-ups |
| Discover | Which jobs interest me? | Search, inspect, save, and open the saved application |
| Applications | How is this application progressing? | Keep the job, selected materials, current check and existing execution together |
| Resume | What materials should I use? | Edit documents and career information, then return to the exact application |
| Inbox | What did the employer say? | Read existing classified messages |
| Agent | Can ApplyMate help carry out this task? | Own existing conversations, questions, approvals, execution and recovery |
| Settings | What preferences should ApplyMate use? | Keep existing settings and permissions |

Page IDs remain `search`, `jobs`, `resume`, `gmail`, and `agent`. Renaming labels
does not invalidate existing links. Saving a job never counts as applying.

## 2. Shared interaction rules

1. Keep company and role visible at every handoff.
2. Each current step has one prominent next action. Editors and details are secondary.
3. Reopening a page does not generate materials, run an audit or create a task.
4. Keep existing material versions and valid checks; show missing or stale evidence explicitly.
5. Questions and approvals remain attached to their original task/session and scope.
6. Opening a website, downloading a document, confirming materials and authorizing submission have distinct labels and effects.
7. Keep uncertain submission outcomes visible. They never expose a generic resubmit button.

## 3. Consolidated entry points

| Previous interaction | Current guidance |
| --- | --- |
| Tailor resume OR prepare everything | One preparation action; edit the selected resume in the material section |
| Two review-audit buttons in material confirmation | One actionable audit row |
| Artificial sequential checking animation | Immediately show the actual existing checks |
| Final confirm | Confirm application materials, with the job and an explicit no-submission notice |
| View job shows only a toast | Open the linked application by its real ID |
| Return to a generic list | Restore the selected job, list filters, page, view and sort |
| Repeated save after returning to search | Open the saved application's real ID; clear that mapping after confirmed deletion |
| Dashboard and task page have separate controls | Dashboard links the original session; that session owns the action |
| More button with no distinct purpose | Explicitly view this application, or remove the inactive control |
| Opening the employer site requires automation support | A normal employer link remains available independently |

Useful shortcuts can appear on several pages. They must share navigation and
action logic. Similar question wording does not authorize sharing answers
between jobs. Application-specific answers are not automatically permanent
career facts.

## 4. Applications list and detail

The list keeps the user's existing lifecycle status. When a related recent Agent
task is known, its execution label, explanation and original-session action appear
alongside that status. The “Needs your attention” view reads the bounded recent
task projection independently of the current list page. Opening a result shows
its exact application; details outside the current page/filter load by ID.

The detail drawer follows this order:

1. Company, role and source.
2. Material, check and submission evidence, each shown separately.
3. Current next action or the original task's status and session link.
4. Resume, optional cover letter and check details, with editors as secondary actions.
5. Application method, manual record action, job information and activity history.

The audit evidence card does not store its answer in the shared Persona or submit
a job-specific answer. The existing audit accepts only a source resume and shared
profile facts, not per-job evidence. Users can edit the application materials or
remove/soften unsupported claims; only facts intended for reuse belong in the
profile. Job-scoped evidence storage and audit support remain a separate follow-up.

Preparation actions use the existing endpoints. They reuse selected documents
and target only existing flagged corrections. A confirmed resume-only package
does not silently acquire a draft cover letter. First preparation does not create
or bind an unselected optional letter. A user who wants one can open the cover
letter section, choose or create it in Resume, and confirm that selection for the
application. An already selected letter remains selected; a selected letter that
has not loaded is not treated as absent.

## 5. Material checks and selection

| Condition | User guidance | Effect |
| --- | --- | --- |
| No materials yet | Prepare application materials | Use the selected base resume and existing preparation flow |
| Facts need confirmation | Provide missing information | Open the existing issue details and input |
| Content needs correction | Review material issues | Open the one repair/check interface |
| Selected material is not loaded | Refresh before checking | Preserve its ID; never clear or replace it |
| Audit belongs to another document/version | Check current materials | Do not present the previous result as valid |
| Current material check passed | Use the selected materials | Keep selection distinct from submit permission |
| Employer requires manual submission | Open employer website | Open a link only |

Jobs and Resume share the same current-material predicate: document IDs, saved
revisions or conservative legacy audit times, and unsaved edits are checked.
Missing or malformed revision information does not establish readiness.

An absent optional letter is distinct from a selected letter still loading.
Confirming the same selected letter omits a redundant assignment, because that
write would otherwise advance its saved revision. Selecting a different letter
invalidates its old check and requires checking the newly saved selection.

Pending AI suggestions retain their existing blocking rules. Dividing them into
required factual repairs and optional style improvements needs a separate
reviewed rule change; this UI change does not quietly waive them.

## 6. Manual application journey

| Step | Surface and action | Completion condition |
| --- | --- | --- |
| Discover | Search and inspect the employer role | User chooses a job |
| Save | Save to Applications | A real saved Job ID exists; search results remain available |
| Prepare | Prepare application materials | Existing preparation produces/reuses material drafts |
| Resolve | Review concrete missing facts or corrections | Relevant content is corrected and checked |
| Edit | Edit this resume | Current company/role remain visible; saving finishes before returning |
| Select | Confirm application materials | Selected IDs are associated with this job; no external submission |
| Apply | Download materials and open employer website | User completes the application at the employer |
| Record | Record that I submitted on the employer website | Existing manual-record endpoint accepts the user's explicit report |
| Track | Read application history and recruitment messages | Follow-up is based on existing records |

Opening links and downloading files never call the manual-record endpoint. The
manual action records the candidate's report; it is not independent employer
receipt verification. The existing activity entry preserves that distinction.

The browser ZIP download reads the account-owned job, selected saved documents
and existing passing audit before rendering. It then reads them again and compares
the snapshot before saving; missing, changed or unreadable material prevents that
download. These are read-only checks of an existing audit, not a new AI audit.
The client-side checks and file save are not atomic with concurrent server changes;
review each downloaded PDF before use. A ZIP contains the selected resume PDF,
the selected cover letter PDF if present, and metadata. PDF pagination, layout
and font rendering can differ from the web preview. Character and font coverage
is limited to what is verified in the actual downloaded files. Unsupported glyphs,
format controls and uncomposable combining marks block export. PDF rendering
normalizes line endings, tabs, non-breaking spaces and NFC without changing the
saved source; a non-breaking space becomes an ordinary breakable space.

For manual recording, the current tab stores a minimal account/job status marker
before sending the request. An accepted request with a failed read, or an unknown
request outcome, keeps the record action unavailable. The user can refresh the
record status using a read-only request; a saved status or failed read does not
prove the recording failed and does not trigger another request. If tab storage is
unavailable, the action is withheld. This marker is scoped to the browser tab: it
does not provide cross-tab, cross-device or server-side idempotency, and clearing
or losing tab storage removes that protection. Check application history and the
employer receipt before deciding what to do next.

Resume waits for its current save chain before application-return and shell
navigation, and keeps the editor open when saving fails. Switching resumes also
waits for that chain. A browser refresh or close uses the browser’s unsaved-change
prompt. Same-document history navigation is guarded where supported; the fallback
can retain the editor without preserving forward history. If authentication changes
while editing, an account-bound draft remains in this page's memory. After the
original account signs in again, the user can copy and compare it with the latest
saved resume; it is never automatically written into an account. When the initial
editor entry had a reliable application return context for that resume, the draft
also retains that original job and sanitized list filters, page, view, sort and
attention state. Recovery does not use another account's current URL or invent a
job link when that context is absent. The browser asks before closing or refreshing
a page holding a draft, but a confirmed close or reload
removes that in-memory copy. Real authentication and cross-device recovery have not
been verified by the mocked browser tests.

If an audit correction and a new local edit overlap, automatic saving is paused.
The user is asked to copy the local edits, reload and compare the latest saved
content. There is no automatic merge or complete draft recovery for this conflict.
Resume analysis starts only when the user selects Analyze match or re-analyze.
Viewing, returning or refreshing never starts analysis or an audit. Analysis waits
for the resume refresh and binds cached results to the actual resume version;
on refresh failure it identifies the cached version instead. An unchanged version
may reuse its existing result; opening the page does not request a new analysis.
Restoring a historical version is a server-side change: existing edits are saved
first, and an uncertain result requires checking the latest saved resume before
trying again. New edits made during restoration are retained for manual comparison.

## 7. Agent-assisted journey

1. Open the task related to the selected job. Use its actual `sessionId`.
2. Inspect the original task's plan and progress.
3. Answer current questions and handle approvals in the existing Agent interface.
4. Let existing fill, submission authorization and recovery contracts control execution.
5. Read the recorded outcome and its available evidence.

The Applications card is a read-only task projection. It never creates a task,
answers a question, issues an approval nonce, grants consent, or retries execution.
Without an associated task, Open Agent navigates to the existing Agent entry.
It does not infer a session from job ID or send a task prompt.

The task query returns at most 100 recent records. Dashboard labels this scope.
Missing records at that boundary do not prove a task is absent. Loading, failures
and partial coverage show refresh guidance instead of a new preparation action.
Refocusing Applications or Dashboard refreshes the task projection so resolved
questions do not remain indefinitely visible. Manual work is available after a
failed or cancelled task only when its checkpoint explicitly says it stopped
before submission; uncertain and active execution remain guarded. The projection
is a snapshot and does not by itself prevent concurrent changes in another tab.

## 8. Exceptions and outcomes

| Situation | Next action | Boundary |
| --- | --- | --- |
| Unknown experience | Open the existing fact/question interface | Do not invent a claim or reinterpret unknown as no |
| Login, MFA or CAPTCHA | Follow the original session's handoff instructions | No bypass or automatic retry; no promise of unsupported takeover UI |
| Materials changed | Check the current versions | Old checks and approvals are not authority for new content |
| Task query fails | Refresh status | Do not interpret failure as no task |
| Preparation fails | Inspect/retry the existing specific step | No generic submission retry |
| Approval expires | Review in the original session | Existing receipt/version/expiry checks remain authoritative |
| Submission started | View original progress | Do not enqueue another application |
| Submission uncertain | Check original records and receipt | Keep unknown distinct from failed or submitted |
| Task cancelled | Read the last recorded state | Navigation does not resume it |
| Historical application has a result | Read history and follow up | Editing a resume does not erase the historical result |

## 9. Dashboard and Inbox

Dashboard puts recent task attention before Momentum. It shows at most three
recent attention cards and existing saved/follow-up continuations, excluding a
second card for a job already shown as requiring attention and without claiming
a full global pending count. Job cards and timeline entries navigate to
their real job when one is present; entries without job identity do not guess.

Inbox retains existing classifications and behavior. Its current email DTO does
not carry a reliable job relation, so this change does not manufacture a
View application link or update lifecycle status by company-name matching.
Adding that association remains a separately scoped data requirement.

## 10. Implementation and verification map

| Area | Modules |
| --- | --- |
| Navigation and list restoration | `application-navigation`, `application-list-state` |
| Material identity and freshness | `application-material-selection`, `application-materials`, `application-analysis-cache` |
| Browser ZIP verification and rendering | `application-export-snapshot`, `bundle`, `resume-pdf`, `cover-letter-pdf` |
| Manual record status | `application-manual-record` |
| Account-bound in-memory recovery | `application-recovery-draft`, `application-recovery-navigation` |
| Saved-search identity and cancellation | `application-search-state`, `application-search-save` |
| Existing task projection | `application-task-model`, `useApplicationTasks`, `application-task-card` |
| Progress and Dashboard guidance | `application-progress`, `application-dashboard-guidance` |

Focused tests cover saved identities, cancellation after unmount/account change,
history navigation, save-before-return, optional letters, stale versions, bounded
task coverage, uncertain outcomes and read-only task links. Mounted browser
fixtures exercise real components with synthetic sessions and mocked requests.
One fixture opens the original Agent session from an application, answers a mock
question, reviews a mock approval and displays a simulated unverified outcome;
its state changes are injected by the fixture and page reloads. These checks prove
UI wiring, not Worker execution, authenticated database, live ATS or production behavior.

Worker runtime, Agent-owned layout, protocol, policies, mutation APIs, schema and
roadmap remain under their existing owners. No new state machine, persistent
application-pack model, batch approval or autopilot policy is introduced.
