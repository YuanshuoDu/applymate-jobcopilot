import { expect, test } from "./fixtures";

test("steer sends a typed user instruction into the active turn", async ({ harness, page }) => {
  await harness.open();
  await page.getByLabel(harness.text("composer")).fill("Find backend roles in Berlin");
  await page.getByRole("button", { name: harness.text("send") }).click();
  await expect(page.getByTestId("stream-status")).toHaveText(harness.text("working"));
  await expect(page.locator('[data-speaker="user"]')).toContainText("Find backend roles in Berlin");
  await expect(page.getByTestId("external-write-count")).toHaveText(harness.text("noExternalWrites"));
});
