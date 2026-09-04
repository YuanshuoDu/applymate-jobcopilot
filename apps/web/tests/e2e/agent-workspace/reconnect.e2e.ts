import { expect, test } from "./fixtures";

test("reconnect replays the existing timeline from the last event", async ({ harness, page }) => {
  await harness.open();
  await page.getByLabel(harness.text("composer")).fill("Inspect my saved applications");
  await page.getByRole("button", { name: harness.text("send") }).click();
  const before = await page.getByTestId("last-event-id").innerText();
  await page.getByRole("button", { name: harness.text("reconnect") }).click();
  await expect(page.getByTestId("stream-status")).toHaveText(harness.text("reconnected"));
  await expect(page.getByTestId("last-event-id")).toHaveText(before);
  await expect(page.getByText(new RegExp(harness.text("replayed")))).toBeVisible();
  await expect(page.locator('[data-speaker="user"]')).toHaveCount(1);
});
