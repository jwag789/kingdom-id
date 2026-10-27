import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestApp, createTestApp } from "../helpers.js";

describe("client registration across hosts", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const both = ["https://cappuccino.example/api/auth/kingdom/callback", "https://www.cappuccino.example/api/auth/kingdom/callback"];

  it("lets a first-party app answer on its bare and www hosts, in the shared Kingdom sector", async () => {
    const { client } = await t.ctx.clients.create({ name: "Cappuccino", type: "confidential", firstParty: true, redirectUris: both });
    expect(client.redirectUris).toEqual(both);
    const other = await t.ctx.clients.create({
      name: "InkSpirit",
      type: "confidential",
      firstParty: true,
      redirectUris: ["https://inkspirit.example/cb"],
    });
    expect(client.sectorIdentifier).toBe(other.client.sectorIdentifier);
  });

  it("still refuses a third-party pairwise app on two hosts, whose sector would be ambiguous", async () => {
    await expect(t.ctx.clients.create({ name: "Third party", type: "confidential", redirectUris: both })).rejects.toThrow(/one host/);
  });
});
