import { type Database, type User, users } from "@kingdom-id/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { PASSWORD_MAX, PASSWORD_MIN, dummyHash, hashPassword, verifyPassword } from "./passwords.js";

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export const signupSchema = z.object({
  name: z.string().trim().min(1, "Enter your name").max(100, "Name is too long"),
  email: z
    .string()
    .trim()
    .max(254, "Email is too long")
    .pipe(z.email("Enter a valid email address"))
    .transform(normalizeEmail),
  password: z
    .string()
    .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`)
    .max(PASSWORD_MAX, `Use at most ${PASSWORD_MAX} characters`),
});

export type SignupInput = z.infer<typeof signupSchema>;

export class EmailTakenError extends Error {
  constructor() {
    super("email already registered");
    this.name = "EmailTakenError";
  }
}

export class UserService {
  constructor(private readonly db: Database) {}

  async create(input: SignupInput): Promise<User> {
    const passwordHash = await hashPassword(input.password);
    const rows = await this.db
      .insert(users)
      .values({ email: input.email, name: input.name, passwordHash })
      .onConflictDoNothing({ target: users.email })
      .returning();
    if (!rows[0]) throw new EmailTakenError();
    return rows[0];
  }

  async emailExists(email: string): Promise<boolean> {
    const [row] = await this.db.select({ id: users.id }).from(users).where(eq(users.email, normalizeEmail(email)));
    return !!row;
  }

  async findById(id: string): Promise<User | undefined> {
    const [user] = await this.db.select().from(users).where(eq(users.id, id));
    return user;
  }

  /** Returns the user only if the password matches. Constant-ish time whether or not the account exists. */
  async authenticate(email: string, password: string): Promise<User | undefined> {
    if (password.length > PASSWORD_MAX) return undefined;
    const [user] = await this.db.select().from(users).where(eq(users.email, normalizeEmail(email)));
    if (!user?.passwordHash) {
      await verifyPassword(await dummyHash(), password);
      return undefined;
    }
    return (await verifyPassword(user.passwordHash, password)) ? user : undefined;
  }

  async markEmailVerified(id: string): Promise<void> {
    await this.db.update(users).set({ emailVerified: true, updatedAt: new Date() }).where(eq(users.id, id));
  }
}
