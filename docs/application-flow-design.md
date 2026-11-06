# Application flow and interaction guide

Issue: [#1052](https://github.com/YuanshuoDu/applymate-jobcopilot/issues/1052)

This guide defines the application experience implemented on the existing Web
surfaces. It follows the [application architecture](scraping-autoapply-design.md#6-auto-apply-flow-architecture)
and the [Agent Harness roadmap](agent-harness-v2-development-roadmap.md).
UI changes do not establish production rollout or actual employer submission.

## 使用说明（中文）

以“申请管理”为每个职位的中心。发现职位负责找工作，简历页负责编辑材料，
Agent 负责原任务的执行和审批，招聘消息负责查看回复。
申请列表的排序只作用于当前页；桌面表头和分页栏使用同一排序设置，返回后仍保留。

### 手动申请

1. 在“发现职位”搜索，保存后点击“查看此申请”。保存不会提交申请。若职位缺少描述，可在申请详情粘贴并明确保存。保存前会检查已有审核，并仅在原描述仍为空时保存；已有审核、无法确认或描述已变化时不会在此覆盖。审核检查与保存并非原子操作，其他标签页同时修改时仍需重新核对。保存不会启动 AI。未保存草稿只保留在当前标签页，并按账号和职位隔离；刷新或关闭标签页后无法恢复。保存结果未确认时先刷新状态，不会自动重发。
2. 在申请详情选择基础简历并“准备申请材料”。还没有基础简历时，先进入简历页创建
   或导入；读取失败时先刷新。多个基础版本且没有默认选择时，先选择要使用的版本。
   已有材料继续复用。准备过程中，
   如果审核指出缺少事实依据，先查看具体问题：可进入本职位材料编辑器，
   移除或弱化无法支持的表述；希望跨职位复用的真实事实，可自行添加到个人资料。
   本职位专属的新依据目前不能单独保存，编辑后仍需重新检查，不能保证审核通过。
3. 需要手动修改时，展开简历卡并“编辑此简历”。完成保存后“返回此申请”，
   系统恢复原职位和列表条件。查看、返回或刷新不会启动 AI 匹配分析；需要时在
   简历页主动点击“分析匹配度”，简历加载或刷新时请等待完成后再操作。
4. 求职信可选。没有选择时不会自动生成或绑定其他草稿；如需使用，展开求职信
   卡，选择“选择或创建求职信（可选）”，在简历页创建或选择，再返回申请确认。
   已选求职信尚未加载时，刷新并保留原选择；刷新只读取材料。准备期间若选材发生
   变化，按提示重新核对。已发出的材料绑定请求无法由页面撤销，请刷新申请确认结果。
   求职信有事实问题时，进入本职位简历页，核对已选求职信并手动修改，等待保存后
   返回此申请重新检查；申请详情不会自动覆盖整封信。未选择或无法读取时先检查选择。
   编辑器读不到已选版本时会提示重新读取，不会自动打开另一份草稿。保存结果未知时，
   可先复制本地内容，再明确选择放弃本地草稿并重新读取、核对已保存版本；不会自动重发保存。
   未保存草稿仅保留在当前页面内存，刷新或关闭页面前会提示，确认离开后无法保证恢复。
5. “确认申请材料”表示选择此职位使用的版本，不会授权向雇主提交。材料内容或
   选择变化后，检查当前版本；旧检查结果不代表新版本已通过。
6. 材料检查通过且仍适用于当前版本后，点击下载申请材料 ZIP。服务器核验登录账号、
   职位、所选材料版本与审核签名，再生成 ZIP。浏览器在请求前后读取并比较材料；
   账号或材料变化、读取失败时不会保存文件，请刷新、核对并重新检查。多次读取并非
   原子操作，下载后仍需自行检查文件。
7. 打开 ZIP，逐页核对简历和所选求职信的文字、分页、字体和排版，再“前往雇主网站”
   完成申请。PDF 排版可能与网页预览不同，字体覆盖有限；遇到不支持的字符时会阻止
   下载并提示使用“打印视图／另存为 PDF”，同样需要通过服务器审核校验。保存前请
   检查打印预览。常见换行、制表符、不间断空格和可组合音标会在 PDF 中规范化，原材料不变。
8. 只有实际提交完成后，点击“记录我已在雇主网站提交”。这是用户报告的手动记录，
   不能替代雇主回执。若显示记录已接收但状态待刷新，或结果未知，点击“刷新记录状态”
   会重新读取职位、申请历史和任务状态；若仍未确认，先核对申请历史及雇主回执，不重复记录。手动记录
   的职位状态和来源历史在同一事务中写入；若历史记录缺失，不能仅凭状态判断记录来源。刷新发现已有申请记录，
   也不能证明它由哪一次请求产生；未知请求会继续保持锁定。
   如果记录或状态读取长时间没有响应，页面会结束等待并允许重新读取状态；
   请求超时不代表服务端没有处理，也不会自动重新发送记录。
   若页面明确提示本次记录因额度或套餐限制未保存，处理限制后先刷新申请和任务状态，
   核对没有其他记录或进行中的任务，再自行决定是否重新记录；页面不会自动重发。
9. 在申请历史与招聘消息查看后续。材料编辑、下载和打开网站都不会记作已提交。

看板还保留手动拖动职位到不同进展栏的功能；拖到“已申请”会直接修改申请状态，
并写入普通状态变更记录，不会产生上述手动提交记录的来源标记。请只在实际情况
明确时调整状态，并以雇主回执核对；看板状态本身不是回执。点击卡片上的“查看此申请”
可打开对应职位，关闭后仍回到看板。直接移到“拒绝”或“录用”不自动证明已有提交记录；
如果职位保留了过去的申请时间，即使移回“已保存”，也不会再次提供手动记录入口。
如果拖动后的状态更新结果不明确，页面会重新读取当前列表并保留提示；稍候刷新并核对，
确认后可关闭提示。一次读取只反映当时状态，不会自动重复发送更新。
多个职位的提示分别核对、分别关闭。
结果未知的职位在用户明确核对并关闭提示前不能再次移动；若原请求仍在进行，
即使关闭提示也要等它结束。
同一浏览器页面内，即使切换栏目返回，该职位的更新尚未返回时也不能再次拖动；
等待超时后仍需等待原请求结束。整页重新加载或其他标签页不受此保护。

### Agent 协助申请

1. 申请详情已有任务时，点击原任务的进度、问题或审核入口。没有关联任务时，
   “打开 Agent 工作区”可能恢复最近的其他对话；请新建对话并说明此职位。
   如果任务状态无法确认，先刷新；打开工作区不会创建任务或授权提交。
2. 在同一个 Agent 会话中补充信息和授权，避免另开任务重复处理。
3. 等待授权、正在填写、正在提交和提交结果待核实分别显示，不合并成“已完成”。
4. 登录、验证码或 MFA 按原会话的交接说明处理；仅在现有系统允许时恢复。
5. 结果待核实时先查看原会话和回执，不再次提交。

任务等待时，材料待审核、人工接手、表单填写结果待核实和提交结果待核实分别提示。
需要信息或验证时，进入原任务查看具体要求；状态不明确时不会猜测一定有问题可回答。
回答后，如果任务摘要更新较慢，申请页可能暂时仍显示需要处理；请回原任务核对
问题记录，避免重复回答。模拟测试覆盖了这种情况，实际状态同步仍需 Agent 侧验证。
审核材料与授权提交是不同操作，打开原任务本身不会授权提交。

较早的隔离测试发现：新建会话可能在会话已创建后显示失败；相关修复已进入主线。
如果遇到类似情况，
先查看会话列表，确认是否已有对应会话，避免反复新建。测试中还发现，
原生问题可能无法显示并使任务失败；此时查看原任务状态，必要时使用上面的
手动申请流程。上述问题记录在本次 PR 中，实际线上状态尚未验证，修复需要在
Agent 维护范围内单独处理。

隔离测试还发现，审批决定已经记录后，刷新 Agent 仍可能显示“批准”入口。
如果遇到这种情况，先查看原任务和审批记录，不要仅凭按钮仍在就重复授权。
测试没有启动申请执行，不能据此判断实际投递结果。

### 常见提示

| 提示 | 应如何处理 |
| --- | --- |
| 检查当前材料 | 材料版本变化或旧检查不适用，请检查当前版本 |
| 无法加载简历 | 展开简历卡并刷新状态；这只读取已有材料，不会重新生成或审核 |
| 创建或导入结果待核实 | 返回简历库核对；不要仅凭一次空列表判断失败或重复创建。当前页的防重保护不跨标签或重载 |
| 所选简历无法自动修正 | 打开当前简历手动编辑；确认使用的版本后重新检查材料 |
| 所选求职信尚未加载 | 先刷新，保留原选择，不用空值覆盖 |
| 状态待刷新 | 当前任务信息不足，刷新或打开原 Agent 查看 |
| 申请历史无法加载 | 刷新历史；读取失败不代表没有记录 |
| 等待审核 | 在原任务查看本次内容；页面跳转不会代替授权 |
| 授权已过期或内容已变化 | 返回原任务，检查本次材料和申请内容后重新审核授权 |
| 已请求停止 | 在原任务等待系统确认最终状态；请求停止本身不代表已经停止 |
| 提交结果待核实 | 查看记录和回执，保持结果未知，不自动重试 |
| 手动记录状态待刷新 | 点击“刷新记录状态”；若仍未确认，先核对记录和雇主回执 |
| 其他页面已更改申请状态 | 刷新当前申请并核对已有记录；不要将状态冲突当作雇主回执 |
| 手动记录受到额度或套餐限制 | 处理限制后刷新状态并核对，再决定是否记录；跨标签页仍需自行核对 |

如果登录状态变化时简历还有未保存的编辑，请保留当前标签页，按提示在新标签页
登录原账号并刷新登录状态。恢复界面提供可复制的内存草稿；请先复制，再打开最新
简历逐项核对，系统不会自动覆盖已保存版本。确认关闭或刷新当前页后草稿会消失。
恢复历史版本会立即修改已保存的简历；若结果无法确认，先重新加载核对，不要重复恢复。
职位关联、材料确认或审核修正结果待核实时，先复制未保存的编辑，再重新加载并核对；
页面会阻止相关重复操作。一次读取不能证明仍在处理的写入没有发生，页面内保护也不跨
标签页或重载。切换简历后如读取失败，重试并确认所选版本，旧内容不会被作为新简历使用。
审核请求在服务器登记后，其他页面会看到“审核进行中或结果未知”，下载和打印会等待
当前审核结果；用户主动启动新审核会替换此前审核，旧请求晚到不能发布结果。
刷新可读取状态；如本地请求结果未知，单次读取不能证明它尚未到达服务器，仍应先核对再决定是否重新审核。
同一标签页会在发送审核或单项修正前保存待确认标记；切换栏目或刷新后仍会阻止复用旧审核。
只有原请求返回且其操作、材料版本和审核结果与服务器读取一致时才解除标记；超时、未知结果或浏览器存储
不可用时保持待确认，不自动重发。如果服务器明确证实本次审核在登记前因长度限制被拒绝，或本次单项修正因审核已替换而在写入前被拒绝，且响应中的本次标识与待确认标记一致，则解除该标记并提示核对；不会自动重发。该证明只描述返回证明的 HTTP 请求，服务端没有按请求标识持久去重，不能据此排除外部重复发送的同一请求已写入。该保护不覆盖其他标签页、设备或被清除的浏览器存储。
旧审核缺少完整审核输入或职位与材料内容依据，升级后需重新检查一次；职位内容、材料内容或模板变化后也需重新检查。
为避免把未送入审核的内容当作已检查，最终简历或来源简历的格式化 JSON 超过 12,000 个字符、
求职信超过 8,000 个字符或已确认职业资料超过 10,000 个字符时，审核会停止并说明需要精简的部分。
字符数按 JavaScript UTF-16 单元计算，简历的格式字符和转义也计入；求职信使用简历名称作为
备用姓名时，该姓名也会送入审核并计入简历长度。精简时保留真实事实。
自动修正使用完整来源和目标内容；职位描述仍只提供前 8,000 个字符，匹配信息不能视作完整职位分析。
审核意见超过展示上限时不会判定通过；请重新检查。AI 审核也不能保证发现所有事实问题。
自动修正会替换受影响的整段或整节；系统拒绝会被校验过程截断或丢字段的建议，
但不能保证模型保留原节的每一条内容。请对照保存的历史版本检查修改，然后重新审核。
从申请详情修正定制简历时，其余章节以当前选中版本为准；无法确定受影响章节时转为手动修改。
自动修正仅使用服务器当前签名审核中的问题，并在生成前和保存事务中核对审核操作、职位和材料版本；
审核被替换或相关材料、职位及选择发生变化时，须重新检查，旧审核不能再次用于修正。
保存使用职位、简历、求职信的数据库行锁与条件更新；该检查不约束修正完成后其他路径的写入，
也不保证来源简历或职业资料在生成期间没有变化。
这些保证从服务器登记提交后开始，混用旧版服务的部署及生产数据库权限尚未验证。
回滚或混用旧部署时，旧代码可能把新写入的“已失效”状态显示为审核不可用，需要重新审核。
新版页面也要求审核响应包含本次操作标识；连接旧版服务时即使返回通过结果，也不能确认该结果属于本次审核。
审核结果目前不会随来源简历或职业资料事实的后续变化自动失效；如修改了依据，请重新检查。
草稿恢复到最新简历后，只有原来进入编辑器时存在可信的职位与返回列表上下文，才会
恢复该职位和筛选条件；否则不会从当前其他账号的地址猜测关联。
查看、返回或刷新简历不会自动启动 AI 分析；需要时请点击“分析匹配度”。

首页和“申请管理 → 需要我处理”展示最近最多 100 个申请任务中的待处理事项，
不能当作全部申请总数。首页无法确认任务状态或只覆盖部分任务时会暂时隐藏相关建议；
已知待办仍可进入原任务，也可打开申请管理。处理后刷新状态。
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
Application list sorting applies to the current page only. The desktop headers
and pagination controls share the same sort setting, which is retained on return.

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

Discover keeps the executed search and recent queries under the signed-in
account. When opening a saved application, it also remembers the result page,
sort and expanded job for that account and result set; if storage is unavailable
or the snapshot no longer matches, the position defaults to the first page. Older
unscoped browser caches are not automatically restored because their account
ownership cannot be verified. They are not deleted by this change.

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
| Facts need confirmation | Review the issue and edit the selected resume | Add only reusable facts to the shared profile; job-specific evidence is not stored here |
| Content needs correction | Review material issues | Open the one repair/check interface |
| Selected material is not loaded | Refresh before checking | Preserve its ID; never clear or replace it |
| Audit belongs to another document/version | Check current materials | Do not present the previous result as valid |
| Current material check passed | Use the selected materials | Keep selection distinct from submit permission |
| Employer requires manual submission | Open employer website | Open a link only |

Jobs and Resume check document IDs, saved revisions and unsaved edits. A current
application-pack download also requires the server to verify the signed audit
receipt and the exact selected document versions. Missing or malformed revision
information does not establish readiness.

When Resume is opened from an application, the original job and resume are
verified together before showing job-specific checks or allowing confirmation.
If another job shares that resume, it is not substituted for the original; if
the original job or its selected materials cannot be verified, the user can
refresh or return to the application. This read-time check does not close the
separate cross-tab race between reading a material selection and writing it.

Once the server commits a review registration, other pages see its pending or
failed state and download/print cannot reuse an older pass. An explicitly started
new review supersedes the previous operation; an older completion cannot publish.
A local request with an unknown outcome may not yet have reached the server, so
a single read does not prove that request has stopped. Older receipts may lack
complete review inputs or job and material-content bases and require one new review; changes to job details,
materials or their templates require a
current check. Mixed-version rollout and production database permissions have not
been verified. Ordinary material writers do not all share the correction lock. A
later change to the source resume or confirmed Persona does not automatically
invalidate the receipt; run a new review when the underlying evidence changes.

Before a review or individual correction, the tab stores a scoped pending marker.
It blocks reuse of an older review across in-app navigation and same-tab reload.
Only the original response matched against the signed server record and material
versions clears it; timeout, unknown response or unavailable storage remain
unconfirmed without an automatic retry. A matching pre-registration length rejection,
or a matching correction rejection before any write because the review changed,
can release that attempt and prompt the user to check the current review. The
certificate describes that HTTP handler only; there is no persistent server-side
attempt deduplication, so it cannot rule out an externally duplicated request
having written. Other tabs, devices and cleared browser storage do not share
this protection.

If a completed response was confirmed in this tab but its materials changed
before reconciliation, the server can return the verified old completion as a
stale proof. A matching proof permits a user-initiated review of the selected
materials; it is never a current passing result. The new review checks the
previous operation under the job lock. If another operation has replaced it,
the request remains unconfirmed rather than being automatically retried or
cleared using a single handler's response. A different material selection
requires explicit confirmation. Legacy clients that do not send this condition
can still supersede another review; there is no global attempt deduplication.
The existing material-selection endpoint does not condition its write on the
previously observed selection. A delayed assignment in one tab can therefore
overwrite a selection made in another tab after the review was read. Protecting
that write requires a separate selection comparison in the assignment transaction;
the review-operation condition alone does not provide that guarantee.

Reviews stop with guidance if a formatted final or source resume exceeds 12,000
UTF-16 code units, a cover letter exceeds 8,000, or confirmed Persona text exceeds
10,000. JSON formatting and escapes count toward the resume limit; a resume name
used as the cover-letter header fallback is also reviewed and counted. Shorten the
identified input without changing facts, then explicitly review again; automatic
correction uses the full source and target content. The job description still
uses only its first 8,000 characters, so match information is not a complete job
analysis. A result with more findings than the display limit cannot pass; review
again. A model review cannot guarantee every factual issue is detected.
An automatic correction replaces its affected section. A suggestion that would
be truncated or lose fields during validation is rejected, but the model may
still omit information from the previous section. Compare the saved version
history and review the corrected material before running a new audit.
When the drawer repairs a tailored resume, untouched sections come from the
selected version, and an ambiguous section requires manual editing. Repair uses
findings from the current signed operation and checks the operation, job and
material versions before generation and again under the Job, Resume and optional
CoverLetter row locks in the save transaction. A changed selection, superseding
review or conflicting material rejects the correction. A successful repair marks
the old review stale; older deployments may interpret this new signed state as
unavailable and require a fresh review. Newer pages also require an operation ID
in the review response; a response from an older service cannot establish that
its result belongs to the current review. This does not coordinate later writes or
prove that the source resume or Persona remained unchanged. Mixed-version rollout,
production RLS and Worker runtime behavior remain unverified.

An absent optional letter is distinct from a selected letter still loading.
Confirming the same selected letter omits a redundant assignment, because that
write would otherwise advance its saved revision. Selecting a different letter
invalidates its old check and requires checking the newly saved selection.
For a factual cover-letter issue, the application drawer opens the same job in
Resume for the candidate to verify and edit the selected letter, then return and
check again. It does not automatically overwrite the whole letter. Existing
cover-letter editing does not provide cross-tab write coordination or an
automatic history backup. If the selected letter cannot be read, the editor
offers a reload instead of opening another draft. For an uncertain save, copy
the local text, then explicitly discard the local draft and reload to inspect
the saved version. Unsaved text is retained only in the current document's memory; a
browser warning precedes reload or close, but recovery after leaving is not guaranteed.

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
receipt verification. The manual-record endpoint conditionally updates the job and
creates its source activity in the same database transaction. A competing manual
record or an ineligible current state receives a conflict response; review the
current application before proceeding. This protection does not make other Agent,
Worker or status-update paths mutually exclusive with manual recording.

The existing Kanban also permits a user to drag a job to another status, including
Applied. That changes the status and records a generic status-change activity;
it does not use the manual-submission record or add its source marker. A board
status is user-maintained tracking information, not an employer receipt.
If the status update has an uncertain result, the current list is reloaded and a
notice remains until the user checks and dismisses it. A read is only a snapshot;
the update is not automatically sent again. Notices for different jobs are checked
and dismissed separately.
An uncertain job cannot be moved again until the user checks and dismisses its
notice; if its original request is still pending, the lock remains until it ends.
Within the same browser document, that job cannot be moved again while its request
remains pending, including after a timeout and navigation between sections. A full
page reload or another tab does not share this protection.

The browser reads the account-owned job, selected saved documents and existing
passing audit before requesting the ZIP. The server validates ownership, the signed
audit receipt and selected versions, then renders the ZIP. Before saving, the
browser reads and compares the material snapshot again; missing, changed or
unreadable material prevents saving. These checks do not start a new AI audit.
The reads, server rendering and file save are not one atomic operation across
concurrent changes; review each downloaded PDF before use. The same server gate
protects Print view / Save as PDF, which offers an alternative when a PDF font
cannot represent a character; inspect the print preview before saving. A ZIP contains the selected resume PDF,
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
unavailable, the action is withheld. This marker is scoped to the browser tab and
can be lost when that tab's storage is cleared. The server's conditional write
protects competing manual records for the same job, but does not establish a
global cross-device or cross-Agent lock. Check application history and the employer
receipt before deciding what to do next.

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

Resume renaming waits for an in-flight save, and edits made during a rename remain
pending for the next save. This tab stores an account- and resume-scoped marker
before the rename request. An unknown outcome retains the marker and prevents
overwriting that resume; a matching late response can settle its own marker.
The marker contains no resume name or content and does not protect other tabs or
devices, or survive clearing this tab's storage. If protective storage is
unavailable, the page explains the restriction and asks the user to preserve edits.

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
Waiting tasks distinguish prepared-material review, user handoff, an unverified
form-filling outcome and an unverified submission outcome. A request for information
may also require verification; an unspecified wait directs the user to the original
task without guessing a question. Reviewing materials does not authorize submission.
If the task summary lags behind an answer, the application may temporarily still
show that action is needed. Check the question record in the original task instead
of answering again. A mocked test covers this case; synchronization in the real
Agent path remains to be verified.
Without an associated task, Open Agent navigates to the generic workspace. It may
restore the most recent unrelated conversation, so the user is told to start a new
conversation and identify the job. It does not infer a session from job ID or send
a task prompt. If the task list is unavailable or limited, absence is not asserted.

The task query returns at most 100 recent records. Dashboard labels this scope,
shows up to three attention cards and links to the existing recent attention view.
Missing records at that boundary do not prove a task is absent. Loading, failures
and partial coverage show refresh guidance instead of a new preparation action.
Refocusing Applications or Dashboard refreshes the task projection; an older read
cannot replace a newer response. Cross-window changes still need focus or refresh. Manual work is available after a
failed or cancelled task only when its checkpoint explicitly says it stopped
before submission; uncertain and active execution remain guarded. The projection
is a snapshot and does not by itself prevent concurrent changes in another tab.

## 8. Exceptions and outcomes

| Situation | Next action | Boundary |
| --- | --- | --- |
| Unknown experience | Review the original question if available, or edit the unsupported material | Do not invent a claim or reinterpret unknown as no |
| Login, MFA or CAPTCHA | Follow the original session's handoff instructions | No bypass or automatic retry; no promise of unsupported takeover UI |
| Materials changed | Check the current versions | Old checks and approvals are not authority for new content |
| Task query fails | Refresh status | Do not interpret failure as no task |
| Preparation fails | Inspect/retry the existing specific step | No generic submission retry |
| Approval expires | Review in the original session | Existing receipt/version/expiry checks remain authoritative |
| Stop requested | Wait for the original task to confirm its state | A stop request alone does not mean execution has stopped |
| Submission started | View original progress | Do not enqueue another application |
| Submission uncertain | Check original records and receipt | Keep unknown distinct from failed or submitted |
| Task cancelled | Read the last recorded state | Navigation does not resume it |
| Historical application has a result | Read history and follow up | Editing a resume does not erase the historical result. The materials shown are current versions; the view cannot establish the exact versions submitted |

The current application record points to mutable resume and cover-letter records.
It does not provide a reliable, submission-bound snapshot of both documents.
Preserving and retrieving the exact historical materials requires a separate
storage and lifecycle design; do not present the current preview as that snapshot.

### Follow-up design: historical application materials

This is a proposed, separate design, not an implemented capability of this PR.
The current scope excludes schema and Agent/Worker changes. A future design
must capture immutable document content and presentation settings, or durable
content-addressed files, and bind them to the specific user, job, application
record and relevant task or submission attempt. Store the material identity,
capture time, source and a content digest alongside each reference; authorize
retrieval within the same user and application scope.

For a manual application, a snapshot at the time the user records a submission
can establish only what was selected in ApplyMate at that moment. The user may
have uploaded different files on the employer's website. Label that distinction
clearly; record what was actually uploaded only when supported by explicit user
evidence. Opening a website or downloading a file remains distinct from submission.
For an Agent application, bind materials to the real upload and approval lineage
using the existing execution ownership and authorization boundaries; an approval
or selected document ID alone does not establish which bytes were uploaded.

Concurrent edits and captures need an atomic version decision with cooperating
writers, so a later edit cannot silently change a recorded snapshot. Define
fail-closed handling for missing, stale, failed or uncertain capture without
automatically retrying submission or inventing a receipt. Historical records
without sufficient evidence must remain unknown rather than being reconstructed
from current materials. The design must also specify retention and user deletion,
privacy settings, access control, and what remains visible when a referenced
document or application is deleted; no content should be retained merely to
claim a history that was never captured.

## 9. Dashboard and Inbox

Dashboard puts recent task attention before Momentum. It shows at most three
recent attention or in-progress task cards and existing saved/follow-up continuations, excluding
jobs with known attention or in-progress tasks and without claiming
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
| Audited server ZIP and browser snapshot checks | `application-export-snapshot`, `bundle`, `application-pack`, `application-audit-receipt`, `resume-pdf`, `cover-letter-pdf` |
| Manual record status | `application-manual-record` |
| Account-bound in-memory recovery | `application-recovery-draft`, `application-recovery-navigation` |
| Saved-search identity and cancellation | `application-search-state`, `application-search-save` |
| Existing task projection | `application-task-model`, `useApplicationTasks`, `application-task-card` |
| Progress and Dashboard guidance | `application-progress`, `application-dashboard-guidance` |

Focused tests cover saved identities, cancellation after unmount/account change,
history navigation, save-before-return, optional letters, stale versions, bounded
task coverage, uncertain outcomes and read-only task links. Mounted browser
fixtures exercise real components with synthetic sessions and mocked requests.
An isolated CI fixture also signs in with real synthetic credentials against a
disposable database, saves a synthetic search result, opens and reloads its exact
application, and checks that another account cannot read it. The fixture creates
and links a synthetic resume through the real API, edits it in the UI, confirms
materials using a signed, seeded synthetic audit, checks the downloaded PDF text, opens
a mocked employer page and explicitly records a synthetic manual application.
Database assertions distinguish the state before and after that record. Search,
the audit and employer page are simulated, and database RLS is disabled; this
does not establish production permissions, a real AI audit or employer receipt.
Separately, `e2e/application-authenticated-preparation.browser.ts` exercises one
continuous manual journey with real synthetic-account login, real application
routes and a disposable database: save the synthetic job, prepare and audit its
materials, edit the selected resume, return to the same application, deliberately
recheck the changed version, inspect the downloaded PDF, open a simulated employer
page and explicitly record the application. Database assertions check that the
job remains saved until the manual record. The [CI run for commit `b46daaa7`](https://github.com/YuanshuoDu/applymate-jobcopilot/actions/runs/42308879197/job/128205101154)
passed this fixture. Its model responses and employer page are synthetic, and the
disposable database does not establish production RLS or permissions; it does not
prove a real provider response, employer submission or receipt.
One fixture opens the original Agent session from an application, answers a mock
question, reviews a mock approval and displays a simulated unverified outcome;
its state changes are injected by the fixture and page reloads. These checks prove
UI wiring, not Worker execution, authenticated database, live ATS or production behavior.
Separate isolated real-authentication fixtures now exercise a synthetic Agent
question and an approval against a disposable database. The question fixture also
opens the original session from a synthetically linked application and answers the
question in that same session. The link is seeded by the fixture; it does not prove
that a real application task produced the question. Earlier runs exposed session
serialization, question and approval failures; passing later fixtures does not
establish their causes. The full continuous application-to-execution journey, a
real model or ATS, production behavior and an employer receipt remain unverified.

Worker runtime, Agent-owned layout, protocol, policies, mutation APIs, schema and
roadmap remain under their existing owners. No new state machine, persistent
application-pack model, batch approval or autopilot policy is introduced.
