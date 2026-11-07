import { expect, test } from "@playwright/test";

test.describe("desktop viewer main flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/e2e.html");
    await expect(page.locator("html")).toHaveAttribute("data-waterfall-fixture", "seeded");
  });

  test("opens the seeded source and switches viewer modes", async ({ page }) => {
    await page.getByRole("button", { name: "Open folder" }).first().click();

    await expect(page.getByText("Seeded Browser Gallery")).toBeVisible();
    await expect(page.getByText("Ready", { exact: true })).toBeVisible();
    await expect(page.getByText("6 media", { exact: true })).toBeVisible();

    const modeGroup = page.getByRole("group", { name: "Viewer mode" });
    await expect(modeGroup.getByRole("button", { name: "Columns" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await modeGroup.getByRole("button", { name: "Rows" }).click();
    await expect(modeGroup.getByRole("button", { name: "Rows" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await modeGroup.getByRole("button", { name: "Canvas" }).click();
    await expect(page.getByRole("region", { name: "Free canvas media browser" })).toBeVisible();

    await modeGroup.getByRole("button", { name: "Columns" }).click();
    await expect(page.getByRole("region", { name: "Flow media browser" })).toBeVisible();
  });

  test("filters, sorts, selects and previews image media in legacy Flow", async ({ page }) => {
    await page.getByRole("button", { name: "Open folder" }).first().click();
    await expect(page.getByText("Ready", { exact: true })).toBeVisible();

    const filterGroup = page.getByRole("group", { name: "Media filter" });
    const flow = page.getByRole("region", { name: "Flow media browser" });

    // Query state still knows about multimedia, but this experimental Flow is
    // intentionally image-only to match the supplied legacy implementation.
    await filterGroup.getByRole("button", { name: "Video" }).click();
    await expect(page.getByText("1 / 6 media", { exact: true })).toBeVisible();
    await expect(flow.locator("figure")).toHaveCount(0);

    await filterGroup.getByRole("button", { name: "Audio" }).click();
    await expect(page.getByText("1 / 6 media", { exact: true })).toBeVisible();
    await expect(flow.locator("figure")).toHaveCount(0);

    await filterGroup.getByRole("button", { name: "Images" }).click();
    await expect(page.getByText("4 / 6 media", { exact: true })).toBeVisible();
    await expect(flow.locator("figure")).toHaveCount(4);

    await page.getByLabel("Sort media").selectOption("name-desc");
    const firstTile = flow.locator("figure").first();
    await expect(firstTile).toHaveAttribute("title", /images\/Harbor\.jpg/);

    await page.getByLabel("Sort media").selectOption("source");

    const aurora = page.getByAltText("Aurora.jpg");
    await aurora.click();
    await expect(aurora.locator("..")) .toHaveClass(/selected/);

    await aurora.dblclick();
    const imageDialog = page.getByRole("dialog", { name: "Preview Aurora.jpg" });
    await expect(imageDialog).toBeVisible();

    await page.getByRole("button", { name: "Next media" }).click();
    await expect(page.getByRole("dialog", { name: "Preview Canyon.jpg" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
