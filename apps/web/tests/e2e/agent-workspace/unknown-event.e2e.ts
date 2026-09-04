import { expect, test } from "./fixtures";

test("unknown events are ignored without breaking the stream", async ({ harness, page }) => {
  await harness.open();
  await page.getByRole("button", { name: harness.text("unknownEvent") }).click();
  await expect(page.getByTestId("stream-status")).toHaveText(harness.text("unknownEventIgnored"));
  await expect(page.getByTestId("last-event-id")).toHaveText("last-event-id: event-1");
  await expect(page.getByTestId("external-write-count")).toHaveText(harness.text("noExternalWrites"));
  await expect(page.locator("[data-testid=timeline] article")).toHaveCount(0);
});
