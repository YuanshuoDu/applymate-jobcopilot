# ApplyMate AI — Chrome Extension Installation guide

## Development mode build

```bash
cd apps/extension
pnpm install
pnpm dev          # watch model，Automatically rebuild on file changes
# or
pnpm build        # Build once
```

The build product is in `apps/extension/dist/`

---

## load to Chrome

1. Open Chrome，Address bar input `chrome://extensions/`
2. Open in the upper right corner **Developer mode**
3. Click **Load unpacked extension**
4. choose `apps/extension/dist/` folder
5. The plugin appears in the extensions list，The icon appears on the right side of the address bar

---

## First time use

1. make sure Next.js Development server is running（`pnpm dev`，default http://localhost:3000）
2. Click Chrome on the toolbar ApplyMate icon
3. use your own ApplyMate Account login
4. After successful login, you can LinkedIn/Indeed/Glassdoor use

---

## How to use

### Method one：floating button
On any supported job page，A blue one will appear in the lower right corner **"Save to ApplyMate"** button，One click to save。

### Method 2：Popup Pop-up window
Click on the extension icon → Popup Pop-up window displays current job information，Can be previewed and saved。

### Method three：sidebar
Popup click within **"Open the sidebar to view details"** → Expand sidebar，Show full job details、status tracking、Remark。

---

## Supported platforms

| platform | Job identification | Save with one click |
|---|---|---|
| LinkedIn | ✅ | ✅ |
| Indeed | ✅ | ✅ |
| Glassdoor | ✅ | ✅ |
| Wellfound | ✅ | ✅ |
| Greenhouse | ✅ | ✅ |
| Lever | ✅ | ✅ |
| Workday | ✅ | ✅ |

---

## Production build & Pack

```bash
pnpm build
pnpm zip                # generate release/ApplyMate-AI-<version>.zip
```
