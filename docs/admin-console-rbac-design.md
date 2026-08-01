# ApplyMate 内置管理后台与权限隔离开发规格

> 状态：实施规格（v1）  
> 适用范围：`apps/web` 管理后台、API、Prisma/PostgreSQL、Worker 运维入口  
> 首要原则：**默认拒绝、服务端鉴权、最小权限、可审计、租户数据不混用。**

## 1. 目标、边界与术语

### 1.1 目标

在 ApplyMate 主站中增加独立的内部管理后台，供平台运营、客服、风控和工程运维人员管理平台，而不改变候选人端体验。后台应支持：

- 用户与订阅管理；
- 作业、自动投递、队列和通知的受限排障；
- ATS 来源、系统开关、AI 配额与运营配置管理；
- 平台公告广播，并投递到目标用户的站内 `Notification`；
- 平台指标、异常告警和完整审计；
- 多位内部员工按职责协作，且权限和可见数据严格隔离。

### 1.2 不在首期范围

- 企业客户（B2B）自助创建组织、邀请成员；
- 管理员无权读取候选人的 API Key、密码哈希、OAuth refresh token、完整简历或邮件正文；该限制同样适用于 `super_admin`。
- 用前端路由守卫、隐藏菜单或 `plan = enterprise` 代替服务端授权；
- 将 Bull Board 作为正式管理后台，或把它公开暴露到互联网。

### 1.3 术语

| 术语 | 含义 |
|---|---|
| 候选人租户 | 当前产品中的一个 `User` 及其私有业务数据；v1 的 tenant key 为 `userId`。 |
| 内部管理员 | 受聘于 ApplyMate、登录内部后台的成员；不等同于付费用户。 |
| 平台资源 | 用户、作业、订阅、通知、ATS 配置、队列、运营开关等。 |
| 权限（permission） | 最小的授权单元，例如 `users.read`、`jobs.retry`。 |
| 角色（role） | 一组权限，例如 Support、Ops、Super Admin。 |
| Break-glass | 处理安全事件时临时提升权限的受控流程。 |

## 2. 当前基线与必须修复的风险

仓库现状：`User` 只有 `plan`，NextAuth JWT 只携带 `id` 与 `plan`；各业务 API 以 `requireAuth()` 返回的 `userId` 过滤数据。它适用于候选人访问自身数据，**尚不具备内部角色或管理员审计能力**。

此外，`apps/worker/src/index.ts` 的 Bull Board 只有在设置 `BULL_BOARD_PASSWORD` 时才有 Basic Auth；生产环境必须改为默认拒绝并仅允许内网/受控身份代理访问。它不是用户管理或审计的替代品。

## 3. 总体架构

```mermaid
flowchart LR
  A[内部员工] --> B[NextAuth 登录 + MFA]
  B --> C{服务端 requireAdmin}
  C -->|拒绝| D[403 + 安全审计]
  C -->|允许| E[/admin 管理后台]
  E --> F[Admin API]
  F --> G[授权策略 RBAC + 范围校验]
  G --> H[(PostgreSQL / Prisma)]
  G --> I[Worker 控制 API]
  F --> J[AdminAuditLog append-only]
  K[候选人] --> L[普通 API requireAuth]
  L --> M[强制 userId 条件]
  M --> H
```

隔离在三个层面同时执行：

1. **路由层**：`/admin/**` 和 `/api/admin/**` 必须通过管理员会话验证；中间件只做快速拦截，不能作为唯一防线。
2. **服务层**：每一个管理员操作调用 `requireAdmin(permission)`，每一个候选人查询始终强制 `userId = session.user.id`。
3. **数据层**：所有候选人拥有的数据表都有 `userId`；敏感字段从管理员 DTO 中排除。生产 PostgreSQL 在第二阶段启用 RLS，作为应用代码失误的最后一道防线。

## 4. 身份、角色与权限模型

### 4.1 身份设计

