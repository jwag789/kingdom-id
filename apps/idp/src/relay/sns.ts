import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { verify } from "node:crypto";
import type { InboundMessage, Verdict } from "./service.js";

/** An Amazon SNS HTTP(S) delivery, as POSTed to our endpoint. */
export interface SnsEnvelope {
  Type: "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation";
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  SubscribeURL?: string;
  Token?: string;
}

// Only Amazon's own SNS hosts may supply signing certificates or subscription URLs.
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

export const isSnsUrl = (raw: string | undefined, pathSuffix?: string) => {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && SNS_HOST.test(url.hostname) && (!pathSuffix || url.pathname.endsWith(pathSuffix));
  } catch {
    return false;
  }
};

/** The fields AWS signs, in the order it signs them, per message type. */
function stringToSign(m: SnsEnvelope): string {
  const keys: (keyof SnsEnvelope)[] =
    m.Type === "Notification"
      ? ["Message", "MessageId", ...(m.Subject !== undefined ? (["Subject"] as const) : []), "Timestamp", "TopicArn", "Type"]
      : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  return keys.map((k) => `${k}\n${m[k] ?? ""}\n`).join("");
}

export type CertFetcher = (url: string) => Promise<string>;

/** Fetches and caches SNS signing certificates (PEM). */
export function httpsCertFetcher(): CertFetcher {
  const cache = new Map<string, Promise<string>>();
  return (url) => {
    let pem = cache.get(url);
    if (!pem) {
      pem = fetch(url, { signal: AbortSignal.timeout(5000) }).then(async (res) => {
        if (!res.ok) throw new Error(`certificate fetch failed: ${res.status}`);
        return res.text();
      });
      pem.catch(() => cache.delete(url));
      cache.set(url, pem);
    }
    return pem;
  };
}

/**
 * Verifies an SNS message per AWS's documented algorithm: the certificate
 * must come from an SNS host over https, and the signature must cover the
 * canonical string for the message type.
 */
export async function verifySnsSignature(m: SnsEnvelope, fetchCert: CertFetcher): Promise<boolean> {
  if (!isSnsUrl(m.SigningCertURL, ".pem")) return false;
  const algorithm = m.SignatureVersion === "1" ? "RSA-SHA1" : m.SignatureVersion === "2" ? "RSA-SHA256" : undefined;
  if (!algorithm || typeof m.Signature !== "string") return false;
  try {
    const pem = await fetchCert(m.SigningCertURL);
    return verify(algorithm, Buffer.from(stringToSign(m), "utf8"), pem, Buffer.from(m.Signature, "base64"));
  } catch {
    return false;
  }
}

export type RawMessageFetcher = (bucket: string, key: string) => Promise<Buffer>;

export function s3MessageFetcher(region: string): RawMessageFetcher {
  const s3 = new S3Client({ region });
  return async (bucket, key) => {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return Buffer.from(await object.Body!.transformToByteArray());
  };
}

interface SesReceivedNotification {
  notificationType: string;
  mail: { messageId: string };
  receipt: {
    recipients: string[];
    spamVerdict?: { status: Verdict };
    virusVerdict?: { status: Verdict };
    spfVerdict?: { status: Verdict };
    dkimVerdict?: { status: Verdict };
    dmarcVerdict?: { status: Verdict };
    dmarcPolicy?: string;
    action: { type: string; bucketName?: string; objectKey?: string; encoding?: string };
  };
  content?: string;
}

/**
 * Turns an SES "Received" notification into an InboundMessage. The raw mail
 * comes inline (SNS action, up to 150 KB) or from S3 (S3 action, any size).
 */
export async function parseSesNotification(json: string, fetchRaw: RawMessageFetcher | undefined): Promise<InboundMessage | undefined> {
  const n = JSON.parse(json) as SesReceivedNotification;
  if (n.notificationType !== "Received") return undefined;
  const { receipt } = n;
  let raw: Buffer;
  if (receipt.action.type === "S3" && receipt.action.bucketName && receipt.action.objectKey) {
    if (!fetchRaw) throw new Error("S3 action received but no S3 fetcher is configured");
    raw = await fetchRaw(receipt.action.bucketName, receipt.action.objectKey);
  } else if (receipt.action.type === "SNS" && n.content !== undefined) {
    raw = Buffer.from(n.content, receipt.action.encoding === "BASE64" ? "base64" : "utf8");
  } else {
    throw new Error(`unsupported SES action: ${receipt.action.type}`);
  }
  return {
    id: n.mail.messageId,
    raw,
    recipients: receipt.recipients,
    verdicts: {
      ...(receipt.spamVerdict ? { spam: receipt.spamVerdict.status } : {}),
      ...(receipt.virusVerdict ? { virus: receipt.virusVerdict.status } : {}),
      ...(receipt.spfVerdict ? { spf: receipt.spfVerdict.status } : {}),
      ...(receipt.dkimVerdict ? { dkim: receipt.dkimVerdict.status } : {}),
      ...(receipt.dmarcVerdict ? { dmarc: receipt.dmarcVerdict.status } : {}),
      ...(receipt.dmarcPolicy ? { dmarcPolicy: receipt.dmarcPolicy } : {}),
    },
  };
}
