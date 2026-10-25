import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

export interface OutboundMessage {
  /** Envelope sender. */
  from: string;
  /** Envelope recipient. */
  to: string;
  raw: Buffer;
}

/** Where the relay hands finished messages. SES in production; in memory for development and tests. */
export interface RelayTransport {
  send(message: OutboundMessage): Promise<void>;
}

export class SesTransport implements RelayTransport {
  private readonly client: SESv2Client;

  constructor(region: string, private readonly configurationSet?: string) {
    this.client = new SESv2Client({ region });
  }

  async send(message: OutboundMessage): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: message.from,
        Destination: { ToAddresses: [message.to] },
        Content: { Raw: { Data: message.raw } },
        ...(this.configurationSet ? { ConfigurationSetName: this.configurationSet } : {}),
      }),
    );
  }
}

/** Keeps sent messages (bounded) and logs a summary. For development and tests. */
export class MemoryTransport implements RelayTransport {
  readonly sent: OutboundMessage[] = [];

  constructor(private readonly log?: (msg: string, data: object) => void) {}

  async send(message: OutboundMessage): Promise<void> {
    this.sent.push(message);
    if (this.sent.length > 100) this.sent.shift();
    this.log?.("relay message (not sent: memory transport)", { from: message.from, to: message.to, bytes: message.raw.length });
  }
}
