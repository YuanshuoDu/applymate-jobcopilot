---
name: API 环境切换机制
description: 插件如何在本地开发(localhost)和生产(Vercel)之间自动切换 API 地址
type: project
---

## API 环境切换规则

**默认值**：`storage.ts` 中 `DEFAULTS.apiBaseUrl` = Vercel 生产 URL

**自动切换逻辑**（3 层）：

| 层级 | 文件 | 逻辑 |
|------|------|------|
| 后台 Worker | `background/index.ts` | `handleMessage()` 检测 `sender.url` 是否包含 `localhost`，若是则强制 `apiBaseUrl` = `http://localhost:3000` 并持久化到 storage |
| 内容脚本 | `content/list-injector.ts` | `fetchQuickScore()` 检测 `window.location.hostname` 是否包含 `localhost`，若是则强制使用 `http://localhost:3000` |
| 用户手动 | Popup Settings | ⚙ 设置页面可手动输入任意 API 地址 |

**切换流程**：
- localhost 页面 → 自动切换并持久化 → 下次打开 Popup 也使用 localhost
- 非 localhost 页面 → 使用 storage 中的 `apiBaseUrl`（默认 Vercel）
- 用户可在 Popup Settings 手动覆盖

**注意**：切换 API 地址后需要重新登录，因为不同 API 的 JWT 签名密钥（AUTH_SECRET）不同，token 不互通。

**Why**：本地开发时需要连接 localhost:3000，生产部署时需要连接 Vercel。自动检测避免每次手动切换。
**How to apply**：修改 API 相关逻辑时必须同时更新上述 3 层的判断条件。
