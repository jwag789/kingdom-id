import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const password = "correct horse battery staple";

/** WCAG 2.x A/AA checks on whatever Kingdom ID page is showing. */
async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test("a new user signs up through the demo app and comes back signed in", async ({ page }) => {
  const email = `e2e-${Date.now()}@example.test`;

  await page.goto("http://localhost:4001/");
  await page.getByRole("link", { name: "Sign in with Kingdom" }).click();

  // On Kingdom ID, co-branded with the requesting app.
  await expect(page).toHaveURL(/localhost:4000\/interaction\//);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByText("to continue to Kingdom Demo")).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("link", { name: "Create an account" }).click();
  await expectAccessible(page);
  await page.getByLabel("Name").fill("Ada Lovelace");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByRole("heading", { name: "Continue to Kingdom Demo?" })).toBeVisible();
  await expect(page.getByText("Your email address")).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Allow" }).click();

  // Back on the demo app, which verified everything with openid-client.
  await expect(page).toHaveURL("http://localhost:4001/");
  await expect(page.getByTestId("greeting")).toHaveText("Signed in as Ada Lovelace");
  await expect(page.getByTestId("id-token")).toContainText(email);
  await expect(page.getByTestId("userinfo")).toContainText('"email_verified": false');

  // Signing in to the demo again rides the Kingdom session and stored consent: no screens.
  await page.getByRole("link", { name: "Sign out of the demo" }).click();
  await page.getByRole("link", { name: "Sign in with Kingdom" }).click();
  await expect(page.getByTestId("greeting")).toHaveText("Signed in as Ada Lovelace");
});

test("an existing user signs in with a password", async ({ page, browser }) => {
  const email = `e2e-login-${Date.now()}@example.test`;
  // Create the account in a separate browser context.
  const setup = await browser.newPage();
  await setup.goto("http://localhost:4000/signup");
  await setup.getByLabel("Name").fill("Grace Hopper");
  await setup.getByLabel("Email").fill(email);
  await setup.getByLabel("Password").fill(password);
  await setup.getByRole("button", { name: "Create account" }).click();
  await expect(setup.getByRole("heading", { name: "Hi, Grace Hopper" })).toBeVisible();
  await setup.close();

  await page.goto("http://localhost:4001/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("wrong password!!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("match a Kingdom account");

  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByTestId("greeting")).toHaveText("Signed in as Grace Hopper");
});

test("light mode passes the same accessibility checks", async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: "light" });
  const page = await context.newPage();
  await page.goto("http://localhost:4000/login");
  await expectAccessible(page);
  await page.goto("http://localhost:4000/signup");
  await expectAccessible(page);
  await context.close();
});
