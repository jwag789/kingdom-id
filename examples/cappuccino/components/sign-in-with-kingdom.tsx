import { signInWithKingdom } from "@/app/actions";

/**
 * The "Sign in with Kingdom" button: Kingdom navy, the Kingdom mark, and a
 * 44px minimum touch target. Copy it as-is, or restyle and keep the mark.
 */
export function SignInWithKingdom() {
  return (
    <form action={signInWithKingdom}>
      <button type="submit" className="kingdom-button">
        <img src="/kingdom-mark-white.png" alt="" width={28} height={15} />
        Sign in with Kingdom
      </button>
    </form>
  );
}
