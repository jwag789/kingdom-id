import { createServer } from "node:net";
import { connect, signingKeys, users } from "@kingdom-id/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../../src/cli/index.js";
import { Browser, type TestApp, createTestApp, freshDatabaseUrl, redeem, signUpAndAuthorize, testEnv } from "../helpers.js";

/** Runs the CLI in-process and captures what it prints. */
async function kingdom(args: string[], env: Record<string, string>, stdin = "") {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { out: (l) => out.push(l), err: (l) => err.push(l), stdin: async () => stdin }, env);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("kingdom CLI", () => {
  let env: Record<string, string>;
  beforeAll(async () => {
    env = testEnv({ DATABASE_URL: await freshDatabaseUrl() });
  });

  const dbRows = async <T>(fn: (db: ReturnType<typeof connect>["db"]) => Promise<T>) => {
    const handle = connect(env.DATABASE_URL!, { max: 1 });
    try {
      return await fn(handle.db);
    } finally {
      await handle.close();
    }
  };

  describe("clients", () => {
    it("creates a confidential client, shows the secret once, and lists it", async () => {
      const created = await kingdom(["clients", "create", "--name", "Cappuccino", "--redirect-uri", "https://cappuccino.example/callback", "--first-party", "--json"], env);
      expect(created.code).toBe(0);
      const json = JSON.parse(created.out);
      expect(json.client_id).toMatch(/^kid_/);
      expect(json.client_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const listed = await kingdom(["clients", "list"], env);
      expect(listed.out).toContain("Cappuccino");
      expect(listed.out).toContain("yes");
      expect(listed.out).not.toContain(json.client_secret);
      const asJson = JSON.parse((await kingdom(["clients", "list", "--json"], env)).out);
      expect(asJson.every((c: Record<string, unknown>) => !("secretHash" in c))).toBe(true);
    });

    it("creates a public client with no secret", async () => {
      const created = JSON.parse((await kingdom(["clients", "create", "--name", "Mobile", "--redirect-uri", "http://localhost:9999/cb", "--public", "--json"], env)).out);
      expect(created.client_secret).toBeNull();
      expect(created.token_endpoint_auth_method).toBe("none");
    });

    it("rejects bad input with usage errors (exit 2) and bad URIs with errors (exit 1)", async () => {
      expect((await kingdom(["clients", "create", "--redirect-uri", "https://x.example/cb"], env)).code).toBe(2);
      expect((await kingdom(["clients", "create", "--name", "X", "--redirect-uri", "https://x.example/cb", "--auth-method", "jwt"], env)).code).toBe(2);
      expect((await kingdom(["clients", "create", "--name", "X", "--bogus"], env)).code).toBe(2);
      const insecure = await kingdom(["clients", "create", "--name", "X", "--redirect-uri", "http://x.example/cb"], env);
      expect(insecure.code).toBe(1);
      expect(insecure.err).toContain("https");
    });
  });

  describe("keys", () => {
    it("rotates every algorithm, promoting next to active", async () => {
      await kingdom(["keys", "list"], env); // first use bootstraps nothing; rotate does
      expect((await kingdom(["keys", "rotate"], env)).code).toBe(0);
      const before = await dbRows((db) => db.select().from(signingKeys));
      const nextRs = before.find((k) => k.alg === "RS256" && k.status === "next")!.kid;

      const rotated = await kingdom(["keys", "rotate", "--alg", "RS256"], env);
      expect(rotated.out).toContain(`Rotated RS256: active key is now ${nextRs}`);
      const after = await dbRows((db) => db.select().from(signingKeys));
      // Both earlier RS256 keys are within their grace period, so both stay published.
      expect(after.filter((k) => k.alg === "RS256" && k.status === "retiring")).toHaveLength(2);
      // ES256 wasn't touched by the second rotation.
      expect(after.filter((k) => k.alg === "ES256" && k.status === "retiring")).toHaveLength(1);

      const listed = await kingdom(["keys", "list"], env);
      expect(listed.out).toContain("retiring");
      expect((await kingdom(["keys", "rotate", "--alg", "HS256"], env)).code).toBe(2);
    });
  });

  describe("users", () => {
    it("creates a user from a password on stdin, verified and admin", async () => {
      const res = await kingdom(["users", "create", "--email", "Grace@Example.test", "--name", "Grace Hopper", "--password-stdin", "--verified", "--admin"], env, "a long enough password\n");
      expect(res.code).toBe(0);
      const [user] = await dbRows((db) => db.select().from(users).where(eq(users.email, "grace@example.test")));
      expect(user).toMatchObject({ emailVerified: true, isAdmin: true });
      expect(user!.passwordHash).toMatch(/^\$argon2id\$/);
    });

    it("generates a password when asked, and refuses duplicates and weak passwords", async () => {
      const res = JSON.parse((await kingdom(["users", "create", "--email", "gen@example.test", "--name", "Gen", "--generate-password", "--json"], env)).out);
      expect(res.password).toMatch(/^[A-Za-z0-9_-]{24}$/);
      expect((await kingdom(["users", "create", "--email", "gen@example.test", "--name", "Gen", "--generate-password"], env)).code).toBe(1);
      expect((await kingdom(["users", "create", "--email", "weak@example.test", "--name", "W", "--password-stdin"], env, "short")).code).toBe(2);
      expect((await kingdom(["users", "create", "--email", "x@example.test", "--name", "X"], env)).code).toBe(2);
    });

    it("grants and revokes admin", async () => {
      await kingdom(["users", "create", "--email", "admin-me@example.test", "--name", "A", "--generate-password"], env);
      expect((await kingdom(["users", "admin", "admin-me@example.test"], env)).code).toBe(0);
      expect((await dbRows((db) => db.select().from(users).where(eq(users.email, "admin-me@example.test"))))[0]!.isAdmin).toBe(true);
      await kingdom(["users", "admin", "admin-me@example.test", "--revoke"], env);
      expect((await dbRows((db) => db.select().from(users).where(eq(users.email, "admin-me@example.test"))))[0]!.isAdmin).toBe(false);
      expect((await kingdom(["users", "admin", "nobody@example.test"], env)).code).toBe(1);
    });
  });

  describe("tokens", () => {
    let t: TestApp;
    let issuer: string;
    let idToken: string;
    let clientId: string;

    beforeAll(async () => {
      const port = await freePort();
      issuer = `http://localhost:${port}`;
      t = await createTestApp({ ISSUER: issuer });
      await t.app.listen({ port, host: "localhost" });
      const { client, secret } = await t.ctx.clients.create({ name: "CLI", type: "confidential", redirectUris: ["https://cli.example/cb"] });
      clientId = client.id;
      const flow = await signUpAndAuthorize(t.app, client, { browser: new Browser(t.app) });
      idToken = (await redeem(t.app, { code: flow.code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier }, { id: client.id, secret: secret! })).json().id_token;
    });
    afterAll(() => t.close());

    it("decodes without verifying, and says so", async () => {
      const res = await kingdom(["token", "decode", idToken], {});
      expect(res.code).toBe(0);
      expect(JSON.parse(res.out.slice(0, res.out.indexOf("\n}") + 2)).payload.aud).toBe(clientId);
      expect(res.out).toContain("NOT checked");
    });

    it("verifies against the issuer's published keys", async () => {
      const ok = await kingdom(["token", "verify", idToken, "--issuer", issuer, "--audience", clientId], {});
      expect(ok.code).toBe(0);
      expect(ok.out).toMatch(/^Valid JWT signed with RS256 key/);

      const [head, body, sig] = idToken.split(".");
      const tampered = `${head}.${body}.${sig!.slice(0, -4)}AAAA`;
      expect((await kingdom(["token", "verify", tampered, "--issuer", issuer], {})).code).toBe(1);
      expect((await kingdom(["token", "verify", idToken, "--issuer", issuer, "--audience", "someone-else"], {})).code).toBe(1);
      expect((await kingdom(["token", "verify", idToken], {})).code).toBe(2);
    });
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}
