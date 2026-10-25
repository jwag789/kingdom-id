import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

/** The button builder (/brand) and the official button it hands out. */
async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target).join(", ")})`)).toEqual([]);
}

for (const colorScheme of ["dark", "light"] as const) {
  test(`the button builder is accessible in ${colorScheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto("http://localhost:4000/brand");
    await expect(page.getByRole("heading", { name: "Sign in with Kingdom" })).toBeVisible();
    await expectAccessible(page);
  });
}

test("picking an option updates the preview and code in place", async ({ page }) => {
  await page.goto("http://localhost:4000/brand");
  await expect(page.getByRole("button", { name: "Update preview" })).toBeHidden();
  await page.getByRole("radio", { name: /^Light/ }).check();
  await page.getByRole("radio", { name: /^Continue with Kingdom/ }).check();
  await expect(page).toHaveURL(/look=light.*label=continue/);
  await expect(page.locator("#snippet-html")).toHaveText(
    '<button type="submit" class="kingdom-button kingdom-button--light">Continue with Kingdom</button>',
  );
  await expect(page.locator("[data-builder-result] .preview-light .kingdom-button")).toHaveClass("kingdom-button kingdom-button--light");
  await expect(page.getByRole("radio", { name: /^Continue with Kingdom/ })).toBeFocused();
});

test("the builder fits a phone without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto("http://localhost:4000/brand?look=light&size=lg&shape=square&label=icon");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});

test("Cappuccino's button loads from Kingdom ID and draws the Kingdom mark", async ({ page }) => {
  await page.goto("http://localhost:4002/");
  const button = page.getByRole("button", { name: "Sign in with Kingdom" });
  await expect(button).toHaveCSS("background-color", "rgb(10, 15, 36)");
  await expect(button).toHaveCSS("min-height", "44px");
  const mark = await button.evaluate((el) => {
    const style = getComputedStyle(el, "::before");
    return { mask: style.maskImage || style.webkitMaskImage, width: parseFloat(style.width) };
  });
  expect(mark.mask).toContain("data:image/svg+xml");
  expect(mark.width).toBeGreaterThan(20);
  await expectAccessible(page);
});
