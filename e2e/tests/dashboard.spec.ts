import { execFileSync } from "node:child_process";
import AxeBuilder from "@axe-core/playwright";
import { type BrowserContext, type Page, expect, test } from "@playwright/test";
import { env } from "../env.js";

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target).join(", ")})`)).toEqual([]);
}

async function addPasskeyAuthenticator(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

/** Signs up with a passkey through the demo app, which connects the first realm. */
async function memberWithRealm(context: BrowserContext, page: Page, name: string) {
  await addPasskeyAuthenticator(context, page);
  const email = `e2e-dash-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`;
  await page.goto("http://localhost:4001/login");
  await page.getByRole("link", { name: "Create an account" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Sign up with a passkey" }).click();
  await expect(page.getByText("Your perks")).toBeVisible();
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByTestId("greeting")).toBeVisible();
  return email;
}

test("every section of Your Kingdom renders and passes accessibility checks", async ({ page, context }) => {
  await memberWithRealm(context, page, "Ada Lovelace");
  await page.goto("http://localhost:4000/account");
  await expect(page.getByText("Welcome back, Ada.")).toBeVisible();
  for (const [link, heading] of [
    ["Realms", "Realms"],
    ["Treasury", "Treasury"],
    ["Masks", "Masks"],
    ["Watchtower", "Watchtower"],
    ["Keys", "Keys"],
  ]) {
    const nav = page.getByRole("navigation", { name: "Your Kingdom" });
    await nav.getByRole("link", { name: link, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(nav.getByRole("link", { name: link, exact: true })).toHaveAttribute("aria-current", "page");
    await expectAccessible(page);
  }
});

test("the demo app's perks claim reflects the Treasury", async ({ page, context }) => {
  await memberWithRealm(context, page, "Grace Hopper");
  // Connecting the demo unlocks its "connected" perk, which the demo then receives.
  await expect(page.getByTestId("userinfo")).toContainText('"id": "demo.explorer"');
  await page.goto("http://localhost:4000/account/treasury");
  await expect(page.getByRole("heading", { name: "Explorer" })).toBeVisible();
  await expect(page.getByText("Within reach")).toBeVisible();
});

test("disconnecting a realm ends the app's access", async ({ page, context }) => {
  await memberWithRealm(context, page, "Katherine Johnson");
  await page.goto("http://localhost:4000/account");
  await page.getByRole("button", { name: "Disconnect Kingdom Demo" }).click();
  await expect(page.getByRole("status")).toContainText("Disconnected Kingdom Demo");
  await expect(page.getByText("No realms yet")).toBeVisible();

  await page.getByRole("navigation", { name: "Your Kingdom" }).getByRole("link", { name: "Watchtower", exact: true }).click();
  await expect(page.getByText("Disconnected Kingdom Demo")).toBeVisible();

  // Signing in to the demo again asks for consent again.
  await page.goto("http://localhost:4001/login");
  await expect(page.getByRole("heading", { name: "Continue to Kingdom Demo?" })).toBeVisible();
});

test("an admin signed in with a passkey manages perks", async ({ page, context }) => {
  const email = await memberWithRealm(context, page, "Mary Jackson");
  execFileSync("pnpm", ["--filter", "@kingdom-id/idp", "make-admin", email], { cwd: "..", env: { ...process.env, ...env }, stdio: "ignore" });

  await page.goto("http://localhost:4000/account");
  await page.getByRole("link", { name: "Admin" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Perks" })).toBeVisible();
  await expectAccessible(page);

  const slug = `e2e.vip-${Date.now()}`;
  await page.getByLabel("Perk ID").fill(slug);
  await page.getByLabel("Name").fill("Front row");
  await page.getByLabel("What it gives").fill("A seat up front.");
  await page.getByLabel("Unlocks when").selectOption("manual");
  await page.getByRole("button", { name: "Create perk" }).click();
  await expect(page.getByRole("status")).toContainText("Created Front row");

  await page.getByLabel("Grant Front row to").fill(email);
  await page.getByRole("button", { name: "Grant" }).last().click();
  await expect(page.getByRole("status")).toContainText(`Granted to ${email}`);

  await page.goto("http://localhost:4000/account/treasury");
  await expect(page.getByRole("heading", { name: "Front row" })).toBeVisible();
});

test.describe("dashboard on a phone, light mode", () => {
  test.use({ viewport: { width: 390, height: 844 }, colorScheme: "light" });
  test("fits the screen and stays accessible", async ({ page, context }) => {
    await memberWithRealm(context, page, "Dorothy Vaughan");
    for (const path of ["/account", "/account/treasury", "/account/watchtower", "/account/keys"]) {
      await page.goto(`http://localhost:4000${path}`);
      await expectAccessible(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    }
  });
});

test("private addresses can be paused, resumed and deleted from Masks", async ({ page, context }) => {
  await memberWithRealm(context, page, "Annie Easley");
  const address = (await page.getByTestId("userinfo").textContent())!.match(/[a-z]+-[a-z]+\.[a-z2-9]{6}@relay\.localhost/)![0];

  await page.goto("http://localhost:4000/account/masks");
  await expect(page.getByText(address)).toBeVisible();
  await expect(page.getByText("Verify your email to start receiving mail")).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("button", { name: "Pause forwarding for Kingdom Demo" }).click();
  await expect(page.getByRole("status")).toContainText(`Paused ${address}`);
  await page.getByRole("button", { name: "Resume forwarding for Kingdom Demo" }).click();
  await expect(page.getByRole("status")).toContainText(`Resumed ${address}`);
  await page.getByRole("button", { name: "Delete Kingdom Demo's address" }).click();
  await expect(page.getByRole("status")).toContainText(`Deleted ${address}`);
  await expect(page.getByText("No private addresses yet")).toBeVisible();
});
