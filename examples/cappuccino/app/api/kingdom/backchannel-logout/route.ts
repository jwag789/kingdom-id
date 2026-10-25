import { acceptLogoutToken } from "@/lib/kingdom-logout";

/**
 * Kingdom ID calls this, server to server, when a member signs out of Kingdom
 * or disconnects Cappuccino. Register it with
 * `kingdom clients create … --backchannel-logout-uri <origin>/api/kingdom/backchannel-logout`.
 */
export async function POST(request: Request) {
  const form = await request.formData();
  const token = form.get("logout_token");
  try {
    if (typeof token !== "string") throw new Error("logout_token missing");
    await acceptLogoutToken(token);
    return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
  } catch {
    // §2.8: a 400 tells Kingdom ID the token was rejected.
    return new Response(null, { status: 400, headers: { "cache-control": "no-store" } });
  }
}
