import { expect, test } from "./fixtures";

test("multi-turn transcript persists when the session is restored", async ({ harness, page }) => {
  await harness.open();
  const composer = page.getByLabel(harness.text("composer"));
  await composer.fill("Find platform engineering jobs");
  await page.getByRole("button", { name: harness.text("send") }).click();
  await page.getByRole("button", { name: harness.text("complete") }).click();
  await composer.fill("Now prefer Dublin or remote roles");
  await page.getByRole("button", { name: harness.text("send") }).click();
  // Remount the scripted stream document while retaining browser-session
  // state, as a restored Session does when the user returns to the workspace.
  await harness.open();
  await expect(page.getByTestId("turn-count")).toHaveText("turns: 2");
  await expect(page.getByText("Find platform engineering jobs", { exact: true })).toBeVisible();
  await expect(page.getByText("Now prefer Dublin or remote roles", { exact: true })).toBeVisible();
});
