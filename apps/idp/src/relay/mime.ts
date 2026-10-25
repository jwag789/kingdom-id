import libmime from "libmime";

/**
 * Minimal RFC 5322 header surgery. The relay only ever rewrites headers, so
 * the body (MIME parts, attachments, signed content) is passed through
 * byte-for-byte rather than parsed and re-encoded.
 */

export interface Header {
  name: string;
  /** The raw value as received, including folding, without the trailing line break. */
  value: string;
}

export interface Message {
  headers: Header[];
  body: Buffer;
}

export function parseMessage(raw: Buffer): Message {
  let split = raw.indexOf("\r\n\r\n");
  let gap = 4;
  if (split === -1) {
    split = raw.indexOf("\n\n");
    gap = 2;
  }
  const headerText = (split === -1 ? raw : raw.subarray(0, split)).toString("latin1");
  const body = split === -1 ? Buffer.alloc(0) : raw.subarray(split + gap);
  const headers: Header[] = [];
  for (const line of headerText.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && headers.length > 0) {
      headers[headers.length - 1]!.value += `\r\n${line}`; // continuation of a folded header
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).replace(/^ /, "") });
  }
  return { headers, body };
}

export function serializeMessage({ headers, body }: Message): Buffer {
  const head = headers.map((h) => `${h.name}: ${h.value}`).join("\r\n");
  return Buffer.concat([Buffer.from(`${head}\r\n\r\n`, "latin1"), body]);
}

export const headerValue = (message: Message, name: string) =>
  message.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

/** Removes every header whose name matches, case-insensitively; `prefix*` matches a prefix. */
export function removeHeaders(message: Message, names: string[]): Message {
  const lower = names.map((n) => n.toLowerCase());
  const matches = (name: string) =>
    lower.some((n) => (n.endsWith("*") ? name.toLowerCase().startsWith(n.slice(0, -1)) : name.toLowerCase() === n));
  return { ...message, headers: message.headers.filter((h) => !matches(h.name)) };
}

/** Adds headers at the top, where trace and relay headers conventionally go. */
export const prependHeaders = (message: Message, headers: Header[]): Message => ({ ...message, headers: [...headers, ...message.headers] });

/** `"Display" <addr>`, with the display name RFC 2047-encoded when it isn't plain ASCII. */
export function formatAddress(address: string, displayName?: string): string {
  if (!displayName) return address;
  const plain = /^[\x20-\x7e]*$/.test(displayName);
  const name = plain ? `"${displayName.replace(/["\\]/g, "\\$&")}"` : libmime.encodeWord(displayName, "B");
  return `${name} <${address}>`;
}

/** First mailbox in an address header: decoded display name and lowercased address. */
export function parseFirstAddress(value: string | undefined): { name?: string; address: string } | undefined {
  if (!value) return undefined;
  const unfolded = value.replace(/\r?\n[ \t]+/g, " ");
  const angle = unfolded.match(/^\s*(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  if (angle) {
    const rawName = angle[1]!.replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1").trim();
    const name = rawName ? libmime.decodeWords(rawName) : undefined;
    return { address: angle[2]!.toLowerCase(), ...(name ? { name } : {}) };
  }
  const bare = unfolded.match(/([^\s<>",;]+@[^\s<>",;]+)/);
  return bare ? { address: bare[1]!.toLowerCase() } : undefined;
}
