import type { ComponentChildren } from "preact";
import { renderToString } from "preact-render-to-string";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Context } from "../context.js";
import { Icon } from "./icons.js";

export interface AppIdentity {
  name: string;
  logoUri: string | null;
}

/** Per-request rendering context every page needs. */
export interface Ui {
  nonce: string;
  /** Whether per-app private email addresses are live (phase 6). Gates every claim about them. */
  relay: boolean;
}

export const uiFor = (ctx: Context, req: FastifyRequest): Ui => ({
  nonce: req.cspNonce,
  relay: ctx.config.EMAIL_RELAY_ENABLED,
});

export function Document({ title, ui, stylesheets = [], children }: { title: string; ui: Ui; stylesheets?: string[]; children: ComponentChildren }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <meta name="color-scheme" content="dark light" />
        <title>{`${title} · Kingdom ID`}</title>
        <link rel="icon" href="/brand/favicon.png" />
        <link rel="preload" href="/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
        <link rel="stylesheet" href="/brand/tokens.css" />
        <link rel="stylesheet" href="/assets/app.css" />
        {stylesheets.map((href) => (
          <link key={href} rel="stylesheet" href={href} />
        ))}
        <script type="module" src="/assets/passkey.js" nonce={ui.nonce} />
      </head>
      <body>{children}</body>
    </html>
  );
}

/**
 * The sign-in shell: brand story beside the card on wide screens, a compact
 * brand header above it on narrow ones. The story panel is always dark (the
 * brand moment); the card follows the user's light or dark preference.
 */
export function AuthLayout({ title, ui, children }: { title: string; ui: Ui; children: ComponentChildren }) {
  return (
    <Document title={title} ui={ui}>
      <a class="skip-link" href="#main">
        Skip to sign-in
      </a>
      <div class="auth">
        <aside class="story" aria-label="About Kingdom ID">
          <div class="aurora" aria-hidden="true">
            <span class="blob blob-a" />
            <span class="blob blob-b" />
            <span class="blob blob-c" />
            <span class="blob blob-d" />
            <span class="grid-lines" />
          </div>
          <div class="story-inner">
            <a class="story-brand" href="https://kingdomwebbuilders.com">
              <img src="/brand/kingdom-mark-white.png" alt="" width="54" height="29" />
              <span>
                <strong>Kingdom ID</strong>
                <small>by Kingdom Web Builders</small>
              </span>
            </a>
            <p class="story-headline">
              One key to <em>every</em> Kingdom app.
            </p>
            <StoryPoints ui={ui} />
          </div>
        </aside>
        <main id="main" class="stage">
          {children}
          <StoryPoints ui={ui} variant="stacked" />
          <footer class="legal">
            <span>
              Kingdom ID, by <a href="https://kingdomwebbuilders.com">Kingdom Web Builders</a>
            </span>
            <span class="legal-links">
              <a href="https://kingdomwebbuilders.com/privacy">Privacy</a>
              <a href="https://kingdomwebbuilders.com/terms">Terms</a>
            </span>
          </footer>
        </main>
      </div>
    </Document>
  );
}

/** Kingdom ID's value, in four lines. Shown in the story panel, or below the card on small screens. */
function StoryPoints({ ui, variant = "panel" }: { ui: Ui; variant?: "panel" | "stacked" }) {
  return (
    <ul class={`story-points story-points-${variant}`}>
      <li>
        <Icon name="key" />
        <span>
          <strong>Passkeys, not passwords.</strong> Sign in with your face, fingerprint or device PIN. Nothing to
          phish, nothing to forget.
        </span>
      </li>
      <li>
        <Icon name="eye" />
        <span>
          <strong>You decide what each app sees.</strong> Apps ask, you approve, and each one gets its own ID for
          you.
        </span>
      </li>
      {ui.relay ? (
        <li>
          <Icon name="mail" />
          <span>
            <strong>A private email for every app.</strong> Mail reaches you; your real address never leaves
            Kingdom.
          </span>
        </li>
      ) : null}
      <li>
        <Icon name="crown" />
        <span>
          <strong>One account, every perk.</strong> What you unlock in one Kingdom app follows you to the next.
        </span>
      </li>
    </ul>
  );
}

/** Kingdom mark beside the requesting app's identity: who's asking, and through whom. */
export function CoBrand({ app }: { app?: AppIdentity | undefined }) {
  if (!app) {
    return (
      <div class="cobrand">
        <span class="cobrand-mark">
          <img src="/brand/kingdom-mark-white.png" alt="" width="44" height="24" />
        </span>
        <span class="cobrand-name">Kingdom ID</span>
      </div>
    );
  }
  return (
    <div class="cobrand">
      <span class="cobrand-mark" title="Kingdom ID">
        <img src="/brand/kingdom-mark-white.png" alt="Kingdom ID" width="44" height="24" />
      </span>
      <span class="cobrand-link" aria-hidden="true">
        <Icon name="link" />
      </span>
      {app.logoUri ? (
        <img class="cobrand-app" src={app.logoUri} alt="" width="40" height="40" />
      ) : (
        <span class="cobrand-app cobrand-initial" aria-hidden="true">
          {app.name.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span class="cobrand-name">{app.name}</span>
    </div>
  );
}

export function FieldError({ id, message }: { id: string; message: string | undefined }) {
  return (
    <p class="field-error" id={id} hidden={!message}>
      {message ?? ""}
    </p>
  );
}

export function sendPage(reply: FastifyReply, page: preact.VNode, status = 200) {
  return reply
    .status(status)
    .header("content-type", "text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .send(`<!doctype html>${renderToString(page)}`);
}
