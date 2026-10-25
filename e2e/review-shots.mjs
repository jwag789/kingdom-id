// Ad-hoc design review: captures the sign-in screens at desktop and phone
// widths in both color schemes. Not part of the test suite.
import { chromium } from "@playwright/test";

const out = process.argv[2];
const browser = await chromium.launch();
for (const scheme of ["dark", "light"]) {
  for (const [label, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const shot = (name) => page.screenshot({ path: `${out}/${scheme}-${label}-${name}.png`, fullPage: label === "phone" });
    await page.goto("http://localhost:4001/login");
    await page.waitForLoadState("networkidle");
    await shot("login");
    await page.getByText("Use email and password instead").click();
    await shot("login-email");
    await page.getByRole("link", { name: "Create an account" }).click();
    await page.waitForLoadState("networkidle");
    await shot("signup");
    await page.getByLabel("Name").fill("Ada Lovelace");
    await page.getByLabel("Email").fill(`review-${scheme}-${label}-${Date.now()}@example.test`);
    await page.getByText("Use a password instead").click();
    await page.getByLabel("Password").fill("correct horse battery staple");
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await page.waitForLoadState("networkidle");
    await shot("consent");
    await context.close();
  }
}
await browser.close();
