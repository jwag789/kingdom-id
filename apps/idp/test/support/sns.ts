import { generateKeyPairSync, sign } from "node:crypto";
import type { SnsEnvelope } from "../../src/relay/sns.js";

/**
 * Signs SNS envelopes the way Amazon does, with a test key whose public half
 * stands in for Amazon's signing certificate. The canonical string is
 * re-implemented here, independently of the code under test.
 */
export class FakeSns {
  readonly topicArn = "arn:aws:sns:us-east-1:123456789012:kingdom-relay";
  readonly certUrl = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem";
  private readonly keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  readonly publicPem = this.keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  private seq = 0;

  fetchCert = async (url: string) => {
    if (url !== this.certUrl) throw new Error(`unexpected cert URL ${url}`);
    return this.publicPem;
  };

  envelope(type: SnsEnvelope["Type"], message: string, overrides: Partial<SnsEnvelope> = {}, version: "1" | "2" = "2"): SnsEnvelope {
    const base: SnsEnvelope = {
      Type: type,
      MessageId: `sns-${++this.seq}`,
      TopicArn: this.topicArn,
      Message: message,
      Timestamp: new Date().toISOString(),
      SignatureVersion: version,
      Signature: "",
      SigningCertURL: this.certUrl,
      ...(type === "Notification" ? {} : { SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t", Token: "t" }),
      ...overrides,
    };
    const fields =
      type === "Notification"
        ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
        : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
    const canonical = fields
      .filter((f) => base[f as keyof SnsEnvelope] !== undefined)
      .map((f) => `${f}\n${base[f as keyof SnsEnvelope]}\n`)
      .join("");
    base.Signature = sign(version === "1" ? "RSA-SHA1" : "RSA-SHA256", Buffer.from(canonical), this.keys.privateKey).toString("base64");
    return { ...base, ...(overrides.Signature ? { Signature: overrides.Signature } : {}) };
  }
}

/** An SES "Received" notification for an inline (SNS action) or S3-stored message. */
export function sesNotification(opts: {
  messageId: string;
  recipients: string[];
  raw?: Buffer;
  s3?: { bucket: string; key: string };
  verdicts?: Partial<Record<"spam" | "virus" | "spf" | "dkim" | "dmarc", string>>;
  dmarcPolicy?: string;
}) {
  const v = { spam: "PASS", virus: "PASS", spf: "PASS", dkim: "PASS", dmarc: "PASS", ...opts.verdicts };
  return JSON.stringify({
    notificationType: "Received",
    mail: { messageId: opts.messageId, destination: opts.recipients },
    receipt: {
      recipients: opts.recipients,
      spamVerdict: { status: v.spam },
      virusVerdict: { status: v.virus },
      spfVerdict: { status: v.spf },
      dkimVerdict: { status: v.dkim },
      dmarcVerdict: { status: v.dmarc },
      ...(opts.dmarcPolicy ? { dmarcPolicy: opts.dmarcPolicy } : {}),
      action: opts.s3 ? { type: "S3", bucketName: opts.s3.bucket, objectKey: opts.s3.key } : { type: "SNS", encoding: "BASE64" },
    },
    ...(opts.raw ? { content: opts.raw.toString("base64") } : {}),
  });
}

export function email(opts: { from: string; to: string; subject?: string; extraHeaders?: string[]; body?: string }) {
  return Buffer.from(
    [
      "DKIM-Signature: v=1; a=rsa-sha256; d=sender.test; b=xyz",
      `From: ${opts.from}`,
      `To: ${opts.to}`,
      `Subject: ${opts.subject ?? "Hello"}`,
      "Message-ID: <m1@sender.test>",
      ...(opts.extraHeaders ?? []),
      "Content-Type: text/plain; charset=utf-8",
      "",
      opts.body ?? "Hi there.\r\n",
    ].join("\r\n"),
  );
}
