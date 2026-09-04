import { expect, test as base } from "@playwright/test";
import { copy, openScriptedHarness, readHarnessDiagnostics, readHarnessState, type HarnessLocale } from "./fixtures/scripted-harness";

type Harness = {
  locale: HarnessLocale;
  text: (key: string) => string;
  open: () => Promise<void>;
};

type Fixtures = { harness: Harness };

function projectLocale(projectName: string): HarnessLocale {
  return projectName.endsWith("-zh") ? "zh" : "en";
}

export const test = base.extend<Fixtures>({
  harness: async ({ page }, use, testInfo) => {
    const locale = projectLocale(testInfo.project.name);
    await use({
      locale,
      text: key => copy[locale][key] ?? key,
      open: async () => {
        const restoredState = await readHarnessState(page).catch(() => undefined);
        await openScriptedHarness(page, locale, restoredState);
      },
    });
  },
});

test.afterEach(async ({ page }, testInfo) => {
  const diagnostics = await readHarnessDiagnostics(page).catch(() => `page.url=${page.url()}`);
  await testInfo.attach("harness-diagnostics", {
    body: Buffer.from(JSON.stringify({ url: page.url(), diagnostics }, null, 2)),
    contentType: "application/json",
  });
  if (testInfo.project.name.endsWith("-zh")) {
    await expect(page.locator("body")).not.toContainText("Agent workspace");
    await expect(page.locator("body")).not.toContainText("Send message");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh");
  } else {
    await expect(page.locator("body")).not.toContainText("发送消息");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  }
});

export { expect };
