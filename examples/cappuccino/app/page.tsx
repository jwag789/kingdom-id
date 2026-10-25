import { auth } from "@/auth";
import { SignInWithKingdom } from "@/components/sign-in-with-kingdom";
import { signOutEverywhere, signOutOfCappuccino } from "./actions";

export default async function Home() {
  const session = await auth();

  if (!session?.user) {
    return (
      <main className="card">
        <h1>☕ Cappuccino</h1>
        <p>Your coffee, your way. Sign in with your Kingdom account to see your order history and perks.</p>
        <SignInWithKingdom />
      </main>
    );
  }

  return (
    <main className="card">
      <h1 data-testid="greeting">Welcome back, {session.user.name}</h1>
      <dl>
        <dt>Email Cappuccino has for you</dt>
        <dd data-testid="email">{session.user.email}</dd>
      </dl>
      <h2>Your Kingdom perks</h2>
      {session.perks.length === 0 ? (
        <p>No perks yet.</p>
      ) : (
        <ul data-testid="perks">
          {session.perks.map((perk) => (
            <li key={perk.id}>
              <strong>{perk.name}</strong> <span>from {perk.app}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        <form action={signOutOfCappuccino}>
          <button type="submit">Sign out of Cappuccino</button>
        </form>
        <form action={signOutEverywhere}>
          <button type="submit">Sign out of Kingdom too</button>
        </form>
      </div>
    </main>
  );
}
