import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ISSUER = "https://localhost:9443";
const here = fileURLToPath(new URL(".", import.meta.url));

/** Runs the `kingdom` CLI inside an instance, as an operator would. */
export function kingdom(instance: "idp-1" | "idp-2", args: string[]): string {
  return execFileSync("docker", ["compose", "exec", "-T", instance, "node", "dist/cli/bin.js", ...args], { cwd: here, encoding: "utf8" });
}

export function compose(args: string[]): string {
  return execFileSync("docker", ["compose", ...args], { cwd: here, encoding: "utf8" });
}

/** A cookie-keeping, redirect-reporting client that notes which instance answered each request. */
export class Browser {
  readonly jar = new Map<string, string>();
  readonly trail: { step: string; instance: string; status: number }[] = [];

  async go(step: string, url: string, form?: Record<string, string>) {
    const res = await fetch(new URL(url, ISSUER), {
      method: form ? "POST" : "GET",
      redirect: "manual",
      headers: {
        cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(form ? { body: new URLSearchParams(form) } : {}),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const eq = pair!.indexOf("=");
      this.jar.set(pair!.slice(0, eq), pair!.slice(eq + 1));
    }
    this.trail.push({ step, instance: res.headers.get("x-kingdom-instance") ?? "?", status: res.status });
    return { res, body: await res.text(), location: res.headers.get("location") };
  }
}

export const csrfFrom = (html: string) => html.match(/name="csrf" value="([^"]+)"/)![1]!;