内部权限与 `User.plan` 完全分离。保留 `User` 作为所有登录主体的身份表，新增 `AdminMembership` 表表示该用户是否为内部人员及其状态。不要使用邮箱域名、前端常量、环境变量邮箱列表或 `plan` 推断管理员身份。

会话 JWT 只缓存低风险声明（`id`、`adminSessionVersion`）；不能只把 role 长期缓存到 JWT。每次敏感操作都从数据库读取启用状态、角色和权限，或使用最多 5 分钟且可按版本失效的服务端缓存。禁用成员、修改角色、强制退出时递增 `adminSessionVersion` 并撤销现有会话。

### 4.2 内置角色

| 角色 | 典型使用者 | 权限边界 |
|---|---|---|
| `support` | 客服 | 查看脱敏用户资料、工单相关作业与通知；不能查看内容、改订阅、运行队列或发起广播。 |
| `operations` | 平台运营 | 用户与订阅只读、作业/投递排障、ATS 来源状态、受限重试；可草拟运营广播，不能自行发布。 |
| `analyst` | 数据/产品 | 只读聚合指标和已匿名化导出；不能按用户浏览私密数据。 |
| `billing` | 财务 | 管理订阅状态、退款标记与账单备注；无简历、邮箱、AI Key、投递详情访问权。 |
| `security_admin` | 安全负责人 | 管理内部成员、角色、会话吊销、审计检索和 break-glass 审批；不默认拥有业务写权限。 |
| `platform_admin` | 受控的少数平台管理员 | 除角色管理和密钥读取外的大部分平台配置与运维操作。 |
| `super_admin` | 两名以内的应急负责人 | 全权限；必须 MFA、理由、双人审批（对高危操作）和强化审计。 |

禁止创建“万能客服”角色。角色默认不继承；若实现继承，只能单向继承预定义的权限集合，并在测试中断言权限集。

### 4.3 权限字典

格式采用 `resource.action`。首期必须使用显式 allow-list，未知权限一律拒绝。

| 域 | 权限 |
|---|---|
| 用户 | `users.read`, `users.read_pii_masked`, `users.suspend`, `users.restore`, `users.export_anonymized` |
| 订阅 | `billing.read`, `billing.update`, `billing.refund_mark` |
| 作业与投递 | `jobs.read_metadata`, `jobs.read_content_masked`, `applications.read`, `applications.retry`, `applications.cancel`, `applications.manual_review` |
| 运营配置 | `ats.read`, `ats.update`, `feature_flags.read`, `feature_flags.update`, `ai_budget.read`, `ai_budget.update` |
| Worker | `queues.read`, `queues.retry`, `queues.pause`, `queues.resume` |
| 通知 | `notifications.read_metadata`, `broadcasts.create`, `broadcasts.update`, `broadcasts.preview`, `broadcasts.approve`, `broadcasts.publish`, `broadcasts.cancel` |
| 安全 | `admin_members.read`, `admin_members.manage`, `admin_roles.manage`, `sessions.revoke`, `audit.read`, `break_glass.request`, `break_glass.approve` |
| 系统 | `observability.read`, `incidents.manage` |

任意凭证读取、完整简历下载、完整 Gmail 内容读取**永远不属于管理员能力范围**，不为普通角色、`super_admin` 或 break-glass 提供例外。该限制由 DTO、数据库访问封装、日志脱敏规则和自动化测试共同强制；不得以“排障”“合规”或“紧急事件”为由绕过。

广播职责分离：`operations` 拥有 `broadcasts.create/update/preview`，`platform_admin` 或 `super_admin` 才拥有 `broadcasts.approve/publish/cancel`；创建人不得审批或发布自己的广播。

## 5. 数据模型与迁移

### 5.1 Prisma 模型（目标）

以下模型放入 `apps/web/prisma/schema.prisma`。枚举名称和字段可随 Prisma 命名风格微调，但语义不得缩水。

