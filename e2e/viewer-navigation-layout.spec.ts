import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/e2e.html");
  await page.getByRole("button", { name: "Open folder" }).first().click();
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
});

test("wheel-adjustable track selector supports 1 to 32 columns", async ({ page }) => {
  const counter = page.getByRole("spinbutton", { name: "Track count" });
  const flow = page.getByRole("region", { name: "Flow media browser" });

  await expect(counter).toHaveAttribute("aria-valuenow", "4");
  await counter.hover();
  await page.mouse.wheel(0, -100);
  await expect(counter).toHaveAttribute("aria-valuenow", "5");
  await expect(flow.locator(".legacy-column")).toHaveCount(5);

  await counter.focus();
  await page.keyboard.press("End");
  await expect(counter).toHaveAttribute("aria-valuenow", "32");
  await expect(flow.locator(".legacy-column")).toHaveCount(32);

  await page.keyboard.press("Home");
  await expect(counter).toHaveAttribute("aria-valuenow", "1");
  await expect(flow.locator(".legacy-column")).toHaveCount(1);
});

test("rows use a horizontal scrollbar and vertical wheel moves horizontally", async ({ page }) => {
  await page.setViewportSize({ width: 680, height: 560 });
  await page.getByRole("group", { name: "Viewer mode" })
    .getByRole("button", { name: "Rows" }).click();

  const flow = page.getByRole("region", { name: "Flow media browser" });
  await expect(flow).toHaveClass(/horizontal/);

  const counter = page.getByRole("spinbutton", { name: "Track count" });
  await counter.focus();
  await page.keyboard.press("Home");
  await expect(flow.locator(".legacy-lane")).toHaveCount(1);
  await expect(flow.locator("figure")).toHaveCount(4);

  await expect.poll(async () =>
    flow.evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(true);
  const before = await flow.evaluate((element) => element.scrollLeft);
  await flow.hover();
  await page.mouse.wheel(0, 540);
  await expect.poll(async () =>
    flow.evaluate((element) => element.scrollLeft),
  ).toBeGreaterThan(before);
  await expect.poll(async () =>
    page.evaluate(() => document.documentElement.scrollTop),
  ).toBe(0);
});

test("free canvas pans, zooms and opens image preview", async ({ page }) => {
  await page.getByRole("group", { name: "Viewer mode" })
    .getByRole("button", { name: "Canvas" }).click();

  const canvas = page.getByRole("region", { name: "Free canvas media browser" });
  await expect(canvas).toBeVisible();
  await expect(canvas.locator(".canvas-media")).toHaveCount(4);

  const zoom = canvas.getByLabel("Canvas zoom");
  const originalZoom = await zoom.textContent();
  await canvas.hover({ position: { x: 220, y: 190 } });
  await page.mouse.wheel(0, -300);
  await expect.poll(async () => zoom.textContent()).not.toBe(originalZoom);

  const previousTransform = await canvas.locator(".canvas-world").getAttribute("style");
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("canvas bounds unavailable");

  await page.mouse.move(box.x + 300, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 350, box.y + 320, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () =>
    canvas.locator(".canvas-world").getAttribute("style"),
  ).not.toBe(previousTransform);

  await canvas.getByRole("button", { name: "Zoom out" }).click();
  await canvas.getByRole("button", { name: "Reset view" }).click();
  await canvas.locator(".canvas-media").first().dblclick();
  await expect(page.getByRole("dialog")).toBeVisible();
});
