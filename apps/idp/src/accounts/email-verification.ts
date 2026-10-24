import type { Redis } from "ioredis";
import { randomToken, sha256 } from "../lib/crypto.js";

export interface Mailer {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

/** Development mailer: writes the message to the log. Replaced by SES in phase 6. */
export class LogMailer implements Mailer {
  constructor(private readonly log: (msg: string, data: object) => void) {}
  async send(message: { to: string; subject: string; text: string }) {
    this.log("email (not sent: log mailer)", message);
  }
}

const TTL_SECONDS = 60 * 60 * 24;

export class EmailVerification {
  constructor(
    private readonly redis: Redis,
    private readonly mailer: Mailer,
    private readonly issuer: string,
  ) {}

  async send(user: { id: string; email: string; name: string }): Promise<void> {
    const token = randomToken();
    await this.redis.set(`verify-email:${sha256(token)}`, user.id, "EX", TTL_SECONDS);
    const link = `${this.issuer}/verify-email?token=${token}`;
    await this.mailer.send({
      to: user.email,
      subject: "Verify your Kingdom ID email",
      text: `Hi ${user.name},\n\nConfirm this is your email address:\n${link}\n\nThe link expires in 24 hours.`,
    });
  }

  /** Returns the user ID the token was issued for, consuming the token. */
  async consume(token: string): Promise<string | undefined> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    return (await this.redis.getdel(`verify-email:${sha256(token)}`)) ?? undefined;
  }
}
