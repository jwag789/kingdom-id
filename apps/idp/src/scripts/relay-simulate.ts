/**
 * Pushes a message through the relay locally, without AWS, and prints what
 * would be sent. For demos and debugging.
 *
 *   pnpm --filter @kingdom-id/idp relay:simulate <to-address> [from-address] [subject]
 *
 * <to-address> is a mask (mail from outside) or a reverse alias (a reply).
 */
import { connect } from "@kingdom-id/db";
import { loadConfig } from "../config.js";
import { connectRedis } from "../lib/redis.js";
import { RelayService } from "../relay/service.js";
import { MemoryTransport } from "../relay/transport.js";

const [to, from = "store@shop.example", subject = "Your order has shipped"] = process.argv.slice(2);
if (!to) {
  console.error("usage: relay:simulate <to-address> [from-address] [subject]");
  process.exit(1);
}
const config = loadConfig();
const { db, close } = connect(config.DATABASE_URL, { max: 1 });
const redis = connectRedis(config.REDIS_URL);
const transport = new MemoryTransport();
const relay = new RelayService(db, redis, transport, { domain: config.relayDomain });

const raw = Buffer.from(
  [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${Date.now()}@simulate>`, "Content-Type: text/plain; charset=utf-8", "", "Hello from the relay simulator.", ""].join("\r\n"),
);
const outcomes = await relay.handleInbound({
  id: `simulate-${Date.now()}`,
  raw,
  recipients: [to],
  verdicts: { spam: "PASS", virus: "PASS", spf: "PASS", dkim: "PASS", dmarc: "PASS" },
});
console.log("outcome:", Object.fromEntries(outcomes));
for (const sent of transport.sent) {
  console.log(`\n--- would send: ${sent.from} → ${sent.to} ---\n${sent.raw.toString()}`);
}
await close();
await redis.quit();
