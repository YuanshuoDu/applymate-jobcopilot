# ApplyMate AI — Chrome Extension 安装指南

## 开发模式构建

```bash
cd apps/extension
pnpm install
pnpm dev          # watch 模式，文件变化自动重新构建
# 或
pnpm build        # 一次性构建
```

构建产物在 `apps/extension/dist/`

---

## 加载到 Chrome

1. 打开 Chrome，地址栏输入 `chrome://extensions/`
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择 `apps/extension/dist/` 文件夹
5. 插件出现在扩展列表，图标出现在地址栏右侧

---

## 首次使用

1. 确保 Next.js 开发服务器正在运行（`pnpm dev`，默认 http://localhost:3000）
2. 点击 Chrome 工具栏上的 ApplyMate 图标
3. 输入你的账号（演示账号：`demo@applymate.ai` / `demo1234`）
4. 登录成功后即可在 LinkedIn/Indeed/Glassdoor 使用

---

## 使用方法

### 方式一：浮动按钮
在任意支持的职位页面，右下角会出现蓝色的 **"Save to ApplyMate"** 按钮，点击一键保存。

### 方式二：Popup 弹窗
点击扩展图标 → Popup 弹窗显示当前职位信息，可预览后保存。

### 方式三：侧边栏
Popup 内点击 **"打开侧边栏查看详情"** → 侧边栏展开，显示完整职位详情、状态追踪、备注。

---

## 支持的平台

| 平台 | 职位识别 | 一键保存 |
|---|---|---|
| LinkedIn | ✅ | ✅ |
| Indeed | ✅ | ✅ |
| Glassdoor | ✅ | ✅ |
| Wellfound | ✅ | ✅ |
| Greenhouse | ✅ | ✅ |
| Lever | ✅ | ✅ |
| Workday | ✅ | ✅ |

---

## 生产构建 & 打包

```bash
pnpm build
node scripts/zip.mjs    # 生成可上传到 Chrome Web Store 的 zip
```