```prisma
enum AdminMembershipStatus { active suspended revoked }
enum AdminMfaLevel { none totp webauthn }
enum AdminAuditOutcome { success denied failed }
enum AdminTargetType { user job application ats_source feature_flag queue admin_member }

model AdminRole {
  id          String   @id @default(cuid())
  key         String   @unique // support, operations, ...
  name        String
  description String?
  permissions String[]
  system      Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  memberships AdminMembership[]
}

model AdminMembership {
  id             String                @id @default(cuid())
  userId         String                @unique
  roleId         String
  status         AdminMembershipStatus @default(active)
  mfaLevel       AdminMfaLevel         @default(none)
  sessionVersion Int                   @default(1)
  grantedById    String?
  grantedAt      DateTime              @default(now())
  revokedAt      DateTime?
  user           User                  @relation("AdminUser", fields: [userId], references: [id], onDelete: Restrict)
  role           AdminRole             @relation(fields: [roleId], references: [id], onDelete: Restrict)
  @@index([status, roleId])
}

model AdminAuditLog {
  id            String            @id @default(cuid())
  requestId     String
  actorUserId   String?
  actorRoleKey  String?
  action        String
  targetType    AdminTargetType?
  targetId      String?
  tenantUserId  String?           // 被影响候选人的 userId；不可存内容快照
  reason        String?
  outcome       AdminAuditOutcome
  ipHash        String?           // HMAC(IP)，不保存明文 IP
  userAgentHash String?
  before        Json?             // 仅 allow-list 的非敏感字段
  after         Json?
  errorCode     String?
  createdAt     DateTime          @default(now())
  @@index([actorUserId, createdAt(sort: Desc)])
  @@index([tenantUserId, createdAt(sort: Desc)])
  @@index([action, createdAt(sort: Desc)])
}

model AdminBreakGlassGrant {
  id          String   @id @default(cuid())
  requesterId String
  approverId  String?
  permission  String
  reason      String
  expiresAt   DateTime
  revokedAt   DateTime?
  createdAt   DateTime @default(now())
  @@index([requesterId, expiresAt])
}

enum BroadcastStatus { draft pending_approval scheduled publishing published cancelled failed }
enum BroadcastAudienceType { all_active_users plan location explicit_user_ids }

model AdminBroadcast {
  id             String                @id @default(cuid())
  title          String
  body           String                @db.Text
  audienceType   BroadcastAudienceType
  audience       Json                  // allow-list 筛选条件或 userId 列表；不存 PII 快照
  status         BroadcastStatus       @default(draft)
  scheduledAt    DateTime?
  approvedById   String?
  publishedById  String?
  createdById    String
  recipientCount Int                   @default(0)
  deliveredCount Int                   @default(0)
  failedCount    Int                   @default(0)
  createdAt      DateTime              @default(now())
  updatedAt      DateTime              @updatedAt
  notifications  Notification[]
  @@index([status, scheduledAt])
}

// 对现有 Notification 的增量字段/关系；保留现有 userId、type、title、body、read、jobId。
model Notification {
  // ...现有字段...
  broadcastId String?         @map("broadcast_id")
  broadcast   AdminBroadcast? @relation(fields: [broadcastId], references: [id], onDelete: Restrict)
  @@unique([broadcastId, userId]) // 同一广播对同一用户只投递一次；NULL 不影响非广播通知
  @@index([broadcastId])
}
```

为 `User` 增加反向关系 `adminMembership AdminMembership? @relation("AdminUser")`。不添加 `isAdmin Boolean`；它无法表达角色、禁用、MFA 与撤销语义。

`AdminBroadcast` 是广播命令与审计对象；投递结果使用现有 `Notification` 表，每位收件人生成一行：`type = "platform_broadcast"`、`title`、`body`、`userId`、`broadcastId`、`createdAt`。`@@unique([broadcastId, userId])` 让发布任务可安全重试。绝不通过查询或复制用户的邮件正文、简历、Persona、API Key、密码/OAuth 信息来构建广播人群。

