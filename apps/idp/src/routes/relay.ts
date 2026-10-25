import type { FastifyInstance } from "fastify";
import type { Context } from "../context.js";
import { type CertFetcher, type RawMessageFetcher, type SnsEnvelope, isSnsUrl, parseSesNotification, verifySnsSignature } from "../relay/sns.js";

export interface RelayInboundDeps {
  fetchCert: CertFetcher;
  fetchRaw: RawMessageFetcher | undefined;
  /** Confirms an SNS subscription by visiting its SubscribeURL. */
  confirmSubscription: (url: string) => Promise<void>;
}

/**
 * Inbound mail from SES, delivered by SNS. Only messages signed by SNS for
 * the one configured topic are accepted; anything else is 403.
 */
export function registerRelayInboundRoutes(app: FastifyInstance, ctx: Context, deps: RelayInboundDeps) {
  const topicArn = ctx.config.RELAY_SNS_TOPIC_ARN;
  if (!ctx.config.EMAIL_RELAY_ENABLED || !topicArn) return;

  app.post("/relay/sns", { bodyLimit: 512 * 1024 }, async (req, reply) => {
    let envelope: SnsEnvelope;
    try {
      envelope = JSON.parse(typeof req.body === "string" ? req.body : JSON.stringify(req.body)) as SnsEnvelope;
    } catch {
      return reply.status(400).send();
    }
    if (envelope.TopicArn !== topicArn || !(await verifySnsSignature(envelope, deps.fetchCert))) {
      req.log.warn({ event: "relay_rejected_sns", topicArn: envelope.TopicArn }, "rejected unsigned or foreign SNS message");
      return reply.status(403).send();
    }

    if (envelope.Type === "SubscriptionConfirmation") {
      if (!isSnsUrl(envelope.SubscribeURL)) return reply.status(400).send();
      await deps.confirmSubscription(envelope.SubscribeURL!);
      req.log.info({ event: "relay_subscription_confirmed", topicArn }, "SNS subscription confirmed");
      return reply.status(200).send();
    }
    if (envelope.Type !== "Notification") return reply.status(200).send();

    const inbound = await parseSesNotification(envelope.Message, deps.fetchRaw);
    if (!inbound) return reply.status(200).send();
    const outcomes = await ctx.relay.handleInbound(inbound);
    req.log.info({ event: "relay_processed", messageId: inbound.id, outcomes: Object.fromEntries(outcomes) }, "relay message processed");
    // Any outcome, drops included, is final: a non-2xx would only make SNS retry.
    return reply.status(200).send();
  });
}
