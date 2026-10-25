import { parseArgs } from "node:util";
import { type Database, type DatabaseHandle, clients, connect, signingKeys, users } from "@kingdom-id/db";
import { asc, eq, ne } from "drizzle-orm";
import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { randomToken } from "../lib/crypto.js";
import { EmailTakenError, UserService, signupSchema } from "../accounts/users.js";
import { type Config, loadConfig } from "../config.js";
import { KeyStore, SIGNING_ALGS, type SigningAlg } from "../keys/keystore.js";
import { ClientService } from "../oauth/clients.js";

/** Where the CLI writes. Injected so tests can capture output without spawning processes. */
export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Reads all of standard input (for --password-stdin). */
  stdin: () => Promise<string>;
}

const HELP = `kingdom: administer a Kingdom ID deployment

Usage: kingdom <command> [options]

Clients
  clients list [--json]
  clients create --name <name> --redirect-uri <uri> [--redirect-uri <uri>...]
                 [--post-logout-uri <uri>...] [--logo-uri <uri>] [--id <id>]
                 [--public] [--first-party] [--auth-method basic|post]
                 [--id-token-alg RS256|ES256] [--subject pairwise|public] [--json]

Signing keys
  keys list [--json]
  keys rotate [--alg RS256|ES256]          rotates every algorithm by default

Users
  users create --email <email> --name <name> (--password-stdin | --generate-password)
               [--verified] [--admin] [--json]
  users admin <email> [--revoke]

Tokens (no database needed)
  token decode <jwt>
  token verify <jwt> [--issuer <url>] [--audience <aud>]

Database commands read DATABASE_URL and KEY_ENCRYPTION_KEY like the server does.`;

class UsageError extends Error {}