### 5.2 数据敏感度与 DTO

| 分类 | 示例 | 管理后台规则 |
|---|---|---|
| 严禁返回 | `User.password`、`Account.access_token`、`refresh_token`、`UserApiKeys`、浏览器 profile/cookie | 永不进入 API select、日志、审计 before/after 或导出。 |
| 高敏感 | 简历正文、PersonaFact、Gmail 正文、求职信 | 管理员永不返回；仅显示“是否存在/长度/状态”等元数据。 |
| PII | email、姓名、电话、location、LinkedIn/GitHub | Support 默认掩码（如 `s***@example.com`）；查看明文必须有专门权限与理由。 |
| 普通运营 | plan、创建时间、作业状态、错误码、计数 | 按角色返回。 |

管理员 API 必须使用专属 DTO 和显式 Prisma `select`，禁止 `include: { user: true }` 或向页面透传 Prisma 实体。

### 5.3 RLS 第二层防线

应用层隔离上线后，在生产 PostgreSQL 对候选人表逐步启用 RLS（至少 `Job`、`Resume`、`CoverLetter`、`Notification`、`ApplyResult`、Persona/Gmail 相关表）。每个候选人请求在事务中设置不可伪造的数据库会话变量，例如 `SET LOCAL app.user_id = '<verified id>'`，策略只允许 `user_id = current_setting('app.user_id', true)`。

管理员服务帐户不能绕过 RLS 后直接任意查询：应使用受限的数据库角色或经过审核的 `SECURITY DEFINER` 视图/函数返回脱敏数据。RLS 改造要用独立 issue 和回归测试完成，避免在无事务的连接池中泄漏 session variable。

## 6. 管理后台信息架构

路由根为 `/admin`，与候选人 AppShell 分离，使用 `AdminShell`。未授权响应为 404 或 403（推荐 API 为 403、页面重定向到 `/login?next=/admin`；已登录非管理员展示无权限页，不泄露功能细节）。

| 页面 | 路由 | 最低权限 | 主要内容 |
|---|---|---|---|
| 概览 | `/admin` | `observability.read` | DAU、注册、订阅、投递成功率、队列健康、告警。 |
| 用户 | `/admin/users` | `users.read` | 搜索、状态、计划、脱敏资料、账户状态。 |
| 用户详情 | `/admin/users/[id]` | `users.read` | 元数据、作业/投递摘要、通知、审计时间线；敏感内容按权限掩码。 |
| 订阅 | `/admin/billing` | `billing.read` | 计划分布、变更记录、失败状态。 |
| 投递运维 | `/admin/applications` | `applications.read` | 失败分类、状态、受限重试/取消/转人工。 |
| ATS 与发现 | `/admin/ats` | `ats.read` | 来源健康、速率、最近抓取、注册表启停。 |
| 队列 | `/admin/queues` | `queues.read` | 指标与任务摘要；操作走受控 API，不嵌入 Bull Board。 |
| AI 与开关 | `/admin/platform` | `feature_flags.read` | 配额、模型健康、feature flag；写操作必须二次确认。 |
| 广播 | `/admin/broadcasts` | `broadcasts.create` | 草稿、受众预览、审批、定时发布、投递结果；仅写入用户站内 Notification。 |
| 审计与安全 | `/admin/audit` | `audit.read` | 可筛选的不可编辑审计事件。 |
| 内部成员 | `/admin/access` | `admin_members.manage` | 成员、角色、MFA、会话撤销、break-glass。 |

页面展示是体验层；每个按钮的 API 仍独立授权。不得因为页面已获得 `users.read` 就默认允许 `users.suspend`。

## 7. API 规范

### 7.1 约定

