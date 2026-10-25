import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ISSUER, type TestApp, createTestApp } from "../helpers.js";

/** The text of a code snippet on the builder page, as a developer would copy it. */
function snippet(html: string, id: string): string {
  const code = html.match(new RegExp(`<code id="${id}">([^<]*)</code>`))![1]!;
  return code.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

describe("the button builder and brand assets", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("serves the button stylesheet and marks for other sites to load", async () => {
    for (const [path, type] of [
      ["/brand/button.css", "text/css"],
      ["/brand/kingdom-mark.svg", "image/svg+xml"],
      ["/brand/kingdom-mark-white.svg", "image/svg+xml"],
    ] as const) {
      const res = await t.app.inject({ method: "GET", url: path });
      expect(res.statusCode, path).toBe(200);
      expect(res.headers["content-type"]).toContain(type);
      expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    }
  });

  it("keeps every other response same-origin", async () => {
    for (const url of ["/brand", "/login", "/assets/app.css"]) {
      const res = await t.app.inject({ method: "GET", url });
      expect(res.headers["cross-origin-resource-policy"], url).toBe("same-origin");
      expect(res.headers["access-control-allow-origin"], url).toBeUndefined();
    }
  });

  it("renders the chosen button and its code, without a session", async () => {
    const res = await t.app.inject({ method: "GET", url: "/brand?look=blue&size=lg&shape=square&label=continue" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<link rel="stylesheet" href="/brand/button.css"/>');
    expect(snippet(res.body, "snippet-stylesheet")).toBe(`<link rel="stylesheet" href="${ISSUER}/brand/button.css">`);
    expect(snippet(res.body, "snippet-html")).toBe(
      '<button type="submit" class="kingdom-button kingdom-button--blue kingdom-button--lg kingdom-button--square">Continue with Kingdom</button>',
    );
    expect(res.body).toMatch(/<input type="radio" name="look" value="blue" checked/);
  });

  it("shows the default button for unknown choices", async () => {
    const res = await t.app.inject({ method: "GET", url: "/brand?look=%22%3E%3Cscript%3E&size=xl" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("<script>");
    expect(snippet(res.body, "snippet-html")).toBe('<button type="submit" class="kingdom-button">Sign in with Kingdom</button>');
  });
});
