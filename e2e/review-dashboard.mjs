// Ad-hoc design review of Your Kingdom and the admin panel. Not part of the
// test suite. Usage: node review-dashboard.mjs <out-dir>
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";

const out = process.argv[2];
const email = `review-dash-${Date.now()}@example.test`;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});

// A failed attempt first, so Watchtower has an alert to show.
await page.goto("http://localhost:4000/login");
await page.getByText("Use email and password instead").click();
await page.getByLabel("Email").fill(email);
await page.getByLabel("Password").fill("not the password");
await page.getByRole("button", { name: "Sign in", exact: true }).click();

await page.goto("http://localhost:4001/login");
await page.getByRole("link", { name: "Create an account" }).click();
await page.getByLabel("Name").fill("Ada Lovelace");
await page.getByLabel("Email").fill(email);
await page.getByRole("button", { name: "Sign up with a passkey" }).click();
await page.getByRole("button", { name: "Allow" }).click();
await page.waitForURL("http://localhost:4001/");

execFileSync("pnpm", ["--filter", "@kingdom-id/idp", "kingdom", "users", "admin", email], { cwd: "..", stdio: "ignore" });

for (const [name, path] of [["realms", "/account"], ["treasury", "/account/treasury"], ["masks", "/account/masks"], ["watchtower", "/account/watchtower"], ["keys", "/account/keys"], ["admin", "/admin"]]) {
  await page.goto(`http://localhost:4000${path}`);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${out}/dash-dark-desktop-${name}.png`, fullPage: true });
}
await page.emulateMedia({ colorScheme: "light" });
await page.setViewportSize({ width: 390, height: 844 });
for (const [name, path] of [["realms", "/account"], ["treasury", "/account/treasury"], ["watchtower", "/account/watchtower"]]) {
  await page.goto(`http://localhost:4000${path}`);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${out}/dash-light-phone-${name}.png`, fullPage: true });
}
await browser.close();
