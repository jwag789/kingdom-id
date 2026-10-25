"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getToken } from "next-auth/jwt";
import { KINGDOM_ISSUER, signIn, signOut } from "@/auth";

export async function signInWithKingdom() {
  await signIn("kingdom", { redirectTo: "/" });
}

/** Ends Cappuccino's session only. Kingdom stays signed in, so signing back in is one click. */
export async function signOutOfCappuccino() {
  await signOut({ redirectTo: "/" });
}

/**
 * Ends Cappuccino's session and the Kingdom session (OIDC RP-Initiated
 * Logout). The ID token proves which session to end, so Kingdom ID signs the
 * member out without a confirmation page, then returns them here.
 */
export async function signOutEverywhere() {
  const appUrl = process.env.AUTH_URL ?? "http://localhost:4002";
  const token = await getToken({
    req: { headers: await headers() },
    secret: process.env.AUTH_SECRET,
    secureCookie: appUrl.startsWith("https://"),
  });
  await signOut({ redirect: false });
  const endSession = new URL("/end-session", KINGDOM_ISSUER);
  if (typeof token?.idToken === "string") endSession.searchParams.set("id_token_hint", token.idToken);
  endSession.searchParams.set("post_logout_redirect_uri", `${appUrl}/`);
  redirect(endSession.toString());
}
