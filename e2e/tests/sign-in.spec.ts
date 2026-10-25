import AxeBuilder from "@axe-core/playwright";
import { type BrowserContext, type Page, expect, test } from "@playwright/test";

const password = "correct horse battery staple";

/** WCAG 2.x A/AA checks on whatever Kingdom ID page is showing. */
async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target).join(", ")})`)).toEqual([]);
}

/**
 * Gives the browser a platform authenticator (Chromium's virtual
 * authenticator via CDP) that holds discoverable credentials and passes user
 * verification, like Touch ID or Windows Hello.
 */
async function addPasskeyAuthenticator(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

async function signUpWithPassword(page: Page, name: string, email: string) {
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByText("Use a password instead").click();
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
}

test("a new user signs up with a passkey, then signs back in with it", async ({ page, context }) => {
  await addPasskeyAuthenticator(context, page);
  const email = `e2e-passkey-${Date.now()}@example.test`;

  await page.goto("http://localhost:4001/");
  await page.getByRole("link", { name: "Sign in with Kingdom" }).click();

  // On Kingdom ID, co-branded with the requesting app, passkey first.
  await expect(page).toHaveURL(/localhost:4000\/interaction\//);
  await expect(page.getByRole("heading", { name: "Sign in to Kingdom Demo" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with a passkey" })).toBeVisible();
  await expect(page.getByLabel("Password")).toBeHidden();
  await expectAccessible(page);

  await page.getByRole("link", { name: "Create an account" }).click();
  await expectAccessible(page);
  await page.getByLabel("Name").fill("Ada Lovelace");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Sign up with a passkey" }).click();

  await expect(page.getByRole("heading", { name: "Continue to Kingdom Demo?" })).toBeVisible();
  await expect(page.getByText("Your email address")).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Allow" }).click();

  // Back on the demo app, which verified everything with openid-client.
  await expect(page).toHaveURL("http://localhost:4001/");
  await expect(page.getByTestId("greeting")).toHaveText("Signed in as Ada Lovelace");
  await expect(page.getByTestId("id-token")).toContainText('"acr": "phr"');
  await expect(page.getByTestId("userinfo")).toContainText(email);

  // Sign out of Kingdom entirely, then back in with nothing but the passkey.
  // The login page offers the passkey through autofill (conditional
  // mediation); Chromium's virtual authenticator accepts that offer itself,
  // as a user would by picking the passkey, so no button press is needed.
  await page.getByRole("link", { name: "Sign out of Kingdom too" }).click();
  await page.getByRole("link", { name: "Sign in with Kingdom" }).click();
  await expect(page.getByTestId("greeting")).toHaveText("Signed in as Ada Lovelace");
  await expect(page.getByTestId("id-token")).toContainText('"acr": "phr"');
});

test("a password account adds a passkey from the account page", async ({ page, context }) => {
  await addPasskeyAuthenticator(context, page);
  await page.goto("http://localhost:4000/signup");
  await signUpWithPassword(page, "Grace Hopper", `e2e-add-${Date.now()}@example.test`);
  await expect(page.getByText("Welcome back, Grace.")).toBeVisible();
  await page.getByRole("link", { name: "Keys" }).click();
  await expect(page.getByText("You sign in with a password.")).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByRole("status")).toContainText("Passkey added");
  await expect(page.getByRole("button", { name: /^Remove / })).toBeVisible();
  await expectAccessible(page);
});

test("an existing user signs in with a password", async ({ page, browser }) => {
  const email = `e2e-login-${Date.now()}@example.test`;
  const setup = await browser.newPage();
  await setup.goto("http://localhost:4000/signup");
  await signUpWithPassword(setup, "Grace Hopper", email);
  await expect(setup.getByText("Welcome back, Grace.")).toBeVisible();
  await setup.close();

  await page.goto("http://localhost:4001/login");
  await page.getByText("Use email and password instead").click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("wrong password!!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert").first()).toContainText("match a Kingdom account");

  // After a password error the email form stays open.
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByTestId("greeting")).toHaveText("Signed in as Grace Hopper");
  await expect(page.getByTestId("id-token")).toContainText("urn:kingdom-id:acr:password");
});

test("signing out of Kingdom from the demo ends the Kingdom session", async ({ page }) => {
  await page.goto("http://localhost:4001/login");
  await page.getByRole("link", { name: "Create an account" }).click();
  await signUpWithPassword(page, "Katherine Johnson", `e2e-logout-${Date.now()}@example.test`);
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByTestId("greeting")).toHaveText("Signed in as Katherine Johnson");

  // The demo's id_token_hint proves the session, so there's no confirmation step.
  await page.getByRole("link", { name: "Sign out of Kingdom too" }).click();
  await expect(page).toHaveURL("http://localhost:4001/");
  await page.getByRole("link", { name: "Sign in with Kingdom" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Kingdom Demo" })).toBeVisible();
});

test.describe("accessibility in light mode and on a phone", () => {
  for (const [label, options] of [
    ["light, desktop", { colorScheme: "light" as const, viewport: { width: 1280, height: 800 } }],
    ["dark, phone", { colorScheme: "dark" as const, viewport: { width: 390, height: 844 } }],
    ["light, phone", { colorScheme: "light" as const, viewport: { width: 390, height: 844 } }],
  ] as const) {
    test(label, async ({ browser }) => {
      const context = await browser.newContext(options);
      const page = await context.newPage();
      await page.goto("http://localhost:4001/login");
      await expectAccessible(page);
      await page.getByText("Use email and password instead").click();
      await expectAccessible(page);
      await page.getByRole("link", { name: "Create an account" }).click();
      await expectAccessible(page);
      await signUpWithPassword(page, "Mary Jackson", `e2e-a11y-${Date.now()}-${Math.random()}@example.test`);
      await expect(page.getByRole("heading", { name: "Continue to Kingdom Demo?" })).toBeVisible();
      await expectAccessible(page);
      // No horizontal scroll at phone width.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await context.close();
    });
  }
});

test("works without JavaScript: the password path is complete on its own", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("http://localhost:4000/signup");
  // No passkey button without the script; the password fields are already open.
  await expect(page.getByRole("button", { name: "Sign up with a passkey" })).toBeHidden();
  await page.getByLabel("Name").fill("Dorothy Vaughan");
  await page.getByLabel("Email").fill(`e2e-nojs-${Date.now()}@example.test`);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByText("Welcome back, Dorothy.")).toBeVisible();
  await context.close();
});

test("respects prefers-reduced-motion", async ({ browser }) => {
  for (const [reducedMotion, expected] of [["no-preference", "aurora-a"], ["reduce", "none"]] as const) {
    const context = await browser.newContext({ reducedMotion, viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto("http://localhost:4000/login");
    const animation = await page.$eval(".blob-a", (el) => getComputedStyle(el).animationName);
    expect(animation).toBe(expected);
    await context.close();
  }
});
