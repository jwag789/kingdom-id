import { type BrowserContext, type Page, expect, test } from "@playwright/test";

/**
 * The Next.js integration guide's example app, end to end: Sign in with
 * Kingdom through Auth.js, profile from UserInfo, the private relay address,
 * perks that carry across Kingdom apps, and signing out of Kingdom too.
 */
async function addPasskeyAuthenticator(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

test("Cappuccino signs in with Kingdom and receives a private email and cross-app perks", async ({ page, context }) => {
  await addPasskeyAuthenticator(context, page);
  const email = `e2e-cappuccino-${Date.now()}@example.test`;

  // First Kingdom app: the demo. Connecting it unlocks its "Explorer" perk.
  await page.goto("http://localhost:4001/login");
  await page.getByRole("link", { name: "Create an account" }).click();
  await page.getByLabel("Name").fill("Ada Lovelace");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Sign up with a passkey" }).click();
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByTestId("greeting")).toBeVisible();

  // Second Kingdom app: Cappuccino. Already signed in to Kingdom, so only consent.
  await page.goto("http://localhost:4002/");
  await page.getByRole("button", { name: "Sign in with Kingdom" }).click();
  await expect(page.getByRole("heading", { name: "Continue to Cappuccino?" })).toBeVisible();
  await expect(page.getByText("Your perks")).toBeVisible();
  await page.getByRole("button", { name: "Allow" }).click();

  await expect(page.getByTestId("greeting")).toHaveText("Welcome back, Ada Lovelace");
  const shared = await page.getByTestId("email").textContent();
  expect(shared).toMatch(/^[a-z]+-[a-z]+\.[a-z2-9]{6}@relay\.localhost$/);
  expect(shared).not.toBe(email);
  // A perk unlocked in the demo app shows up in Cappuccino, plus the two-app perk.
  await expect(page.getByTestId("perks")).toContainText("Explorer");
  await expect(page.getByTestId("perks")).toContainText("Two realms");

  // Sign out of Cappuccino only: Kingdom remembers, so signing back in skips every screen.
  await page.getByRole("button", { name: "Sign out of Cappuccino" }).click();
  await page.getByRole("button", { name: "Sign in with Kingdom" }).click();
  await expect(page.getByTestId("greeting")).toHaveText("Welcome back, Ada Lovelace");

  // Sign out of Kingdom too: RP-initiated logout, straight back to Cappuccino.
  await page.getByRole("button", { name: "Sign out of Kingdom too" }).click();
  await expect(page).toHaveURL("http://localhost:4002/");
  await expect(page.getByRole("button", { name: "Sign in with Kingdom" })).toBeVisible();
  const session = await page.request.get("http://localhost:4000/account", { maxRedirects: 0 });
  expect(session.status()).toBe(303); // the Kingdom session is gone too
});

/** Signs a fresh member into Cappuccino directly, and returns once they're in. */
async function signInToCappuccino(page: Page, context: BrowserContext, name: string) {
  await addPasskeyAuthenticator(context, page);
  await page.goto("http://localhost:4002/");
  await page.getByRole("button", { name: "Sign in with Kingdom" }).click();
  await page.getByRole("link", { name: "Create an account" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(`e2e-bcl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`);
  await page.getByRole("button", { name: "Sign up with a passkey" }).click();
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByTestId("greeting")).toHaveText(`Welcome back, ${name}`);
}

/** Logout notices are delivered asynchronously; reload until Cappuccino shows it. */
async function expectSignedOutOfCappuccino(page: Page) {
  await expect(async () => {
    await page.goto("http://localhost:4002/");
    await expect(page.getByRole("button", { name: "Sign in with Kingdom" })).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 15_000 });
}

test("disconnecting Cappuccino in Your Kingdom signs the member out of Cappuccino (back-channel logout)", async ({ page, context }) => {
  await signInToCappuccino(page, context, "Hedy Lamarr");
  await page.goto("http://localhost:4000/account");
  await page.getByRole("button", { name: "Disconnect Cappuccino" }).click();
  await expect(page.getByRole("status")).toContainText("Disconnected Cappuccino");
  await expectSignedOutOfCappuccino(page);
});

test("signing out of Kingdom signs the member out of Cappuccino too", async ({ page, context }) => {
  await signInToCappuccino(page, context, "Radia Perlman");
  await page.goto("http://localhost:4000/account");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expectSignedOutOfCappuccino(page);
});
