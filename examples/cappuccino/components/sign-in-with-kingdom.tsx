import { signInWithKingdom } from "@/app/actions";

/**
 * The official "Sign in with Kingdom" button: the kingdom-button class from
 * Kingdom ID's button.css (linked in app/layout.tsx) draws the look and the
 * mark. Other looks and sizes: <issuer>/brand.
 */
export function SignInWithKingdom() {
  return (
    <form action={signInWithKingdom}>
      <button type="submit" className="kingdom-button">
        Sign in with Kingdom
      </button>
    </form>
  );
}