- 路径统一为 `/api/admin/v1/**`；候选人 API 保持原路径且不能调用管理员服务。
- 所有响应带 `x-request-id`；写操作要求 `Idempotency-Key`。
- 列表统一使用 cursor 分页：`?limit=50&cursor=...`，最大 100；禁止无上限导出。
- 所有写操作提交 `reason`（10–500 字符）、CSRF 校验（cookie 会话）、服务端 schema 校验与审计写入。
- 返回 401（未登录）、403（无权限）、404（资源不存在或不在可见范围）、409（版本冲突）、422（业务规则）、429（限流）。错误不回传 token、SQL、堆栈或候选人内容。

### 7.2 核心端点

| 方法 | 端点 | 权限 | 说明 |
|---|---|---|---|
| GET | `/users` | `users.read` | 搜索用户，默认掩码 PII。 |
| GET | `/users/:id` | `users.read` | 用户运营摘要；按字段权限脱敏。 |
| POST | `/users/:id/suspend` | `users.suspend` | 暂停登录/自动化，必须提供 reason，禁止操作自己。 |
| POST | `/users/:id/restore` | `users.restore` | 恢复状态。 |
| PATCH | `/users/:id/plan` | `billing.update` | 乐观锁 `version` + 审计 before/after。 |
| GET | `/applications` | `applications.read` | 按状态/ATS/错误码筛选。 |
| POST | `/applications/:id/retry` | `applications.retry` | 仅允许可重试错误，检查用户与域名额度。 |
| POST | `/applications/:id/cancel` | `applications.cancel` | 只取消尚未提交的任务。 |
| GET/PATCH | `/ats/:id` | `ats.read` / `ats.update` | 启停来源、调整允许范围的限速配置。 |
| GET | `/queues/summary` | `queues.read` | 从 Worker 聚合只读指标。 |
| POST | `/queues/:name/pause` | `queues.pause` | 高危，理由+二次确认+审计。 |
| POST | `/queues/:name/resume` | `queues.resume` | 同上。 |
| GET/POST | `/broadcasts` | `broadcasts.create` | 创建草稿、查看自身草稿；输入仅为标题、正文、允许的受众条件。 |
| POST | `/broadcasts/:id/preview` | `broadcasts.preview` | 返回数量与匿名分布，不返回收件人名单或 PII。 |
| POST | `/broadcasts/:id/approve` | `broadcasts.approve` | 审批他人草稿；创建人不能审批。 |
| POST | `/broadcasts/:id/publish` | `broadcasts.publish` | 写入 `Notification`，要求已审批、幂等键和二次确认。 |
| POST | `/broadcasts/:id/cancel` | `broadcasts.cancel` | 仅取消尚未开始投递的广播。 |
| GET | `/audit` | `audit.read` | 审计检索；不可修改、不可删除。 |
| POST | `/members` | `admin_members.manage` | 邀请/授予角色；强制 WebAuthn 注册。 |
| PATCH | `/members/:id` | `admin_members.manage` | 变更角色或状态，吊销旧会话。 |
| POST | `/sessions/revoke` | `sessions.revoke` | 撤销目标内部成员会话。 |
| POST | `/break-glass/requests` | `break_glass.request` | 创建 30 分钟以内的临时授权申请。 |
| POST | `/break-glass/requests/:id/approve` | `break_glass.approve` | 不得由申请人自批；审批和使用逐条审计。 |

### 7.3 Worker 管理接口

Web 不得直连 Redis 或暴露 Bull Board。Worker 只接受来自 Web server 的 mTLS/签名服务凭证，并验证时间戳、nonce、操作 allow-list 和 `requestId`。接口仅支持汇总、暂停、恢复、任务重试等明确动作；不支持任意执行脚本、查询 Redis 或下载浏览器资料。

生产 Bull Board 的要求：`BULL_BOARD_PASSWORD` 缺失时进程必须拒绝启动该管理路由；服务绑定 loopback/私有网络，禁止公网 ingress；在 Nginx/Cloudflare Access/VPN 后再加独立身份认证，并记录访问日志。

### 7.4 广播投递规则

