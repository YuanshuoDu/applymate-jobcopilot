import { expect, test } from "./fixtures";

test("unknown item types remain forward-compatible and harmless", async ({ harness, page }) => {
  await harness.open();
  await page.getByRole("button", { name: harness.text("unknownTypes") }).click();
  await expect(page.getByTestId("stream-status")).toHaveText(harness.text("unknownTypesIgnored"));
  await expect(page.getByTestId("last-event-id")).toHaveText("last-event-id: event-1");
  await expect(page.locator("[data-testid=timeline] article")).toHaveCount(0);
  await page.getByLabel(harness.text("composer")).fill("Continue after an unknown item");
  await page.getByRole("button", { name: harness.text("send") }).click();
  await expect(page.locator('[data-speaker="user"]')).toHaveCount(1);
});