export async function run(argv: string[], io: Io, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [group, action, ...rest] = argv;
  const command = `${group ?? ""} ${action ?? ""}`.trim();
  let database: DatabaseHandle | undefined;
  const db = (): { db: Database; config: Config } => {
    const config = loadConfig(env);
    database ??= connect(config.DATABASE_URL, { max: 1 });
    return { db: database.db, config };
  };

  try {
    switch (command) {
      case "clients list":
        return await clientsList(db().db, rest, io);
      case "clients create":
        return await clientsCreate(db().db, rest, io);
      case "keys list":
        return await keysList(db().db, rest, io);
      case "keys rotate":
        return await keysRotate(db(), rest, io);
      case "users create":
        return await usersCreate(db().db, rest, io);
      case "users admin":
        return await usersAdmin(db().db, rest, io);
      case "token decode":
        return tokenDecode(rest, io);
      case "token verify":
        return await tokenVerify(rest, io, env);
      case "":
      case "help":
      case "--help":
        io.out(HELP);
        return 0;
      default:
        throw new UsageError(`unknown command: ${command}`);
    }
  } catch (err) {
    if (err instanceof UsageError || (err instanceof TypeError && "code" in err && String(err.code).startsWith("ERR_PARSE_ARGS"))) {
      io.err(`kingdom: ${err.message}\nRun "kingdom help" for usage.`);
      return 2;
    }
    io.err(`kingdom: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await database?.close();
  }
}

// ------------------------------------------------------------------
// Clients
// ------------------------------------------------------------------

async function clientsList(db: Database, args: string[], io: Io) {
  const { values } = parseArgs({ args, options: { json: { type: "boolean" } }, strict: true });
  const rows = await db.select().from(clients).orderBy(asc(clients.name));
  if (values.json) {
    io.out(JSON.stringify(rows.map(({ secretHash: _, ...c }) => c), null, 2));
    return 0;
  }
  table(
    io,
    ["ID", "NAME", "TYPE", "AUTH", "SUBJECT", "FIRST PARTY", "REDIRECT URIS"],
    rows.map((c) => [c.id, c.name, c.type, c.tokenEndpointAuthMethod, c.subjectType, c.firstParty ? "yes" : "no", c.redirectUris.join(", ")]),
  );
  return 0;
}

async function clientsCreate(db: Database, args: string[], io: Io) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      name: { type: "string" },
      id: { type: "string" },
      "redirect-uri": { type: "string", multiple: true },
      "post-logout-uri": { type: "string", multiple: true },
      "logo-uri": { type: "string" },
      public: { type: "boolean" },
      "first-party": { type: "boolean" },
      "auth-method": { type: "string" },
      "id-token-alg": { type: "string" },
      subject: { type: "string" },
      json: { type: "boolean" },
    },
  });
  if (!values.name) throw new UsageError("--name is required");
  if (!values["redirect-uri"]?.length) throw new UsageError("at least one --redirect-uri is required");
  const method = values["auth-method"] ?? "basic";
  if (!["basic", "post"].includes(method)) throw new UsageError("--auth-method must be basic or post");
  const alg = values["id-token-alg"] ?? "RS256";
  if (!["RS256", "ES256"].includes(alg)) throw new UsageError("--id-token-alg must be RS256 or ES256");
  const subject = values.subject ?? "pairwise";
  if (!["pairwise", "public"].includes(subject)) throw new UsageError("--subject must be pairwise or public");

  const { client, secret } = await new ClientService(db).create({
    name: values.name,
    type: values.public ? "public" : "confidential",
    redirectUris: values["redirect-uri"],
    ...(values.id ? { id: values.id } : {}),
    ...(values["post-logout-uri"] ? { postLogoutRedirectUris: values["post-logout-uri"] } : {}),
    ...(values["logo-uri"] ? { logoUri: values["logo-uri"] } : {}),
    ...(values["first-party"] ? { firstParty: true } : {}),
    tokenEndpointAuthMethod: method === "post" ? "client_secret_post" : "client_secret_basic",
    idTokenSignedResponseAlg: alg as SigningAlg,
    subjectType: subject as "pairwise" | "public",
  });
  if (values.json) {
    io.out(JSON.stringify({ client_id: client.id, client_secret: secret ?? null, token_endpoint_auth_method: client.tokenEndpointAuthMethod }, null, 2));
    return 0;
  }
  io.out(`Created ${client.type} client "${client.name}"`);
  io.out(`  client_id:     ${client.id}`);
  if (secret) {
    io.out(`  client_secret: ${secret}`);
    io.out("  Store the secret now: only its hash is kept, so it can't be shown again.");
  }
  return 0;
}

// ------------------------------------------------------------------
// Keys
// ------------------------------------------------------------------

async function keysList(db: Database, args: string[], io: Io) {
  const { values } = parseArgs({ args, options: { json: { type: "boolean" } }, strict: true });
  const rows = await db
    .select({ kid: signingKeys.kid, alg: signingKeys.alg, status: signingKeys.status, createdAt: signingKeys.createdAt, activatedAt: signingKeys.activatedAt })
    .from(signingKeys)
    .where(ne(signingKeys.status, "retired"))
    .orderBy(asc(signingKeys.alg), asc(signingKeys.createdAt));
  if (values.json) {
    io.out(JSON.stringify(rows, null, 2));
    return 0;
  }
  table(
    io,
    ["ALG", "STATUS", "KID", "CREATED", "ACTIVATED"],
    rows.map((k) => [k.alg, k.status, k.kid, k.createdAt.toISOString(), k.activatedAt?.toISOString() ?? "-"]),
  );
  return 0;
}

async function keysRotate({ db, config }: { db: Database; config: Config }, args: string[], io: Io) {
  const { values } = parseArgs({ args, options: { alg: { type: "string" } }, strict: true });
  const algs = values.alg ? [values.alg] : [...SIGNING_ALGS];
  for (const alg of algs) if (!SIGNING_ALGS.includes(alg as SigningAlg)) throw new UsageError(`--alg must be one of ${SIGNING_ALGS.join(", ")}`);
  const store = new KeyStore(db, Buffer.from(config.KEY_ENCRYPTION_KEY, "base64"), {
    rotationIntervalSeconds: config.KEY_ROTATION_INTERVAL_SECONDS,
    retirementGraceSeconds: config.KEY_RETIREMENT_GRACE_SECONDS,
  });
  await store.ensureKeys();
  for (const alg of algs) {
    await store.rotate(alg as SigningAlg);
    const active = await store.getActiveKey(alg as SigningAlg);
    io.out(`Rotated ${alg}: active key is now ${active.kid}`);
  }
  io.out("Running instances pick up the new key within 30 seconds; it was already published as `next`.");
  return 0;
}

// ------------------------------------------------------------------
// Users
// ------------------------------------------------------------------

async function usersCreate(db: Database, args: string[], io: Io) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      email: { type: "string" },
      name: { type: "string" },
      "password-stdin": { type: "boolean" },
      "generate-password": { type: "boolean" },
      verified: { type: "boolean" },
      admin: { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  if (!!values["password-stdin"] === !!values["generate-password"]) {
    throw new UsageError("choose one of --password-stdin or --generate-password");
  }
  // Passwords never go on the command line, where shell history and `ps` would see them.
  const password = values["generate-password"] ? randomToken(18) : (await io.stdin()).replace(/\r?\n$/, "");
  const parsed = signupSchema.safeParse({ email: values.email ?? "", name: values.name ?? "", password });
  if (!parsed.success) throw new UsageError(parsed.error.issues.map((i) => `${String(i.path[0])}: ${i.message}`).join("; "));

  const service = new UserService(db);
  let user;
  try {
    user = await service.create(parsed.data);
  } catch (err) {
    if (err instanceof EmailTakenError) throw new Error(`an account for ${parsed.data.email} already exists`);
    throw err;
  }
  if (values.verified) await service.markEmailVerified(user.id);
  if (values.admin) await db.update(users).set({ isAdmin: true }).where(eq(users.id, user.id));

  if (values.json) {
    io.out(JSON.stringify({ id: user.id, email: user.email, ...(values["generate-password"] ? { password } : {}) }, null, 2));
    return 0;
  }
  io.out(`Created ${user.email} (${user.id})${values.admin ? " as an admin" : ""}`);
  if (values["generate-password"]) io.out(`  password: ${password}`);
  return 0;
}

async function usersAdmin(db: Database, args: string[], io: Io) {
  const { values, positionals } = parseArgs({ args, options: { revoke: { type: "boolean" } }, allowPositionals: true, strict: true });
  const email = positionals[0];
  if (!email) throw new UsageError("usage: users admin <email> [--revoke]");
  const updated = await db
    .update(users)
    .set({ isAdmin: !values.revoke })
    .where(eq(users.email, email.trim().toLowerCase()))
    .returning({ id: users.id });
  if (updated.length === 0) throw new Error(`no account for ${email}`);
  io.out(`${email} is ${values.revoke ? "no longer" : "now"} an admin.${values.revoke ? "" : " Admin pages also need a passkey sign-in."}`);
  return 0;
}

// ------------------------------------------------------------------
// Tokens
// ------------------------------------------------------------------

function tokenDecode(args: string[], io: Io) {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  const jwt = positionals[0];
  if (!jwt) throw new UsageError("usage: token decode <jwt>");
  const header = decodeProtectedHeader(jwt);
  const payload = decodeJwt(jwt);
  io.out(JSON.stringify({ header, payload }, null, 2));
  for (const claim of ["iat", "nbf", "exp", "auth_time"] as const) {
    const value = payload[claim];
    if (typeof value === "number") io.out(`${claim.padEnd(9)} ${new Date(value * 1000).toISOString()}`);
  }
  if (typeof payload.exp === "number") io.out(payload.exp * 1000 < Date.now() ? "Expired." : "Not expired.");
  io.out("Decoded only. The signature was NOT checked; use `token verify` for that.");
  return 0;
}

async function tokenVerify(args: string[], io: Io, env: NodeJS.ProcessEnv) {
  const { values, positionals } = parseArgs({
    args,
    options: { issuer: { type: "string" }, audience: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const jwt = positionals[0];
  if (!jwt) throw new UsageError("usage: token verify <jwt> [--issuer <url>] [--audience <aud>]");
  const issuer = (values.issuer ?? env.ISSUER)?.replace(/\/+$/, "");
  if (!issuer) throw new UsageError("--issuer is required (or set ISSUER)");

  // The keys come from the issuer's own discovery document, exactly as a relying party would find them.
  const discovery = (await (await fetch(`${issuer}/.well-known/openid-configuration`)).json()) as { issuer: string; jwks_uri: string };
  if (discovery.issuer !== issuer) throw new Error(`discovery says the issuer is ${discovery.issuer}, not ${issuer}`);
  try {
    const { payload, protectedHeader } = await jwtVerify(jwt, createRemoteJWKSet(new URL(discovery.jwks_uri)), {
      issuer,
      ...(values.audience ? { audience: values.audience } : {}),
    });
    io.out(`Valid ${protectedHeader.typ ?? "JWT"} signed with ${protectedHeader.alg} key ${protectedHeader.kid}.`);
    io.out(JSON.stringify(payload, null, 2));
    return 0;
  } catch (err) {
    io.err(`Invalid: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function table(io: Io, head: string[], rows: string[][]) {
  if (rows.length === 0) {
    io.out("(none)");
    return;
  }
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  io.out(line(head));
  for (const row of rows) io.out(line(row));
}