广播只是一种平台站内消息：发布服务分批创建 `Notification` 记录，不发送候选人邮件，也不读取 Gmail、简历、Persona 或任何凭证。可选受众仅为 allow-list 条件：`all_active_users`、`plan`、`location` 或显式 `userId` 列表；禁止按邮箱、求职内容、Persona、投递失败原因等敏感属性定向。

- 标题最多 120 字符、正文最多 2,000 字符；仅允许经过净化的 Markdown/plain text，禁止原始 HTML、脚本与追踪像素。
- 预览只返回收件人数量，以及按 plan/location 聚合且达到 k-anonymity（建议 k >= 20）的分布；不得返回名单或邮箱。
- 发布任务以固定批次执行，可重试但以 `(broadcastId, userId)` 唯一约束去重；部分失败保留计数、错误码和可恢复状态，不记录收件人 PII 快照。
- 已开始投递的广播不能撤回已创建的 `Notification`；取消只阻止剩余批次。发布前须在 UI 明确显示这个不可逆语义。
- 用户可在其通知中心将单条广播标为已读；对于产品更新/营销信息，后续应接入用户通知偏好与退订规则。安全、服务中断和法律要求的消息可由政策配置为不可退订。

## 8. 授权实现规范

### 8.1 服务端函数

新建 `apps/web/src/lib/admin/`，建议拆分：

```text
admin/
  permissions.ts       // Permission union、内置角色权限，不依赖 Next.js
  authorization.ts     // requireAdmin、hasPermission、break-glass 校验
  audit.ts             // appendAdminAudit，字段脱敏与失败兜底
  dto.ts               // admin DTO 与 mask helpers
  csrf.ts              // 管理写操作的 CSRF 校验
  worker-client.ts     // 已签名的受限 Worker 调用
```

`requireAdmin(permission, options)` 的固定流程：

1. 调用 `safeAuth()`，无会话抛出标准 401；
2. 读取 `AdminMembership`、`AdminRole.permissions`、状态、MFA 等级与 `sessionVersion`；
3. 校验 active、会话版本、所需权限、必要 MFA 和可用 break-glass；
4. 不通过时写 `AdminAuditLog(outcome = denied)`，返回 403；
5. 通过时返回不可变 `AdminActor`（id、role、permissions、requestId），不可返回完整 `User`。

每条路由在处理器第一行执行此函数。Server Component、Server Action、Route Handler、cron/worker 回调都必须使用同一策略模块；不要复制权限判断。

### 8.2 候选人数据访问规范

候选人端的所有查找/更新/删除都使用 repository 函数，并把认证获得的 `userId` 作为不可选参数。例如：

```ts
getJobForUser({ userId, jobId })
// Prisma where: { id: jobId, userId }
```

禁止先通过 `id` 查询再在应用层比较 `userId`，也禁止接受客户端传来的 `userId`。嵌套资源必须经父资源和 userId 联合过滤。管理员访问同样走独立的脱敏 repository，不能复用候选人端的“按任意 ID 查询”实现。

## 9. 高风险操作控制

| 操作 | 强制控制 |
|---|---|
| 暂停/恢复用户 | 原因、二次确认、不能操作自己、审计、通知用户（安全例外可延迟）。 |
| 改订阅/配额 | 乐观锁、原因、前后快照、幂等键；退款需 Billing 角色。 |
| 重试/取消投递 | 校验当前状态、用户/域名限额、ATS 合规规则；不得重试已提交项。 |
| 暂停全局队列/关闭 ATS | 双人审批或 `super_admin` break-glass、自动过期、告警。 |
| 发布平台广播 | 草拟人与审批/发布人不同；预览只给数量与匿名分布；内容净化、幂等、速率限制、审计以及停止/取消机制。 |
| 改管理员角色 | 申请人与审批人不同；修改后撤销目标会话；禁止删除最后两个 super admin。 |
| 导出数据 | 默认匿名聚合；任何用户级导出要异步生成、加密、短时签名 URL、下载审计与保留期。 |

