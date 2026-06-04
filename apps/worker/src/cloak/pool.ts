import type { BrowserContext, Page } from "playwright-core";
import { ensureProfileDir, storageStatePath } from "./profiles.js";
import { getProxy } from "./proxy.js";

const MAX_WORKERS = Number(process.env.CLOAK_MAX_WORKERS ?? "1");

interface Slot {
  userId: string;
  context: BrowserContext;
  inUse: boolean;
}

const activeSlots = new Map<string, Slot>();

function activeCount(): number {
  let count = 0;
  for (const s of activeSlots.values()) {
    if (s.inUse) count++;
  }
  return count;
}

async function launchContext(
  userId: string,
  headless: boolean
): Promise<BrowserContext> {
  const { launchPersistentContext } = await import("cloakbrowser");
  const profileDir = ensureProfileDir(userId);
  const statePath = storageStatePath(userId);
  const proxy = getProxy(userId);

  const context = await launchPersistentContext({
    headless,
    humanize: true,
    userDataDir: profileDir,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    ...(proxy ? { proxy: { server: proxy } } : {}),
  });

  // Restore previous storage state if available
  try {
    const { readFileSync, existsSync } = await import("node:fs");
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      if (state.cookies?.length) {
        await context.addCookies(state.cookies);
      }
    }
  } catch {
    // Best-effort restore
  }

  return context;
}

/**
 * Acquire a CloakBrowser page context for a user.
 * On first use, launches a persistent browser context with the user's profile.
 * On subsequent use for the same user, reuses the existing connected context.
 *
 * The callback receives a Playwright-compatible `Page`.
 * After the callback finishes, the page is closed, storage state is persisted,
 * and the slot is released.
 */
export async function withCloakContext<T>(
  userId: string,
  fn: (page: Page) => Promise<T>
): Promise<T> {
  const headless = process.env.CLOAK_HEADED !== "1";

  let slot = activeSlots.get(userId);

  if (!slot || !slot.context.browser()?.isConnected()) {
    // Need a new slot — check capacity
    if (!slot && activeCount() >= MAX_WORKERS) {
      throw new Error(
        `CloakBrowser pool exhausted: ${activeCount()}/${MAX_WORKERS} slots in use. Retry later.`
      );
    }

    const context = await launchContext(userId, headless);
    slot = { userId, context, inUse: true };
    activeSlots.set(userId, slot);
  } else {
    slot.inUse = true;
  }

  const page = await slot.context.newPage();
  try {
    const result = await fn(page);
    return result;
  } finally {
    await page.close().catch(() => {});
    // Persist storage state
    try {
      const state = await slot.context.storageState();
      const { writeFileSync, mkdirSync, existsSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      const sp = storageStatePath(userId);
      const dir = dirname(sp);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(sp, JSON.stringify(state, null, 2), "utf-8");
    } catch {
      // Best-effort persistence
    }
    slot.inUse = false;
  }
}

/**
 * Close all active browser slots. Call on worker shutdown.
 */
export async function closeAllSlots(): Promise<void> {
  for (const [, slot] of activeSlots) {
    try {
      await slot.context.close().catch(() => {});
    } catch {
      // Best-effort cleanup
    }
  }
  activeSlots.clear();
}
