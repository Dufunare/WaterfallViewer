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

  test("filters, sorts, selects and previews media", async ({ page }) => {
    await page.getByRole("button", { name: "Open folder" }).first().click();
    await expect(page.getByText("Ready", { exact: true })).toBeVisible();

    const filterGroup = page.getByRole("group", { name: "Media filter" });

    await filterGroup.getByRole("button", { name: "Video" }).click();
    await expect(page.getByText("1 / 6 media", { exact: true })).toBeVisible();
    await expect(page.getByTitle(/video\/Orbit\.mp4/)).toBeVisible();

    await filterGroup.getByRole("button", { name: "Audio" }).click();
    await expect(page.getByText("1 / 6 media", { exact: true })).toBeVisible();
    await expect(page.getByTitle(/audio\/Rainfall\.flac/)).toBeVisible();

    await filterGroup.getByRole("button", { name: "All" }).click();
    await expect(page.getByText("6 media", { exact: true })).toBeVisible();

    await page.getByLabel("Sort media").selectOption("name-desc");
    const firstTile = page.getByRole("region", { name: "Flow media browser" }).locator("figure").first();
    await expect(firstTile).toHaveAttribute("title", /audio\/Rainfall\.flac/);

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

    await filterGroup.getByRole("button", { name: "Video" }).click();
    await page.getByTitle(/video\/Orbit\.mp4/).dblclick();
    const videoDialog = page.getByRole("dialog", { name: "Preview Orbit.mp4" });
    await expect(videoDialog).toContainText("1:32");
    await expect(videoDialog).toContainText("H.264");
    await page.getByRole("button", { name: "Close preview" }).click();

    await filterGroup.getByRole("button", { name: "Audio" }).click();
    await page.getByTitle(/audio\/Rainfall\.flac/).dblclick();
    const audioDialog = page.getByRole("dialog", { name: "Preview Rainfall.flac" });
    await expect(audioDialog).toContainText("3:34");
    await expect(audioDialog).toContainText("FLAC");
    await expect(audioDialog).toContainText("WaterfallViewer Fixture");
  });
});