## 10. 审计、监控与数据保留

### 10.1 审计事件

至少记录：登录成功/失败、无权访问、查询敏感资料、导出、用户状态/plan 变更、投递操作、队列操作、ATS/feature flag 变更、角色与会话变更、break-glass 的申请/审批/使用/过期。

审计日志是 append-only：应用角色只有 INSERT/SELECT 权限，不授予 UPDATE/DELETE；每日将哈希链摘要写入隔离存储或日志平台以发现篡改。日志保留 24 个月；安全事件相关日志按合规要求冻结。不得记录明文密码、token、简历、邮件、AI prompt 或完整 IP。

### 10.2 告警

- 5 分钟内管理员 403 或登录失败超过阈值；
- super admin/break-glass 使用；
- 队列暂停、ATS 全局停用、AI 预算或限流规则变更；
- 批量用户状态或 plan 变更；
- 审计写入失败（写操作应失败关闭，不执行副作用）；
- RLS 拒绝、跨 userId 访问测试失败、Worker 签名验证失败。

## 11. 安全基线

- 管理员必须使用 WebAuthn（优先）或 TOTP；`super_admin` 只允许 WebAuthn，并要求近期重新认证（15 分钟）。
- 管理端 cookie 使用 `HttpOnly`、`Secure`、`SameSite=Lax/Strict`；管理写操作使用 CSRF token、Origin/Referer 校验与严格 CSP。
- 管理端、普通端、Worker 使用不同的 service secret 和最小化数据库凭据；所有密钥放在托管密钥系统，轮换并禁止写入日志。
- `/api/admin/**` 按用户与 IP 双重限流；搜索与导出防枚举；管理 UI 不缓存含 PII 的响应（`Cache-Control: no-store`）。
- 上传、截图、HAR 和导出文件使用私有 bucket、按对象授权、短期 URL、生命周期规则和恶意文件扫描。
- 错误信息对用户最小化，对受控日志保留 requestId；禁止在客户端显示内部堆栈。

## 12. 测试与验收标准

### 12.1 自动测试

| 层级 | 必测项 |
|---|---|
| 单元 | 权限矩阵、角色禁用、sessionVersion、MFA、break-glass 过期/自批拒绝、PII 掩码、审计脱敏；断言所有管理员角色都不能请求 API Key、密码哈希、OAuth refresh token、完整简历或 Gmail 正文。 |
| API 集成 | 每个端点的 401/403/成功、写操作审计、幂等、CSRF、分页上限、错误码不泄密；广播的自审批拒绝、匿名预览、`Notification` 去重投递与取消。 |
| 租户隔离 | 用户 A 不能读取/更新/删除用户 B 的每类资源；嵌套资源 ID 猜测同样失败。 |
| RLS（启用后） | 用候选人 DB 角色进行跨 tenant 查询必须返回 0；管理员受限视图不返回禁读字段。 |
| E2E | Support、Ops、Billing、Security、Super Admin 五种会话的导航与 API 行为；前端篡改请求也不得越权。 |
| 安全回归 | OWASP access-control 测试、IDOR、CSRF、会话固定、权限变更后 token 失效、审计不可改。 |

### 12.2 发布验收（Definition of Done）

