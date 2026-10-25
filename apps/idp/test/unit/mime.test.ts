import { describe, expect, it } from "vitest";
import { newMaskAddress, newReverseAlias } from "../../src/relay/addresses.js";
import { formatAddress, headerValue, parseFirstAddress, parseMessage, removeHeaders, serializeMessage } from "../../src/relay/mime.js";

const raw = Buffer.concat([
  Buffer.from(
    [
      "Received: from mx.example.com",
      "DKIM-Signature: v=1; a=rsa-sha256; d=example.com;",
      "\tb=abcdef",
      "ARC-Seal: i=1; a=rsa-sha256",
      "From: =?UTF-8?B?w4ltaWxl?= <emile@example.com>",
      "Subject: Your receipt",
      "Content-Type: multipart/mixed; boundary=xyz",
      "",
      "",
    ].join("\r\n"),
  ),
  Buffer.from([0x2d, 0x2d, 0x78, 0x79, 0x7a, 0x0d, 0x0a, 0xff, 0xfe, 0x00, 0x01]), // body with non-UTF-8 bytes
]);

describe("MIME header surgery", () => {
  it("round-trips a message without touching the body bytes", () => {
    const out = serializeMessage(parseMessage(raw));
    expect(out.subarray(out.indexOf("\r\n\r\n") + 4)).toEqual(raw.subarray(raw.indexOf("\r\n\r\n") + 4));
  });

  it("keeps folded headers together and removes by name or prefix", () => {
    const message = parseMessage(raw);
    expect(headerValue(message, "dkim-signature")).toContain("\tb=abcdef");
    const stripped = removeHeaders(message, ["DKIM-Signature", "ARC-*"]);
    const names = stripped.headers.map((h) => h.name);
    expect(names).toEqual(["Received", "From", "Subject", "Content-Type"]);
  });

  it("decodes encoded-word display names and lowercases addresses", () => {
    expect(parseFirstAddress(headerValue(parseMessage(raw), "From"))).toEqual({ name: "Émile", address: "emile@example.com" });
    expect(parseFirstAddress('"Doe, Jane" <Jane@Example.COM>')).toEqual({ name: "Doe, Jane", address: "jane@example.com" });
    expect(parseFirstAddress("plain@example.com")).toEqual({ address: "plain@example.com" });
    expect(parseFirstAddress(undefined)).toBeUndefined();
  });

  it("quotes ASCII display names and encodes the rest", () => {
    expect(formatAddress("a@relay.test", 'Jane "JJ" Doe')).toBe('"Jane \\"JJ\\" Doe" <a@relay.test>');
    expect(formatAddress("a@relay.test", "Émile")).toMatch(/^=\?UTF-8\?B\?.+\?= <a@relay\.test>$/);
    expect(formatAddress("a@relay.test")).toBe("a@relay.test");
  });
});

describe("relay addresses", () => {
  it("are readable, random, and on the relay domain", () => {
    const a = newMaskAddress("relay.example.com");
    expect(a).toMatch(/^[a-z]+-[a-z]+\.[a-z2-9]{6}@relay\.example\.com$/);
    expect(new Set(Array.from({ length: 200 }, () => newMaskAddress("r.test"))).size).toBe(200);
    expect(newReverseAlias("relay.example.com")).toMatch(/^r\.[a-z2-9]{16}@relay\.example\.com$/);
  });
});