- [ ] 所有 `/admin` 页面与 `/api/admin/v1` 接口服务端强制授权，前端隐藏不是唯一控制。
- [ ] `plan` 与内部管理员资格没有任何授权耦合。
- [ ] 所有候选人表在应用层都有 userId 强制过滤；RLS 迁移计划与测试已批准。
- [ ] DTO、审计日志和错误响应均不含密码、token、API Key、完整简历/Gmail 内容。
- [ ] 任一管理员（含 `super_admin` 与 break-glass）均无法通过 API、导出、日志或数据库 repository 读取 API Key、密码哈希、OAuth refresh token、完整简历或邮件正文。
- [ ] 已审批的平台广播只能投递到现有 `Notification`，不读取候选人私密内容；发布者与审批者不同且投递可幂等恢复。
- [ ] 每个写操作有 `reason`、审计记录、幂等与 CSRF 防护；高风险操作满足二次确认/双人审批。
- [ ] 内部成员禁用或角色变更能在 5 分钟内使旧会话失效。
- [ ] Bull Board 默认不暴露；生产环境经过私网与独立认证保护。
- [ ] 权限矩阵、IDOR、RLS、管理员 E2E 和审计测试全部通过。
- [ ] 安全负责人完成威胁建模、渗透测试/代码审计和上线签字。

## 13. 分阶段实施计划

### Phase 0：安全基线（必须先完成）

1. 将 Bull Board 改为默认拒绝、私网绑定、受控访问；补运行手册。
2. 盘点现有 API 的 `userId` 过滤，修复发现的 IDOR；为关键资源加隔离测试。
3. 定义权限字典、角色矩阵、敏感数据 DTO 和审计事件规范。

### Phase 1：身份与只读后台

1. Prisma migration：`AdminRole`、`AdminMembership`、`AdminAuditLog`；seed 内置角色和首位 super admin（通过一次性受控脚本）。
2. 实现 `requireAdmin`、MFA gate、`AdminShell`、middleware 快速拦截与只读概览/用户/审计页面。
3. 为读敏感 PII 的动作实现掩码与理由审计。

### Phase 2：受控写操作与 Worker 集成

1. 用户暂停、订阅变更、投递重试/取消、ATS 管理与平台广播（写入用户 Notification）。
2. 实现签名的 Web-to-Worker 管理 API，替换公开 Bull Board 操作路径。
3. 加入幂等、二次确认、告警和 break-glass 流程。

### Phase 3：数据库纵深防御与合规

1. 分批 RLS migration、受限视图/函数和连接池事务策略。
2. 管理员导出流程、保留策略、GDPR DSAR 操作手册。
3. 独立安全审计、灾难恢复演练和权限季度复核。

## 14. 建议的首批 Issue 切分

| Issue | 范围 | 依赖 |
|---|---|---|
| A1 | Worker Bull Board 默认拒绝与私网访问 | 无 |
| A2 | 候选人 API tenant-isolation 审计与 IDOR 测试 | A1 可并行 |
| A3 | 管理员 Prisma 模型、migration、seed、权限字典 | A2 |
| A4 | 管理员认证授权模块、session 吊销、MFA gate、审计库 | A3 |
| A5 | `/admin` shell、只读 dashboard/users/audit 和 DTO | A4 |
| A6 | 用户/订阅/投递受控写操作 | A5 |
| A7 | Worker 管理 API 与队列页面 | A4、A6 |
| A8 | RLS 设计、迁移、性能与隔离回归 | A2、A5 |

每个 Issue 必须包含：权限前置条件、可访问字段清单、审计事件、失败模式、跨租户测试，以及不会触碰的敏感字段。任何新增管理员动作都先扩展本文件的权限字典和审计字典，再写路由。

## 15. 决策记录

1. **v1 tenant = User，而不是 Organization。** 当前数据模型按 `userId` 所有权设计，先保证候选人隔离；未来 B2B 才引入 `Organization`/`Membership`，届时 tenant key 迁移为 organizationId，管理员模型保持独立。
2. **RBAC 为主、短时 ABAC 为辅。** 日常操作用固定角色；“本人不能批准本人申请”“只能访问 assigned incident”等约束放在策略条件中，不用把业务逻辑塞进角色。
3. **审计失败即失败关闭。** 对写操作，若无法落审计事件，不执行数据库/队列副作用；避免出现不可追溯的管理员变更。
4. **管理员可管理平台，不默认可浏览求职内容。** 运营便利不能覆盖候选人隐私；确需例外时走原因、时间限制、审批和审计。
